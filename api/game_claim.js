// api/game_claim.js
// POST /api/game_claim
// Handles gift claims, Daily Gift Box / Treasure Box (20-100 FC + 10 XP),
// and the Weekly Competition leaderboard (Slash + Refer tabs — see
// handleWeeklyLeaderboard below).

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { rateGuard } = require('../lib/rateLimit');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { TRANSACTION_TYPES, LEADERBOARD_WEEKLY_REWARDS, LEADERBOARD_MIN_WINS_FOR_PRIZE, REFERRAL_WEEKLY_REWARDS, REFERRAL_MIN_FOR_PRIZE } = require('../lib/constants');
const { getWeekKey, getTopSlashers, getWeeklyWins, getUserRank } = require('../lib/leaderboard');
const { getTopReferrers, getWeeklyReferrals, getUserReferralRank } = require('../lib/referralLeaderboard');
const { getRecentWinners } = require('../lib/recentWinners');
const { getLevelForXp, getLevelProgress, LEVELS } = require('../lib/levelSystem');
const { ObjectId } = require('mongodb');

const DAILY_GIFT_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours (user spec: every 12hr)

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
    type: gift.kind === 'slash_prize' ? TRANSACTION_TYPES.LEADERBOARD_REWARD
      : gift.kind === 'refer_prize' ? TRANSACTION_TYPES.REFERRAL_LEADERBOARD_REWARD
      : TRANSACTION_TYPES.GIFT_REWARD,
    amount: gift.amount,
    balanceAfter: updatedUser.fruitCoin,
    meta: { giftId: String(gift._id), reason: gift.reason },
    createdAt: new Date(),
  });

  // If more gifts are waiting (e.g. both contests won in the same week), show the next popup right away.
  const nextG = await giftsCol.findOne({ telegramId: user.telegramId, status: 'pending' }, { sort: { createdAt: 1 } });

  return res.status(200).json({
    success: true,
    amount: gift.amount,
    reason: gift.reason,
    user: { fruitCoin: updatedUser.fruitCoin },
    nextGift: nextG ? { id: nextG._id, amount: nextG.amount, reason: nextG.reason, title: nextG.title || null, icon: nextG.icon || null } : null,
  });
}

// ── Daily Gift Box ("Treasure Box"): random FC + fixed XP once per 12h ──
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

// XP granted per Treasure Box open (per Rasedul's update spec).
const TREASURE_BOX_XP_REWARD = 10;

async function handleClaimDailyGift(req, res, user) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - DAILY_GIFT_COOLDOWN_MS);

  // Server-side random reward: 20 to 100 FC (updated per Rasedul's spec —
  // was 20-30 FC, which had gotten too low relative to slash/task rewards).
  const baseReward = Math.floor(Math.random() * (100 - 20 + 1)) + 20;

  // Level-up bonus on the XP this box grants — same pattern as
  // api/slash.js and api/verify_task.js, so a Treasure Box open that
  // happens to cross a level threshold pays out that level's milestone
  // FC too, instead of being the one reward source that doesn't.
  const oldXp = user.xp || 0;
  const newXp = oldXp + TREASURE_BOX_XP_REWARD;
  const oldLevel = getLevelForXp(oldXp);
  const newLevel = getLevelForXp(newXp);

  let levelReward = 0;
  let isLevelUp = false;
  if (newLevel > oldLevel) {
    isLevelUp = true;
    const targetLevelConfig = LEVELS.find((l) => l.level === newLevel);
    if (targetLevelConfig) levelReward = targetLevelConfig.rewardFc || 0;
  }

  const reward = baseReward + levelReward;

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
      $inc: { fruitCoin: reward, xp: TREASURE_BOX_XP_REWARD },
      $set: { level: newLevel, lastDailyGiftAt: now, lastActive: now },
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
      message: 'Treasure box is on 12-hour cooldown! Available soon.',
      nextDailyGiftAt,
    });
  }

  const txCol = await getCollection('transactions');
  await txCol.insertOne({
    telegramId: user.telegramId,
    type: 'daily_gift_reward',
    amount: reward,
    balanceAfter: updatedUser.fruitCoin,
    meta: { baseReward, levelReward, isLevelUp, level: newLevel, xpGained: TREASURE_BOX_XP_REWARD },
    createdAt: now,
  });

  const updatedProgress = getLevelProgress(updatedUser.xp || newXp);

  return res.status(200).json({
    success: true,
    reward,
    levelReward,
    isLevelUp,
    newLevel,
    nextDailyGiftAt: new Date(now.getTime() + DAILY_GIFT_COOLDOWN_MS),
    user: {
      fruitCoin: updatedUser.fruitCoin,
      xp: updatedUser.xp,
      level: updatedProgress.level,
      levelProgress: updatedProgress,
    },
  });
}

