// api/game_claim.js
// POST /api/game_claim
//
// Related "credit/spend something for this user" actions share this one
// file on purpose — Vercel's Hobby plan caps a project at 12 Serverless
// Functions.
//
// action: 'claim_gift' -> claims an admin-sent gift (from the bot's
//   "Send Gift" flow). Body: { action: 'claim_gift', giftId }
//   Atomic: the filter requires status:'pending', so a double-tap or two
//   overlapping requests can only ever credit the user once.
//
// action: 'buy_shop_item' -> spends Fruit Coin on a Game Token bundle.
// action: 'freebox_ad_session' / 'claim_freebox' -> the 24h Free Box flow.
//
// NOTE: the old Level/Stage system (start_game / level-complete claim)
// lived here before — removed along with the fruit-slicing game itself.
// It's gone from index.html, so these actions are no longer reachable;
// removing the handlers too so there's no dead code claiming Fruit Coin for a
// "level" that no longer exists anywhere in the app.

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { TRANSACTION_TYPES } = require('../lib/constants');
const { MAX_TOKENS } = require('../lib/tokens');
const { createAdSession, claimAdSession, revertAdSession } = require('../lib/adSession');
const { ObjectId } = require('mongodb');

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
    user: { fruitCoin: updatedUser.fruitCoin },
  });
}

// ── Shop — Fruit Coin item catalog (server-only; never trust a price
// or item id sent from the client — same rule as everywhere else in
// this project). Keys are what the frontend sends as `itemId`.
const SHOP_ITEMS = {
  token_1:     { cost: 120,  type: 'token',    amount: 1,  label: '1 🎮 Game Token' },
  token_2:     { cost: 200,  type: 'token',    amount: 2,  label: '2 🎮 Game Token' },
  token_5:     { cost: 450,  type: 'token',    amount: 5,  label: '5 🎮 Game Token' },
};

async function handleBuyShopItem(req, res, user) {
  const { itemId } = req.body || {};
  const item = SHOP_ITEMS[itemId];
  if (!item) return res.status(400).json({ success: false, error: 'invalid_item' });

  const usersCol = await getCollection('users');

  // Clamp to MAX_TOKENS — buying a bundle while already near/at the cap
  // can't push you over it.
  const updated = await usersCol.findOneAndUpdate(
    { _id: user._id, fruitCoin: { $gte: item.cost } },
    [{ $set: {
        fruitCoin: { $subtract: ['$fruitCoin', item.cost] },
        gameTokens: { $min: [{ $add: [{ $ifNull: ['$gameTokens', 3] }, item.amount] }, MAX_TOKENS] },
    } }],
    { returnDocument: 'after' }
  );

  if (!updated) return res.status(200).json({ success: false, error: 'not_enough_fruitcoin' });

  const txCol = await getCollection('transactions');
  await txCol.insertOne({
    telegramId: user.telegramId,
    type: TRANSACTION_TYPES.SHOP_PURCHASE,
    amount: -item.cost,
    balanceAfter: updated.fruitCoin,
    meta: { itemId, itemType: item.type, itemAmount: item.amount },
    createdAt: new Date(),
  });

  return res.status(200).json({
    success: true,
    label: item.label,
    user: { fruitCoin: updated.fruitCoin, gameTokens: updated.gameTokens },
  });
}

const FREEBOX_COOLDOWN_MS = 24 * 60 * 60 * 1000; // rolling 24h from last claim
const FREEBOX_MIN = 100;
const FREEBOX_MAX = 500;
const FREEBOX_AD_NETWORK = 'freebox'; // synthetic network tag — kept separate
// from 'adsgram'/'adsgramDaily'/'gigapub'/'monetag' on purpose, so watching
// an ad to unlock the free box never eats into the daily watch caps shown
// on the "5/5 remaining" / "10/10 remaining" ad-for-FC buttons in Shop.

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
    { $inc: { fruitCoin: reward }, $set: { lastFreeBoxAt: now } },
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
    balanceAfter: updated.fruitCoin,
    createdAt: now,
  });

  return res.status(200).json({
    success: true,
    reward,
    nextAt: new Date(now.getTime() + FREEBOX_COOLDOWN_MS),
    user: { fruitCoin: updated.fruitCoin },
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
    if (action === 'buy_shop_item') return await handleBuyShopItem(req, res, user);
    if (action === 'claim_freebox') return await handleClaimFreebox(req, res, user);
    if (action === 'freebox_ad_session') return await handleFreeboxAdSession(req, res, user);
    return res.status(400).json({ success: false, error: 'invalid_action' });
  } catch (err) {
    console.error('game_claim error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};
