// api/game_claim.js
// POST /api/game_claim
//
// Three actions live in this one file on purpose — Vercel's Hobby plan
// caps a project at 12 Serverless Functions, so closely-related "credit/
// spend something for this user" actions share a file instead of each
// getting their own.
//
// action: 'start_game' -> spends 1 Game Token to start a level. Body:
//   { action: 'start_game' }
//   THIS FIXES THE "tokens reset to 10 on app reopen" BUG: token
//   deduction used to be entirely client-side (`window.G.tokens--`, with
//   a comment claiming "game_claim handles server deduction" — it never
//   did). The database value was never touched, so reopening the app
//   just showed the untouched DB value, which looked like a reset.
//   Deduction is now atomic here and is the only source of truth.
//
// action omitted/'level' (default) -> level-complete claim (Next Level /
//   2X Reward / Skip Stage buttons). Body: { isAdWatched, skip }
//   This endpoint DID NOT EXIST before at all — index.html was calling a
//   URL with no matching backend file, so every one of those buttons was
//   silently failing (very likely the cause of the "❌ Error Saving Data!
//   Network Error" toast seen in testing).
//   SECURITY NOTE: the client also sends a `reward` number (left over
//   from the old dead call) — deliberately IGNORED. The gold amount is
//   always computed here, server-side, in the same 40–120 range the
//   frontend uses for display, so a devtools/termux user editing the
//   request body can never claim more gold than a real playthrough allows.
//   ALSO FIXES: stage was tracked only in a client JS variable that was
//   never incremented anywhere in the whole codebase and never saved —
//   every player was permanently "stuck" on stage 1 no matter how many
//   levels they finished. Stage now lives on the user document and
//   advances by 1 on every level-complete/skip, forever, and survives
//   app restarts since it's read back from the server on load.
//
// action: 'claim_gift' -> claims an admin-sent gift (from the bot's
//   "Send Gift" flow). Body: { action: 'claim_gift', giftId }
//   Atomic: the filter requires status:'pending', so a double-tap or two
//   overlapping requests can only ever credit the user once.

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { TRANSACTION_TYPES } = require('../lib/constants');
const { applyRegen, REGEN_INTERVAL_MS, MAX_TOKENS } = require('../lib/tokens');
const { createAdSession, claimAdSession, revertAdSession } = require('../lib/adSession');
const { ObjectId } = require('mongodb');

const REWARD_MIN = 40;
const REWARD_MAX = 120; // inclusive, matches index.html's `40 + rand(0..80)`

async function handleStartGame(req, res, user) {
  const usersCol = await getCollection('users');

  // Credit any tokens the player earned while away BEFORE checking
  // availability, so someone who's been offline a while isn't wrongly
  // blocked right as a token should have refilled.
  const regen = await applyRegen(usersCol, user);
  if (regen.gameTokens <= 0) {
    return res.status(200).json({ success: false, error: 'no_tokens', tokens: regen.gameTokens });
  }

  // Atomic decrement — filter re-checks gameTokens > 0 so a double-tap
  // or a forced duplicate request can never take a player below 0.
  //
  // lastTokenRegenAt is reset to right now on every spend, on purpose:
  // the countdown to the NEXT token should always read a fresh ~6h
  // immediately after you use one, not "however much was left on the
  // old shared clock" (which is what made it show e.g. 1h42m instead of
  // 5h59m — the countdown wasn't tied to spending at all before this).
  const now = new Date();
  const updated = await usersCol.findOneAndUpdate(
    { _id: user._id, gameTokens: { $gt: 0 } },
    { $inc: { gameTokens: -1 }, $set: { lastActive: now, lastTokenRegenAt: now } },
    { returnDocument: 'after' }
  );
  if (!updated) {
    return res.status(200).json({ success: false, error: 'no_tokens', tokens: 0 });
  }

  return res.status(200).json({
    success: true,
    tokens: updated.gameTokens,
    stage: updated.stage ?? 1,
    nextTokenAt: new Date(now.getTime() + REGEN_INTERVAL_MS),
  });
}

