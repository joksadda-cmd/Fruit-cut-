// api/game_claim.js
// POST /api/game_claim
// Handles gift claims, Daily Gift Box (10-40 FC), and Leaderboard ranking.

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { TRANSACTION_TYPES } = require('../lib/constants');
const { ObjectId } = require('mongodb');

const DAILY_GIFT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Admin-sent gift claim ──────────────────────────────────────────
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
    user: { fruitCoin: updatedUser.fruitCoin, gold: updatedUser.gold },
  });
}

// ── Daily Gift Box: 10 to 40 FC randomly once per 24 hours ────────
async function handleDailyGiftStatus(req, res, user) {
  const now = Date.now();
  const lastTime = user.lastDailyGiftAt ? new Date(user.lastDailyGiftAt).getTime() : 0;
  const elapsed = now - lastTime;
  const onCooldown = elapsed < DAILY_GIFT_COOLDOWN_MS;
  const nextDailyGiftAt = new Date(lastTime + DAILY_GIFT_COOLDOWN_MS);

  return res.status(200).json({
    success: true,
    onCooldown,
    nextDailyGiftAt,
    remainingMs: Math.max(0, DAILY_GIFT_COOLDOWN_MS - elapsed),
  });
}

async function handleClaimDailyGift(req, res, user) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - DAILY_GIFT_COOLDOWN_MS);

  // Server-side random reward: 10 to 40 FC
  const reward = Math.floor(Math.random() * (40 - 10 + 1)) + 10;

  const usersCol = await getCollection('users');
  const updatedUser = await usersCol.findOneAndUpdate(
    {
      _id: user._id,
      $or: [
        { lastDailyGiftAt: { $exists: false } },
        { lastDailyGiftAt: null },
        { lastDailyGiftAt: { $lt: cutoff } },
      ],
    },
    {
      $inc: { fruitCoin: reward },
      $set: { lastDailyGiftAt: now, lastActive: now },
    },
    { returnDocument: 'after' }
  );

  if (!updatedUser) {
    const nextDailyGiftAt = user.lastDailyGiftAt
      ? new Date(new Date(user.lastDailyGiftAt).getTime() + DAILY_GIFT_COOLDOWN_MS)
      : new Date(now.getTime() + DAILY_GIFT_COOLDOWN_MS);
    return res.status(200).json({
      success: false,
      error: 'gift_on_cooldown',
      message: 'Daily gift already claimed today! Come back tomorrow.',
      nextDailyGiftAt,
    });
  }

  const txCol = await getCollection('transactions');
  await txCol.insertOne({
    telegramId: user.telegramId,
    type: 'daily_gift_reward',
    amount: reward,
    balanceAfter: updatedUser.fruitCoin,
    createdAt: now,
  });

  return res.status(200).json({
    success: true,
    reward,
    nextDailyGiftAt: new Date(now.getTime() + DAILY_GIFT_COOLDOWN_MS),
    user: { fruitCoin: updatedUser.fruitCoin },
  });
}

// ── Top 20 Leaderboard ─────────────────────────────────────────────
async function handleLeaderboard(req, res, user) {
  const usersCol = await getCollection('users');
  const topUsers = await usersCol
    .find({ banned: { $ne: true } })
    .sort({ fruitCoin: -1 })
    .limit(20)
    .project({
      username: 1,
      telegramId: 1,
      photoUrl: 1,
      fruitCoin: 1,
      level: 1,
      totalSlices: 1,
    })
    .toArray();

  const formatted = topUsers.map((u, index) => {
    const rawId = String(u.telegramId || '');
    const maskedId = rawId.length > 5 ? rawId.slice(0, 3) + '***' + rawId.slice(-2) : rawId;
    return {
      rank: index + 1,
      username: u.username || `Player_${maskedId}`,
      maskedId,
      photoUrl: u.photoUrl || null,
      fruitCoin: u.fruitCoin || 0,
      level: u.level || 1,
      totalSlices: u.totalSlices || 0,
      isCurrentUser: String(u.telegramId) === String(user.telegramId),
    };
  });

  return res.status(200).json({
    success: true,
    leaderboard: formatted,
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
    if (action === 'daily_gift_status') return await handleDailyGiftStatus(req, res, user);
    if (action === 'claim_daily_gift') return await handleClaimDailyGift(req, res, user);
    if (action === 'leaderboard') return await handleLeaderboard(req, res, user);

    return res.status(400).json({ success: false, error: 'invalid_action' });
  } catch (err) {
    console.error('game_claim error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};
