// api/game_claim.js
// POST /api/game_claim
//
// Two actions live in this one file on purpose — Vercel's Hobby plan
// caps a project at 12 Serverless Functions, and this project is
// already at exactly 12 without this endpoint even existing yet, so a
// separate api/gift_claim.js would have pushed it to 13 and broken
// deployment. Both actions are "credit a reward to this user," so they
// share a file instead.
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
//
// action: 'claim_gift' -> claims an admin-sent gift (from the bot's
//   "Send Gift" flow). Body: { action: 'claim_gift', giftId }
//   Atomic: the filter requires status:'pending', so a double-tap or two
//   overlapping requests can only ever credit the user once.

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { TRANSACTION_TYPES } = require('../lib/constants');
const { ObjectId } = require('mongodb');

const REWARD_MIN = 40;
const REWARD_MAX = 120; // inclusive, matches index.html's `40 + rand(0..80)`

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

  const updated = await usersCol.findOneAndUpdate(
    { _id: user._id },
    { $inc: { gold: reward, totalGamesPlayed: 1 }, $set: { lastActive: new Date() } },
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
    user: { gold: updated.gold, fruitCoin: updated.fruitCoin },
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

    if (req.body && req.body.action === 'claim_gift') {
      return await handleClaimGift(req, res, user);
    }
    return await handleLevelClaim(req, res, user);
  } catch (err) {
    console.error('game_claim error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};
