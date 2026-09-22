// lib/dailyLimit.js
// Generic server-side daily counter — keyed by telegramId + source + UTC day.
// Used by lib/adReward.js (and anything else that needs a per-day cap that
// can't be bypassed by editing client-side counters in devtools/termux).
//
// Atomic: uses findOneAndUpdate with a { count: { $lt: maxPerDay } } filter,
// so two near-simultaneous requests can't both slip through past the cap
// (same pattern already used in lib/adSession.js and api/convert.js).
//
// Cleanup: every doc carries its own `expireAt`, and lib/db.js has a single
// TTL index on that field (daily docs +3 days, weekly docs +10 days) so old
// counters self-delete instead of piling up on a free-tier Mongo cluster.

const { getCollection } = require('./db');

const DAILY_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;   // 3 days
const WEEKLY_RETENTION_MS = 10 * 24 * 60 * 60 * 1000; // 10 days (a week + buffer)

async function checkAndIncrementDailyLimit(telegramId, source, maxPerDay) {
  const col = await getCollection('dailyLimits');
  const dayKey = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const _id = `${telegramId}_${source}_${dayKey}`;

  const existing = await col.findOne({ _id });
  const currentCount = existing ? existing.count : 0;

  if (currentCount >= maxPerDay) {
    return { allowed: false, count: currentCount };
  }

  // Driver v6: findOneAndUpdate returns the document directly, not { value }
  const result = await col.findOneAndUpdate(
    { _id, count: { $lt: maxPerDay } },
    {
      $inc: { count: 1 },
      $set: { telegramId, source, dayKey, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date(), expireAt: new Date(Date.now() + DAILY_RETENTION_MS) },
    },
    { upsert: true, returnDocument: 'after' }
  );

  if (!result) {
    // A concurrent request pushed the count to the cap first.
    return { allowed: false, count: maxPerDay };
  }

  return { allowed: true, count: result.count };
}

// Same idea as checkAndIncrementDailyLimit but keyed by ISO week (Monday
// 00:00 UTC start — same boundary lib/leaderboard.js uses for the weekly
// leaderboard) instead of by day. Used for weekly caps like the 366/week
// slash-game ceiling.
function getWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return d.toISOString().slice(0, 10);
}

async function checkAndIncrementWeeklyLimit(telegramId, source, maxPerWeek) {
  const col = await getCollection('dailyLimits');
  const weekKey = getWeekKey();
  const _id = `${telegramId}_${source}_w_${weekKey}`;

  const existing = await col.findOne({ _id });
  const currentCount = existing ? existing.count : 0;

  if (currentCount >= maxPerWeek) {
    return { allowed: false, count: currentCount };
  }

  const result = await col.findOneAndUpdate(
    { _id, count: { $lt: maxPerWeek } },
    {
      $inc: { count: 1 },
      $set: { telegramId, source, weekKey, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date(), expireAt: new Date(Date.now() + WEEKLY_RETENTION_MS) },
    },
    { upsert: true, returnDocument: 'after' }
  );

  if (!result) {
    return { allowed: false, count: maxPerWeek };
  }

  return { allowed: true, count: result.count };
}

module.exports = { checkAndIncrementDailyLimit, checkAndIncrementWeeklyLimit };
