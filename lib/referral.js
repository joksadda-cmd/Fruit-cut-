// lib/referral.js
// 4-Step Referral Milestone Reward System:
// Step 1: Friend confirms channel & group join      -> Referrer: 30 FC + 30 XP
// Step 2: Friend completes 10 tasks                 -> Referrer: 80 FC + 5 XP
// Step 3: Friend plays 10 slash games               -> Referrer: 120 FC + 10 XP
// Step 4: Friend reaches Level 3                    -> Referrer: 200 FC + 10 XP
// Total per complete referral: 430 FC + 55 XP
//
// Withdraw Commission:
// When a referred user's withdrawal is APPROVED by admin, their referrer
// gets 10% of the withdrawn FC amount as commission reward.
//
// XP Note: Ads watching gives 0 XP (by design — not included here).
//
// Separately: checkReferralWeeklyValid() below gates whether a referral
// counts toward the WEEKLY "Top Referrer" leaderboard.

const { getCollection, findUserByTelegramId } = require('./db');
const { sendTelegramMessage } = require('./notify');
const { TRANSACTION_TYPES } = require('./constants');
const { recordWeeklyReferral } = require('./referralLeaderboard');

const MINI_APP_URL = 'https://t.me/Fruit_cut_bot/PlayTo_Earn';
const REFERRAL_WEEKLY_VALID_SLASH_COUNT = 5;

// ── Core milestone award helper ──────────────────────────────────────
// Gives FC + XP to referrer and sends a Telegram notification.
async function awardReferralMilestone(referrerId, referredUser, step, rewardFc, xpReward, milestoneText) {
  try {
    const usersCol = await getCollection('users');
    const referrer = await findUserByTelegramId(usersCol, referrerId);
    if (!referrer || referrer.banned) return;

    const updatedReferrer = await usersCol.findOneAndUpdate(
      { _id: referrer._id },
      {
        $inc: {
          fruitCoin: rewardFc || 0,
          referralFruitCoinEarned: rewardFc || 0,
          xp: xpReward || 0,
        },
        $set: { lastActive: new Date() },
      },
      { returnDocument: 'after' }
    );

    const txCol = await getCollection('transactions');
    await txCol.insertOne({
      telegramId: referrer.telegramId,
      type: TRANSACTION_TYPES.REFERRAL_REWARD,
      amount: rewardFc || 0,
      balanceAfter: updatedReferrer ? updatedReferrer.fruitCoin : referrer.fruitCoin,
      meta: {
        step,
        milestone: milestoneText,
        referredTelegramId: referredUser.telegramId,
        xpAwarded: xpReward || 0,
      },
      createdAt: new Date(),
    });

    const friendName = referredUser.username && referredUser.username !== 'Player'
      ? `@${referredUser.username}`
      : 'Your friend';

    const xpLine = xpReward > 0 ? `\n⚡ +${xpReward} XP bonus!` : '';
    const msg =
      `🎉 <b>Referral Reward (Step ${step}/4)!</b>\n\n` +
      `${friendName} ${milestoneText}!\n\n` +
      `🍎 +${rewardFc} Fruit Coin${xpLine}\n\n` +
      `Keep sharing to earn more! 🚀`;

    sendTelegramMessage(referrer.telegramId, msg, {
      reply_markup: { inline_keyboard: [[{ text: '🎮 Open Game', url: MINI_APP_URL }]] },
    }).catch(() => {});
  } catch (err) {
    console.error(`awardReferralMilestone Step ${step} error:`, err);
  }
}

// ── Step 1: Friend joins & verifies channel + community (+30 FC, +30 XP) ──
async function checkReferralStep1(referredUser) {
  try {
    if (!referredUser || !referredUser.referredBy) return;
    if (referredUser.referStep1Given) return;

    const usersCol = await getCollection('users');
    const claimed  = await usersCol.findOneAndUpdate(
      { _id: referredUser._id, referStep1Given: { $ne: true } },
      { $set: { referStep1Given: true } },
      { returnDocument: 'after' }
    );
    if (!claimed) return;

    await awardReferralMilestone(
      referredUser.referredBy,
      referredUser,
      1,
      30,   // FC reward
      30,   // XP reward (full refer = 30 XP)
      'joined the official channel & group'
    );
  } catch (err) {
    console.error('checkReferralStep1 error:', err);
  }
}

// ── Step 2: Friend completes 10 tasks (+80 FC, +5 XP) ────────────────
async function checkReferralStep2(referredUser) {
  try {
    if (!referredUser || !referredUser.referredBy) return;
    if (referredUser.referStep2Given) return;

    const tasksDone = (referredUser.completedTasks || []).length;
    if (tasksDone < 10) return;

    const usersCol = await getCollection('users');
    const claimed  = await usersCol.findOneAndUpdate(
      { _id: referredUser._id, referStep2Given: { $ne: true } },
      { $set: { referStep2Given: true } },
      { returnDocument: 'after' }
    );
    if (!claimed) return;

    await awardReferralMilestone(
      referredUser.referredBy,
      referredUser,
      2,
      80,   // FC reward
      5,    // XP reward
      'completed 10 tasks'
    );
  } catch (err) {
    console.error('checkReferralStep2 error:', err);
  }
}

