// lib/adReward.js
// Shared logic for crediting Gold from a confirmed ad-network postback.
// Used by api/postback.js for ALL networks (adsgram, monetag, gigapub, ...).
//
// Idempotency: every credit needs a unique `eventKey`. If the same eventKey
// arrives twice (network retry, replay attempt), the second call is a no-op.
// This is stored in the `processedAdEvents` collection.

const { getCollection, findUserByTelegramId } = require('./db');
const { TRANSACTION_TYPES } = require('./constants');
const { checkAndIncrementDailyLimit } = require('./dailyLimit');

async function creditGoldForAd(telegramId, amount, source, eventKey, dailyLimitMax) {
  if (!telegramId || !amount || amount <= 0) {
    return { success: false, reason: 'invalid_params' };
  }

  const eventsCol = await getCollection('processedAdEvents');

  // ── Idempotency check ───────────────────────────────────────────
  if (eventKey) {
    const existing = await eventsCol.findOne({ eventKey });
    if (existing) {
      return { success: false, duplicate: true };
    }
    // Insert immediately (before crediting) to close the race window
    // between two near-simultaneous identical postbacks.
    try {
      await eventsCol.insertOne({ eventKey, telegramId, source, amount, createdAt: new Date() });
    } catch (e) {
      // Unique index violation = another request already claimed this eventKey
      return { success: false, duplicate: true };
    }
  }

  // ── Daily limit check (server-authoritative, can't be bypassed from client) ──
  if (dailyLimitMax) {
    const { allowed, count } = await checkAndIncrementDailyLimit(telegramId, source, dailyLimitMax);
    if (!allowed) {
      return { success: false, reason: 'daily_limit_reached', count };
    }
  }

  const usersCol = await getCollection('users');
  const existingUser = await findUserByTelegramId(usersCol, telegramId);

  if (!existingUser) {
    console.error(`[adReward] user_not_found: telegramId=${JSON.stringify(telegramId)} (type=${typeof telegramId}) source=${source}`);
    return { success: false, reason: 'user_not_found' };
  }

  const updateResult = await usersCol.findOneAndUpdate(
    { _id: existingUser._id },
    { $inc: { gold: amount }, $set: { lastActive: new Date() } },
    { returnDocument: 'after' }
  );

  if (!updateResult.value) {
    return { success: false, reason: 'user_not_found' };
  }

  const txCol = await getCollection('transactions');
  await txCol.insertOne({
    telegramId,
    type: TRANSACTION_TYPES.AD_REWARD,
    amount,
    balanceAfter: updateResult.value.gold,
    meta: { source },
    createdAt: new Date(),
  });

  return { success: true, newGold: updateResult.value.gold };
}

module.exports = { creditGoldForAd };
