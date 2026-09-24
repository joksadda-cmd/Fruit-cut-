// lib/referralLeaderboard.js
// Weekly "Top Referrer" competition — separate from the slash-game
// leaderboard (lib/leaderboard.js) and separate from the lifetime
// `referralCount` field on the user doc. This counts ONLY new referrals
// brought in during the current week; it resets to 0 every Monday the same
// way the slash leaderboard does (a fresh weekKey just starts a fresh tally
// — nothing is actively "reset", old weeks simply stop being queried and
// self-delete via TTL).
//
// Payout: top 10 by weekly referrals share a 25,000 FC pool (see
// REFERRAL_WEEKLY_REWARDS in lib/constants.js) — decreasing payout, no
// minimum-referrals eligibility gate.
//
// recordWeeklyReferral() is called from lib/referral.js's checkReferralWeeklyValid()
// — NOT at signup — once the referred friend has played 5 slash games (see
// REFERRAL_WEEKLY_VALID_SLASH_COUNT in lib/referral.js). This stops
// disposable-account farming of the weekly FC pool: a referral only counts
// once the friend has put in real (cooldown-gated, ~2h minimum) activity.
// distributeWeeklyReferralPrizes() is triggered by
// api/cron_weekly_leaderboard.js (see vercel.json `crons`), alongside the
// slash leaderboard payout, and pays out the week that just ended.

const { getCollection, idVariants } = require('./db');
const { TRANSACTION_TYPES, REFERRAL_WEEKLY_REWARDS } = require('./constants');
const { sendTelegramMessage } = require('./notify');

const RETENTION_MS = 21 * 24 * 60 * 60 * 1000; // 21 days — see lib/leaderboard.js for why

// Monday 00:00:00 UTC of the week containing `date` — same boundary as
// lib/leaderboard.js's getWeekKey, so both competitions reset in sync.
function getWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return d.toISOString().slice(0, 10);
}

// Call once per new referral (a fresh user signed up with this user's code).
async function recordWeeklyReferral(telegramId, username) {
  const col = await getCollection('referralLeaderboard');
  const weekKey = getWeekKey();
  await col.updateOne(
    { weekKey, telegramId: String(telegramId) },
    {
      $inc: { referrals: 1 },
      $set: { username: username || 'Player', lastReferralAt: new Date() },
      $setOnInsert: { weekKey, telegramId: String(telegramId), createdAt: new Date(), expireAt: new Date(Date.now() + RETENTION_MS) },
    },
    { upsert: true }
  );
  return weekKey;
}

async function getWeeklyReferrals(telegramId, weekKey = getWeekKey()) {
  const col = await getCollection('referralLeaderboard');
  const doc = await col.findOne({ weekKey, telegramId: String(telegramId) });
  return doc ? doc.referrals || 0 : 0;
}

async function getTopReferrers(weekKey = getWeekKey(), topN = 10) {
  const col = await getCollection('referralLeaderboard');
  return col.find({ weekKey }).sort({ referrals: -1, lastReferralAt: 1 }).limit(topN).toArray();
}

async function getUserReferralRank(telegramId, weekKey = getWeekKey()) {
  const col = await getCollection('referralLeaderboard');
  const me = await col.findOne({ weekKey, telegramId: String(telegramId) });
  if (!me) return null;
  const higherCount = await col.countDocuments({ weekKey, referrals: { $gt: me.referrals } });
  return higherCount + 1;
}

// Pays out the weekly referral prize pool to the top
// REFERRAL_WEEKLY_REWARDS.length referrers. No minimum-referrals gate.
// Idempotent per week via a marker doc, same pattern as
// lib/leaderboard.js's distributeWeeklyPrizes.
async function distributeWeeklyReferralPrizes(weekKey) {
  const col = await getCollection('referralLeaderboard');
  const markerId = `marker_${weekKey}`;

  const claimed = await col.findOneAndUpdate(
    { _id: markerId, distributed: { $ne: true } },
    { $set: { _id: markerId, weekKey, distributed: true, distributedAt: new Date(), expireAt: new Date(Date.now() + RETENTION_MS) } },
    { upsert: true, returnDocument: 'after' }
  );
  if (!claimed) {
    return { alreadyDistributed: true, paid: [] };
  }

  const rewardCount = REFERRAL_WEEKLY_REWARDS.length;
  const top = await getTopReferrers(weekKey, rewardCount);

  const usersCol = await getCollection('users');
  const txCol = await getCollection('transactions');
  const paid = [];

  for (let i = 0; i < top.length; i++) {
    const entry = top[i];
    const prize = REFERRAL_WEEKLY_REWARDS[i] || 0;
    if (prize <= 0) continue;
    if (!entry.referrals || entry.referrals <= 0) continue; // safety: never pay a 0-referral row

    const updated = await usersCol.findOneAndUpdate(
      { telegramId: { $in: idVariants(entry.telegramId) } },
      { $inc: { fruitCoin: prize }, $set: { lastActive: new Date() } },
      { returnDocument: 'after' }
    );
    if (!updated) continue;

    await txCol.insertOne({
      telegramId: entry.telegramId,
      type: TRANSACTION_TYPES.REFERRAL_LEADERBOARD_REWARD,
      amount: prize,
      balanceAfter: updated.fruitCoin,
      meta: { weekKey, rank: i + 1, referrals: entry.referrals },
      createdAt: new Date(),
    });

    sendTelegramMessage(
      entry.telegramId,
      `🏆 <b>Weekly Top Referrer Reward!</b>\n\n` +
        `You finished <b>#${i + 1}</b> this week with ${entry.referrals} new referrals.\n` +
        `🍎 +${prize.toLocaleString()} Fruit Coin added to your balance!\n\n` +
        `The referral leaderboard just reset — invite more friends next week! 👥`
    ).catch(() => {});

    paid.push({ telegramId: entry.telegramId, username: entry.username, rank: i + 1, prize, referrals: entry.referrals });
  }

  return { alreadyDistributed: false, paid };
}

module.exports = {
  getWeekKey,
  recordWeeklyReferral,
  getWeeklyReferrals,
  getTopReferrers,
  getUserReferralRank,
  distributeWeeklyReferralPrizes,
};