async function handleClaimGift(req, res, user) {
  const { giftId } = req.body || {};
  if (!giftId) return res.status(400).json({ success: false, error: 'missing_gift_id' });

  const giftsCol = await getCollection('gifts');
  let objId;
  try { objId = new ObjectId(giftId); } catch { return res.status(400).json({ success: false, error: 'bad_gift_id' }); }

  const gift = await giftsCol.findOneAndUpdate(
    { _id: objId, telegramId: user.telegramId, status: 'pending' },
    { $set: { status: 'claimed', claimedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!gift) return res.status(400).json({ success: false, error: 'already_claimed_or_not_found' });

  const usersCol = await getCollection('users');
  const updatedUser = await usersCol.findOneAndUpdate(
    { _id: user._id },
    { $inc: { fruitCoin: gift.amount } },
    { returnDocument: 'after' }
  );

  const txCol = await getCollection('transactions');
  await txCol.insertOne({
    telegramId: user.telegramId,
    type: TRANSACTION_TYPES.GIFT_REWARD,
    amount: gift.amount,
    balanceAfter: updatedUser.fruitCoin,
    meta: { giftId: String(gift._id), reason: gift.reason },
    createdAt: new Date(),
  });

  return res.status(200).json({
    success: true,
    amount: gift.amount,
    reason: gift.reason,
    user: { gold: updatedUser.gold, fruitCoin: updatedUser.fruitCoin },
  });
}

async function handleLevelClaim(req, res, user) {
  const { isAdWatched, skip } = req.body || {};

  const usersCol = await getCollection('users');

  // Skip-stage: no gold, just bookkeeping (games-played counter still
  // ticks so referral "valid refer" progress etc. stay meaningful).
  let reward = 0;
  if (!skip) {
    reward = REWARD_MIN + Math.floor(Math.random() * (REWARD_MAX - REWARD_MIN + 1));
    if (isAdWatched === true) reward *= 2;
  }

  // Stage advances by 1 every time, forever — this is now the ONLY place
  // stage changes, and it's persisted, so "new stage every day you play"
  // just falls out naturally from playing more levels over time.
  const updated = await usersCol.findOneAndUpdate(
    { _id: user._id },
    { $inc: { gold: reward, totalGamesPlayed: 1, stage: 1 }, $set: { lastActive: new Date() } },
    { returnDocument: 'after' }
  );

  if (reward > 0) {
    const txCol = await getCollection('transactions');
    await txCol.insertOne({
      telegramId: user.telegramId,
      type: TRANSACTION_TYPES.GAME_REWARD,
      amount: reward,
      balanceAfter: updated.gold,
      meta: { isAdWatched: !!isAdWatched, skip: !!skip },
      createdAt: new Date(),
    });
  }

  return res.status(200).json({
    success: true,
    reward,
    stage: updated.stage ?? 1,
    user: { gold: updated.gold, fruitCoin: updated.fruitCoin },
  });
}

// ── Shop — 6-slot Gold item catalog (server-only; never trust a price
// or item id sent from the client — same rule as everywhere else in
// this project). Keys are what the frontend sends as `itemId`.
const SHOP_ITEMS = {
  token_1:     { cost: 120,  type: 'token',    amount: 1,  label: '1 🎮 Game Token' },
  token_2:     { cost: 200,  type: 'token',    amount: 2,  label: '2 🎮 Game Token' },
  token_5:     { cost: 450,  type: 'token',    amount: 5,  label: '5 🎮 Game Token' },
  lottoken_3:  { cost: 650,  type: 'lottoken', amount: 3,  label: '3 🎫 Lottery Token' },
  lottoken_10: { cost: 2000, type: 'lottoken', amount: 10, label: '10 🎫 Lottery Token' },
};

async function handleBuyShopItem(req, res, user) {
  const { itemId } = req.body || {};
  const item = SHOP_ITEMS[itemId];
  if (!item) return res.status(400).json({ success: false, error: 'invalid_item' });

  const usersCol = await getCollection('users');

  let updated;
  if (item.type === 'token') {
    // Clamp to MAX_TOKENS, same rule as lottery token-prize wins — buying
    // a bundle while already near/at the cap can't push you over it.
    updated = await usersCol.findOneAndUpdate(
      { _id: user._id, gold: { $gte: item.cost } },
      [{ $set: {
          gold: { $subtract: ['$gold', item.cost] },
          gameTokens: { $min: [{ $add: [{ $ifNull: ['$gameTokens', 3] }, item.amount] }, MAX_TOKENS] },
      } }],
      { returnDocument: 'after' }
    );
  } else {
    updated = await usersCol.findOneAndUpdate(
      { _id: user._id, gold: { $gte: item.cost } },
      { $inc: { gold: -item.cost, lotteryTokens: item.amount } },
      { returnDocument: 'after' }
    );
  }

  if (!updated) return res.status(200).json({ success: false, error: 'not_enough_gold' });

  const txCol = await getCollection('transactions');
  await txCol.insertOne({
    telegramId: user.telegramId,
    type: TRANSACTION_TYPES.SHOP_PURCHASE,
    amount: -item.cost,
    balanceAfter: updated.gold,
    meta: { itemId, itemType: item.type, itemAmount: item.amount },
    createdAt: new Date(),
  });

  return res.status(200).json({
    success: true,
    label: item.label,
    user: { gold: updated.gold, gameTokens: updated.gameTokens, lotteryTokens: updated.lotteryTokens },
  });
}

const FREEBOX_COOLDOWN_MS = 24 * 60 * 60 * 1000; // rolling 24h from last claim
const FREEBOX_MIN = 100;
const FREEBOX_MAX = 500;
const FREEBOX_AD_NETWORK = 'freebox'; // synthetic network tag — kept separate
// from 'adsgram'/'adsgramDaily'/'gigapub'/'monetag' on purpose, so watching
// an ad to unlock the free box never eats into the daily watch caps shown
// on the "5/5 remaining" / "10/10 remaining" ad-for-gold buttons in Shop.

async function handleFreeboxAdSession(req, res, user) {
  const sessionId = await createAdSession(user.telegramId, FREEBOX_AD_NETWORK);
  return res.status(200).json({ success: true, sessionId });
}

async function handleClaimFreebox(req, res, user) {
  const { sessionId } = req.body || {};
  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'missing_ad_session' });
  }
  const adClaim = await claimAdSession(user.telegramId, sessionId, FREEBOX_AD_NETWORK);
  if (!adClaim.ok) {
    return res.status(200).json({ success: false, error: 'ad_not_verified', reason: adClaim.reason });
  }

  const usersCol = await getCollection('users');
  const now = new Date();
  const cutoff = new Date(now.getTime() - FREEBOX_COOLDOWN_MS);

  // Atomic: only succeeds if lastFreeBoxAt is missing/null or older than
  // the 24h cutoff. Reward computed here — never trust a client amount.
  const reward = FREEBOX_MIN + Math.floor(Math.random() * (FREEBOX_MAX - FREEBOX_MIN + 1));
  const updated = await usersCol.findOneAndUpdate(
    { _id: user._id, $or: [{ lastFreeBoxAt: { $exists: false } }, { lastFreeBoxAt: null }, { lastFreeBoxAt: { $lt: cutoff } }] },
    { $inc: { gold: reward }, $set: { lastFreeBoxAt: now } },
    { returnDocument: 'after' }
  );

  if (!updated) {
    // Already watched the ad but the box turned out to still be on
    // cooldown (stale client state) — give the session back instead of
    // burning a real ad watch for nothing.
    await revertAdSession(sessionId, user.telegramId);
    const nextAt = user.lastFreeBoxAt ? new Date(new Date(user.lastFreeBoxAt).getTime() + FREEBOX_COOLDOWN_MS) : now;
    return res.status(200).json({ success: false, error: 'freebox_on_cooldown', nextAt });
  }

  const txCol = await getCollection('transactions');
  await txCol.insertOne({
    telegramId: user.telegramId,
    type: TRANSACTION_TYPES.FREEBOX_REWARD,
    amount: reward,
    balanceAfter: updated.gold,
    createdAt: now,
  });

  return res.status(200).json({
    success: true,
    reward,
    nextAt: new Date(now.getTime() + FREEBOX_COOLDOWN_MS),
    user: { gold: updated.gold },
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const initData = req.headers['x-telegram-init-data'] || '';
    const verify = verifyTelegramInitData(initData, process.env.BOT_TOKEN);
    if (!verify.valid) {
      return res.status(401).json({ success: false, error: 'invalid_auth' });
    }
    const telegramId = verify.user.id;

    const usersCol = await getCollection('users');
    const user = await findUserByTelegramId(usersCol, telegramId);
    if (!user) return res.status(404).json({ success: false, error: 'user_not_found' });
    if (user.banned) return res.status(403).json({ success: false, error: 'Account suspended' });

    const action = req.body && req.body.action;
    if (action === 'claim_gift') return await handleClaimGift(req, res, user);
    if (action === 'start_game') return await handleStartGame(req, res, user);
    if (action === 'buy_shop_item') return await handleBuyShopItem(req, res, user);
    if (action === 'claim_freebox') return await handleClaimFreebox(req, res, user);
    if (action === 'freebox_ad_session') return await handleFreeboxAdSession(req, res, user);
    return await handleLevelClaim(req, res, user);
  } catch (err) {
    console.error('game_claim error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};
