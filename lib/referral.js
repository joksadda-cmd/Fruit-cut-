// lib/referral.js
// 4-Step Referral Milestone Reward System:
// Step 1: Friend confirms channel & group join -> Referrer gets: 30 FC
// Step 2: Friend completes 10 tasks -> Referrer gets: 80 FC
// Step 3: Friend plays 10 slash games -> Referrer gets: 120 FC
// Step 4: Friend reaches Level 3 -> Referrer gets: 200 FC
// Total per complete referral: 430 FC
//
// Separately: checkReferralWeeklyValid() below gates whether a referral
// counts toward the WEEKLY "Top Referrer" leaderboard (lib/referralLeaderboard.js)
// at all — a fresh signup does NOT count immediately (that would let anyone
// farm the weekly FC prize pool with disposable accounts). A referral only
// becomes "valid" for that leaderboard once the referred friend has played
// REFERRAL_WEEKLY_VALID_SLASH_COUNT slash games (a different, lower bar
// than Step 3's 10 — this only gates leaderboard eligibility, not the 120 FC
// Step 3 reward, which still needs the full 10).

const { getCollection, findUserByTelegramId } = require('./db');
const { sendTelegramMessage } = require('./notify');
const { TRANSACTION_TYPES } = require('./constants');
const { recordWeeklyReferral } = require('./referralLeaderboard');

const MINI_APP_URL = 'https://t.me/Fruit_cut_bot/PlayTo_Earn';
const REFERRAL_WEEKLY_VALID_SLASH_COUNT = 5;

async function awardReferralMilestone(referrerId, referredUser, step, rewardFc, milestoneText) {
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
        },
        $set: {
          lastActive: new Date(),
        },
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
      },
      createdAt: new Date(),
    });

    const friendName = referredUser.username && referredUser.username !== 'Player'
      ? `@${referredUser.username}`
      : 'Your friend';

    const msg = `🎉 <b>Referral Reward (Step ${step}/4)!</b>\n\n` +
      `${friendName} ${milestoneText}!\n\n` +
      `🍎 +${rewardFc} Fruit Coin\n\n` +
      `Keep sharing to earn more! 🚀`;

    sendTelegramMessage(referrer.telegramId, msg, {
      reply_markup: { inline_keyboard: [[{ text: '🎮 Open Game', url: MINI_APP_URL }]] },
    }).catch(() => {});
  } catch (err) {
    console.error(`awardReferralMilestone Step ${step} error:`, err);
  }
}

async function checkReferralStep1(referredUser) {
  try {
    if (!referredUser || !referredUser.referredBy) return;
    if (referredUser.referStep1Given) return;

    const usersCol = await getCollection('users');
    const claimed = await usersCol.findOneAndUpdate(
      { _id: referredUser._id, referStep1Given: { $ne: true } },
      { $set: { referStep1Given: true } },
      { returnDocument: 'after' }
    );
    if (!claimed) return;

    await awardReferralMilestone(
      referredUser.referredBy,
      referredUser,
      1,
      30,
      'joined the official channel & group'
    );
  } catch (err) {
    console.error('checkReferralStep1 error:', err);
  }
}

async function checkReferralStep2(referredUser) {
  try {
    if (!referredUser || !referredUser.referredBy) return;
    if (referredUser.referStep2Given) return;

    const tasksDone = (referredUser.completedTasks || []).length;
    if (tasksDone < 10) return;

    const usersCol = await getCollection('users');
    const claimed = await usersCol.findOneAndUpdate(
      { _id: referredUser._id, referStep2Given: { $ne: true } },
      { $set: { referStep2Given: true } },
      { returnDocument: 'after' }
    );
    if (!claimed) return;

    await awardReferralMilestone(
      referredUser.referredBy,
      referredUser,
      2,
      80,
      'completed 10 tasks'
    );
  } catch (err) {
    console.error('checkReferralStep2 error:', err);
  }
}

async function checkReferralStep3(referredUser) {
  try {
    if (!referredUser || !referredUser.referredBy) return;
    if (referredUser.referStep3Given) return;

    const slices = referredUser.totalSlices || 0;
    if (slices < 10) return;

    const usersCol = await getCollection('users');
    const claimed = await usersCol.findOneAndUpdate(
      { _id: referredUser._id, referStep3Given: { $ne: true } },
      { $set: { referStep3Given: true } },
      { returnDocument: 'after' }
    );
    if (!claimed) return;

    await awardReferralMilestone(
      referredUser.referredBy,
      referredUser,
      3,
      120,
      'played 10 slash games'
    );
  } catch (err) {
    console.error('checkReferralStep3 error:', err);
  }
}

async function checkReferralStep4(referredUser, level) {
  try {
    if (!referredUser || !referredUser.referredBy) return;
    if (referredUser.referStep4Given) return;

    const curLevel = level || referredUser.level || 1;
    if (curLevel < 3) return;

    const usersCol = await getCollection('users');
    const claimed = await usersCol.findOneAndUpdate(
      { _id: referredUser._id, referStep4Given: { $ne: true } },
      { $set: { referStep4Given: true } },
      { returnDocument: 'after' }
    );
    if (!claimed) return;

    await awardReferralMilestone(
      referredUser.referredBy,
      referredUser,
      4,
      200,
      'reached Level 3 (Juice Maker)'
    );
  } catch (err) {
    console.error('checkReferralStep4 error:', err);
  }
}

async function checkReferralWeeklyValid(referredUser) {
  try {
    if (!referredUser || !referredUser.referredBy) return;
    if (referredUser.referWeeklyValidGiven) return;

    const slices = referredUser.totalSlices || 0;
    if (slices < REFERRAL_WEEKLY_VALID_SLASH_COUNT) return;

    const usersCol = await getCollection('users');
    // Atomic one-time flip — never double-counts even under concurrent claims.
    const claimed = await usersCol.findOneAndUpdate(
      { _id: referredUser._id, referWeeklyValidGiven: { $ne: true } },
      { $set: { referWeeklyValidGiven: true } },
      { returnDocument: 'after' }
    );
    if (!claimed) return;

    const referrer = await findUserByTelegramId(usersCol, referredUser.referredBy);
    if (!referrer || referrer.banned) return;

    await recordWeeklyReferral(referrer.telegramId, referrer.username);
  } catch (err) {
    console.error('checkReferralWeeklyValid error:', err);
  }
}

module.exports = {
  checkReferralStep1,
  checkReferralStep2,
  checkReferralStep3,
  checkReferralStep4,
  checkReferralWeeklyValid,
};
