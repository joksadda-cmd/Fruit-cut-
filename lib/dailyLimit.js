// lib/dailyLimit.js
// Generic server-side daily counter — keyed by telegramId + source + UTC day.
// Used by lib/adReward.js (and anything else that needs a per-day cap that
// can't be bypassed by editing client-side counters in devtools/termux).
//
// Atomic: uses findOneAndUpdate with a { count: { $lt: maxPerDay } } filter,
// so two near-simultaneous requests can't both slip through past the cap
// (same pattern already used in lib/adSession.js and api/convert.js).

const { getCollection } = require('./db');

async function checkAndIncrementDailyLimit(telegramId, source, maxPerDay) {
  const col = await getCollection('dailyLimits');
  const dayKey = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const _id = `${telegramId}_${source}_${dayKey}`;

  const existing = await col.findOne({ _id });
  const currentCount = existing ? existing.count : 0;

  if (currentCount >= maxPerDay) {
    return { allowed: false, count: currentCount };
  }

  const result = await col.findOneAndUpdate(
    { _id, count: { $lt: maxPerDay } },
    {
      $inc: { count: 1 },
      $set: { telegramId, source, dayKey, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, returnDocument: 'after' }
  );

  if (!result.value) {
    // A concurrent request pushed the count to the cap first.
    return { allowed: false, count: maxPerDay };
  }

  return { allowed: true, count: result.value.count };
}

module.exports = { checkAndIncrementDailyLimit };