// ── Step 3: Friend plays 10 slash games (+120 FC, +10 XP) ────────────
async function checkReferralStep3(referredUser) {
  try {
    if (!referredUser || !referredUser.referredBy) return;
    if (referredUser.referStep3Given) return;

    const slices = referredUser.totalSlices || 0;
    if (slices < 10) return;

    const usersCol = await getCollection('users');
    const claimed  = await usersCol.findOneAndUpdate(
      { _id: referredUser._id, referStep3Given: { $ne: true } },
      { $set: { referStep3Given: true } },
      { returnDocument: 'after' }
    );
    if (!claimed) return;

    await awardReferralMilestone(
      referredUser.referredBy,
      referredUser,
      3,
      120,  // FC reward
      10,   // XP reward
      'played 10 slash games'
    );
  } catch (err) {
    console.error('checkReferralStep3 error:', err);
  }
}

// ── Step 4: Friend reaches Level 3 (+200 FC, +10 XP) ─────────────────
async function checkReferralStep4(referredUser, level) {
  try {
    if (!referredUser || !referredUser.referredBy) return;
    if (referredUser.referStep4Given) return;

    const curLevel = level || referredUser.level || 1;
    if (curLevel < 3) return;

    const usersCol = await getCollection('users');
    const claimed  = await usersCol.findOneAndUpdate(
      { _id: referredUser._id, referStep4Given: { $ne: true } },
      { $set: { referStep4Given: true } },
      { returnDocument: 'after' }
    );
    if (!claimed) return;

    await awardReferralMilestone(
      referredUser.referredBy,
      referredUser,
      4,
      200,  // FC reward
      10,   // XP reward
      'reached Level 3 (Juice Maker)'
    );
  } catch (err) {
    console.error('checkReferralStep4 error:', err);
  }
}

// ── Withdraw Commission: 10% of approved withdrawal amount ───────────
// Called from api/bot.js when admin APPROVES a withdrawal.
// Referrer gets 10% of the gross FC amount (before fee) as commission.
// Only fires after APPROVAL — not on submission.
async function grantWithdrawCommission(withdrawnTelegramId, withdrawnAmount) {
  try {
    const usersCol = await getCollection('users');
    const withdrawnUser = await findUserByTelegramId(usersCol, withdrawnTelegramId);
    if (!withdrawnUser || !withdrawnUser.referredBy) return;

    const referrerId = withdrawnUser.referredBy;
    const referrer   = await findUserByTelegramId(usersCol, referrerId);
    if (!referrer || referrer.banned) return;

    const commissionFc = Math.floor(withdrawnAmount * 0.10); // 10%
    if (commissionFc <= 0) return;

    const updatedReferrer = await usersCol.findOneAndUpdate(
      { _id: referrer._id },
      {
        $inc: {
          fruitCoin: commissionFc,
          referralFruitCoinEarned: commissionFc,
          withdrawCommissionEarned: commissionFc,
        },
        $set: { lastActive: new Date() },
      },
      { returnDocument: 'after' }
    );

    const txCol = await getCollection('transactions');
    await txCol.insertOne({
      telegramId: referrer.telegramId,
      type: 'withdraw_commission',
      amount: commissionFc,
      balanceAfter: updatedReferrer ? updatedReferrer.fruitCoin : referrer.fruitCoin,
      meta: {
        referredTelegramId: withdrawnTelegramId,
        withdrawnAmount,
        commissionRate: '10%',
      },
      createdAt: new Date(),
    });

    // Notify referrer
    const friendName = withdrawnUser.username && withdrawnUser.username !== 'Player'
      ? `@${withdrawnUser.username}`
      : 'Your referred friend';

    sendTelegramMessage(
      referrer.telegramId,
      `💸 <b>Referral Withdrawal Commission!</b>\n\n` +
      `${friendName} just received their withdrawal!\n\n` +
      `🍎 You earned <b>+${commissionFc} Fruit Coin</b> (10% commission)\n\n` +
      `Keep referring friends to earn more! 🚀`,
      { reply_markup: { inline_keyboard: [[{ text: '🎮 Open Game', url: MINI_APP_URL }]] } }
    ).catch(() => {});
  } catch (err) {
    console.error('grantWithdrawCommission error:', err);
  }
}

// ── Weekly leaderboard validity helpers ──────────────────────────────
async function grantWeeklyReferralValidity(referredUser) {
  const usersCol = await getCollection('users');
  const claimed  = await usersCol.findOneAndUpdate(
    { _id: referredUser._id, referWeeklyValidGiven: { $ne: true } },
    { $set: { referWeeklyValidGiven: true } },
    { returnDocument: 'after' }
  );
  if (!claimed) return;

  const referrer = await findUserByTelegramId(usersCol, referredUser.referredBy);
  if (!referrer || referrer.banned) return;

  await recordWeeklyReferral(referrer.telegramId, referrer.username);
}

async function checkReferralWeeklyValid(referredUser) {
  try {
    if (!referredUser || !referredUser.referredBy) return;
    if (referredUser.referWeeklyValidGiven) return;

    const slices = referredUser.totalSlices || 0;
    if (slices < REFERRAL_WEEKLY_VALID_SLASH_COUNT) return;

    await grantWeeklyReferralValidity(referredUser);
  } catch (err) {
    console.error('checkReferralWeeklyValid error:', err);
  }
}

async function maybeTriggerValidReferral(referredUser) {
  try {
    if (!referredUser || !referredUser.referredBy) return;
    if (referredUser.referWeeklyValidGiven) return;

    await grantWeeklyReferralValidity(referredUser);
  } catch (err) {
    console.error('maybeTriggerValidReferral error:', err);
  }
}

module.exports = {
  checkReferralStep1,
  checkReferralStep2,
  checkReferralStep3,
  checkReferralStep4,
  grantWithdrawCommission,
  checkReferralWeeklyValid,
  maybeTriggerValidReferral,
};
