// lib/leaderboard.js
// Weekly "Top Slasher" leaderboard — ranks users by how many rounds of the
// Slash-the-Fruit mini-game they've won this week. Resets automatically
// every Monday 00:00 UTC (there's nothing to "reset" — a new weekKey just
// starts accumulating fresh, old weeks stay in the collection for history).
//
// Also backs the weekly-referral-validity gate (REFERRAL_WEEKLY_VALID_SLASH_COUNT
// in lib/referral.js) — that check reads this same weekly win count.

const { getCollection, idVariants } = require('./db');
const { TRANSACTION_TYPES, LEADERBOARD_WEEKLY_REWARDS, LEADERBOARD_MIN_WINS_FOR_PRIZE } = require('./constants');
const { sendTelegramMessage } = require('./notify');

const RETENTION_MS = 21 * 24 * 60 * 60 * 1000; // 21 days — see lib/db.js ensureTtlIndexes

// Monday 00:00:00 UTC of the week containing `date`, formatted YYYY-MM-DD.
// Used as the weekKey — e.g. '2026-09-14'.
function getWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return d.toISOString().slice(0, 10);
}

// Call once per confirmed slash-game win. Increments this week's tally for
// the user (upserts if it's their first win this week).
async function recordSlashWin(telegramId, username) {
  const col = await getCollection('leaderboard');
  const weekKey = getWeekKey();
  await col.updateOne(
    { weekKey, telegramId: String(telegramId) },
    {
      $inc: { wins: 1 },
      $set: { username: username || 'Player', lastWinAt: new Date() },
      $setOnInsert: { weekKey, telegramId: String(telegramId), createdAt: new Date(), expireAt: new Date(Date.now() + RETENTION_MS) },
    },
    { upsert: true }
  );
  return weekKey;
}

// How many wins this user has logged for the given week (defaults to the
// current week). Returns 0 if they haven't played at all.
async function getWeeklyWins(telegramId, weekKey = getWeekKey()) {
  const col = await getCollection('leaderboard');
  const doc = await col.findOne({ weekKey, telegramId: String(telegramId) });
  return doc ? doc.wins || 0 : 0;
}

// Top N slashers for a week, sorted by wins desc.
async function getTopSlashers(weekKey = getWeekKey(), topN = 10) {
  const col = await getCollection('leaderboard');
  return col.find({ weekKey }).sort({ wins: -1, lastWinAt: 1 }).limit(topN).toArray();
}

// This user's 1-based rank for the week, or null if they have no entry.
async function getUserRank(telegramId, weekKey = getWeekKey()) {
  const col = await getCollection('leaderboard');
  const me = await col.findOne({ weekKey, telegramId: String(telegramId) });
  if (!me) return null;
  const higherCount = await col.countDocuments({ weekKey, wins: { $gt: me.wins } });
  return higherCount + 1;
}

// Pays out the weekly prize pool to the top LEADERBOARD_WEEKLY_REWARDS.length
// slashers, using the fixed FC amount for each rank. Only entries that met
// LEADERBOARD_MIN_WINS_FOR_PRIZE (100 wins) that week actually get paid — a
// user can rank in the top 20 with fewer wins but won't receive a prize.
// Idempotent per week — safe to call more than once (e.g. a retried cron
// hit) because of the `distributed` flag stored on a small marker doc in
// the same collection.
async function distributeWeeklyPrizes(weekKey) {
  const col = await getCollection('leaderboard');
  const markerId = `marker_${weekKey}`;

  const claimed = await col.findOneAndUpdate(
    { _id: markerId, distributed: { $ne: true } },
    { $set: { _id: markerId, weekKey, distributed: true, distributedAt: new Date(), expireAt: new Date(Date.now() + RETENTION_MS) } },
    { upsert: true, returnDocument: 'after' }
  );
  // If another call already distributed this week, claimed.distributed will
  // already have been true BEFORE this call — but upsert with $ne filter
  // means a second call simply won't match an existing distributed:true
  // doc, so findOneAndUpdate returns null for the second call. Handle both
  // driver return shapes defensively.
  if (!claimed) {
    return { alreadyDistributed: true, paid: [] };
  }

  const rewardCount = LEADERBOARD_WEEKLY_REWARDS.length;
  const top = await getTopSlashers(weekKey, rewardCount);
  const usersCol = await getCollection('users');
  const txCol = await getCollection('transactions');
  const paid = [];

  for (let i = 0; i < top.length; i++) {
    const entry = top[i];
    const prize = LEADERBOARD_WEEKLY_REWARDS[i] || 0;
    if (prize <= 0) continue;
    if (!entry.wins || entry.wins < LEADERBOARD_MIN_WINS_FOR_PRIZE) continue; // below the 100-win eligibility gate

    const updated = await usersCol.findOneAndUpdate(
      { telegramId: { $in: idVariants(entry.telegramId) } },
      { $inc: { fruitCoin: prize }, $set: { lastActive: new Date() } },
      { returnDocument: 'after' }
    );
    if (!updated) continue;

    await txCol.insertOne({
      telegramId: entry.telegramId,
      type: TRANSACTION_TYPES.LEADERBOARD_REWARD,
      amount: prize,
      balanceAfter: updated.fruitCoin,
      meta: { weekKey, rank: i + 1, wins: entry.wins },
      createdAt: new Date(),
    });

    sendTelegramMessage(
      entry.telegramId,
      `🏆 <b>Weekly Top Slasher Reward!</b>\n\n` +
        `You finished <b>#${i + 1}</b> this week with ${entry.wins} slash wins.\n` +
        `🍎 +${prize.toLocaleString()} Fruit Coin added to your balance!\n\n` +
        `The leaderboard just reset — good luck next week! 🔪`
    ).catch(() => {});

    paid.push({ telegramId: entry.telegramId, username: entry.username, rank: i + 1, prize });
  }

  return { alreadyDistributed: false, paid };
}

module.exports = {
  getWeekKey,
  recordSlashWin,
  getWeeklyWins,
  getTopSlashers,
  getUserRank,
  distributeWeeklyPrizes,
};