// ── Weekly Competition (Slash + Refer tabs) ─────────────────────────
// Backs the "Weekly Competition" leaderboard modal: two tabs sharing one
// call — Top Slasher (lib/leaderboard.js, 50+ wins gate, 30,000 FC pool,
// top 20) and Top Referrer (lib/referralLeaderboard.js, 20-referral gate,
// 50,000 FC pool, top 15). Both reset every Monday 00:00 UTC and are paid
// out by the same cron (api/cron_weekly_leaderboard.js).
async function attachProfiles(entries, usersCol) {
  if (entries.length === 0) return [];
  const ids = entries.map((e) => e.telegramId);
  const profiles = await usersCol
    .find({ telegramId: { $in: ids } }, { projection: { telegramId: 1, photoUrl: 1, level: 1 } })
    .toArray();
  const byId = new Map(profiles.map((p) => [String(p.telegramId), p]));
  // NOTE: no per-user Telegram photo lookups here any more — they made the leaderboard slow
  // (2 network calls per row) and their URLs contained the bot token. Rows without a saved
  // photo simply show the first letter of the name.
  return entries.map((e) => {
    const profile = byId.get(String(e.telegramId));
    return { entry: e, photoUrl: profile && profile.photoUrl ? profile.photoUrl : null, level: profile ? profile.level || 1 : 1 };
  });
}

// The top lists are the same for everybody, so they are cached for a short time (per server instance).
// Only "me" / "isCurrentUser" is computed per request.
const LB_CACHE_MS = 30 * 1000;
let lbCache = { weekKey: null, at: 0, data: null };

async function getSharedLeaderboard(weekKey) {
  if (lbCache.data && lbCache.weekKey === weekKey && Date.now() - lbCache.at < LB_CACHE_MS) return lbCache.data;
  const usersCol = await getCollection('users');
  const [slashTop, referTop, recentWinners] = await Promise.all([
    getTopSlashers(weekKey, LEADERBOARD_WEEKLY_REWARDS.length),
    getTopReferrers(weekKey, REFERRAL_WEEKLY_REWARDS.length),
    getRecentWinners(20),
  ]);
  const [slashWithProfiles, referWithProfiles] = await Promise.all([
    attachProfiles(slashTop, usersCol),
    attachProfiles(referTop, usersCol),
  ]);
  const data = { slashWithProfiles, referWithProfiles, recentWinners };
  lbCache = { weekKey, at: Date.now(), data };
  return data;
}

async function handleWeeklyLeaderboard(req, res, user) {
  const weekKey = getWeekKey();
  const myId = String(user.telegramId);

  const [shared, myWins, myReferrals, mySlashRank, myReferralRank] = await Promise.all([
    getSharedLeaderboard(weekKey),
    getWeeklyWins(myId, weekKey),
    getWeeklyReferrals(myId, weekKey),
    getUserRank(myId, weekKey),
    getUserReferralRank(myId, weekKey),
  ]);
  const { slashWithProfiles, referWithProfiles, recentWinners } = shared;

  const slashList = slashWithProfiles.map(({ entry, photoUrl, level }, index) => ({
    rank: index + 1,
    username: entry.username || 'Player',
    photoUrl,
    level,
    wins: entry.wins || 0,
    prizeFc: LEADERBOARD_WEEKLY_REWARDS[index] || 0,
    eligible: (entry.wins || 0) >= LEADERBOARD_MIN_WINS_FOR_PRIZE,
    isCurrentUser: entry.telegramId === myId,
  }));

  const referList = referWithProfiles.map(({ entry, photoUrl, level }, index) => ({
    rank: index + 1,
    username: entry.username || 'Player',
    photoUrl,
    level,
    referrals: entry.referrals || 0,
    prizeFc: REFERRAL_WEEKLY_REWARDS[index] || 0,
    eligible: (entry.referrals || 0) >= REFERRAL_MIN_FOR_PRIZE,
    isCurrentUser: entry.telegramId === myId,
  }));

  return res.status(200).json({
    success: true,
    weekKey,
    slash: {
      list: slashList,
      poolFc: LEADERBOARD_WEEKLY_REWARDS.reduce((a, b) => a + b, 0),
      minWinsForPrize: LEADERBOARD_MIN_WINS_FOR_PRIZE,
      me: { wins: myWins, rank: mySlashRank },
    },
    refer: {
      list: referList,
      poolFc: REFERRAL_WEEKLY_REWARDS.reduce((a, b) => a + b, 0),
      minReferralsForPrize: REFERRAL_MIN_FOR_PRIZE,
      me: { referrals: myReferrals, rank: myReferralRank },
    },
    recentWinners: recentWinners.map((w) => ({
      username: w.username,
      type: w.type,
      rank: w.rank,
      prize: w.prize,
      wonAt: w.wonAt,
    })),
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const initData = req.headers['x-telegram-init-data'] || '';
    const verify = verifyTelegramInitData(initData, process.env.BOT_TOKEN);
    if (await rateGuard(req, res, verify, 'game_claim')) return; // flood protection (lib/rateLimit.js)
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
    if (action === 'weekly_leaderboard') return await handleWeeklyLeaderboard(req, res, user);

    return res.status(400).json({ success: false, error: 'invalid_action' });
  } catch (err) {
    console.error('game_claim error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};
