// lib/adReward.js
// Shared logic for crediting Fruit Coin from a confirmed ad watch.
// Used by api/ads.js for ALL networks (adsgram, monetag, gigapub, ...).
//
// Idempotency: every credit needs a unique `eventKey`. If the same eventKey
// arrives twice (network retry, replay attempt), the second call is a no-op.
// This is stored in the `processedAdEvents` collection.

const { getCollection, findUserByTelegramId } = require('./db');
const { TRANSACTION_TYPES } = require('./constants');
const { checkAndIncrementDailyLimit } = require('./dailyLimit');
const { maybeTriggerValidReferral, checkReferralStep4 } = require('./referral');
const { planXp } = require('./xp');
const { getLevelProgress } = require('./levelSystem');

async function creditAdReward(telegramId, amount, source, eventKey, dailyLimitMax) {
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

  // XP per source (lib/xp.js): Adsgram/GigaPub/Adsgram Task = 2, in-game claim = 1, Monetag = 0.
  // A level-up through this XP also pays the normal level bonus (same as slash / tasks).
  const plan = planXp(existingUser, source);
  const inc = { fruitCoin: amount + plan.levelReward, totalAdsWatched: 1 };
  const set = { lastActive: new Date() };
  if (plan.xpGain > 0) {
    inc.xp = plan.xpGain;
    if (plan.isLevelUp) set.level = plan.newLevel;
  }
  const updatedUser = await usersCol.findOneAndUpdate(
    { _id: existingUser._id },
    { $inc: inc, $set: set },
    { returnDocument: 'after' }
  );

  if (!updatedUser) {
    return { success: false, reason: 'user_not_found' };
  }

  if (plan.isLevelUp && plan.newLevel >= 3) checkReferralStep4(updatedUser, plan.newLevel).catch(() => {});
  maybeTriggerValidReferral(updatedUser); // fire-and-forget, doesn't block the ad-reward response

  const txCol = await getCollection('transactions');
  await txCol.insertOne({
    telegramId,
    type: TRANSACTION_TYPES.AD_REWARD,
    amount,
    currency: 'FC',
    balanceAfter: updatedUser.fruitCoin,
    meta: { source, xpGain: plan.xpGain, levelReward: plan.levelReward, isLevelUp: plan.isLevelUp },
    createdAt: new Date(),
  });

  return {
    success: true,
    newFruitCoin: updatedUser.fruitCoin,
    xpGain: plan.xpGain,
    isLevelUp: plan.isLevelUp,
    newLevel: plan.newLevel,
    levelReward: plan.levelReward,
    xp: updatedUser.xp || 0,
    levelProgress: getLevelProgress(updatedUser.xp || 0),
  };
}

module.exports = { creditAdReward };
