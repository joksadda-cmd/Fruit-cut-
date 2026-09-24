// lib/referral.js
// 4-Step Referral Milestone Reward System:
// Step 1: Friend confirms channel & group join -> Referrer gets: 30 FC + 5 XP
// Step 2: Friend completes 10 tasks -> Referrer gets: 80 FC + 5 XP
// Step 3: Friend plays 10 slash games -> Referrer gets: 120 FC + 10 XP
// Step 4: Friend reaches Level 3 -> Referrer gets: 200 FC + 10 XP
// Total per complete referral: 430 FC + 30 XP
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
// A referral only counts toward the weekly FC pool once the referred
// account has existed this long — stops the "spin up N fresh accounts,
// grind 5 slashes on each today, count immediately" farming pattern.
// Doesn't affect the lifetime 430 FC Step 1-4 rewards, only leaderboard
// eligibility.
const REFERRAL_WEEKLY_MIN_ACCOUNT_AGE_MS = 20 * 60 * 60 * 1000; // 20 hours

async function awardReferralMilestone(referrerId, referredUser, step, rewardFc, milestoneText, rewardXp) {
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
          xp: rewardXp || 0,
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
      `🍎 +${rewardFc} Fruit Coin` + (rewardXp ? ` · ⭐ +${rewardXp} XP` : '') + `\n\n` +
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
      'joined the official channel & group',
      5
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
      'completed 10 tasks',
      5
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
      'played 10 slash games',
      10
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
      'reached Level 3 (Juice Maker)',
      10
    );
  } catch (err) {
    console.error('checkReferralStep4 error:', err);
  }
}

// Shared core: atomically flip the one-time "this referral counts for the
// weekly leaderboard" flag, then credit the referrer. Two different signals
// can trigger it (see below) — whichever happens first wins, and the flag
// stops a second trigger from double-counting.
//
// Before granting, this also checks that the referral looks genuine rather
// than farmed:
//   1. The referred account must be at least REFERRAL_WEEKLY_MIN_ACCOUNT_AGE_MS
//      old — a same-day disposable account never qualifies, however fast
//      someone grinds slashes on it.
//   2. The referred account's device fingerprint / signup IP must differ
//      from the referrer's own — a referrer "inviting" an account created
//      from their own phone/network never qualifies.
// Neither check touches the lifetime Step 1-4 rewards — only whether this
// referral counts toward the weekly FC pool.
async function grantWeeklyReferralValidity(referredUser) {
  const usersCol = await getCollection('users');

  // Already permanently resolved (either granted earlier, or disqualified
  // by the checks below) — nothing further to do.
  if (referredUser.referWeeklyValidGiven || referredUser.referWeeklyValidBlocked) return;

  const joinedAt = referredUser.joinedAt ? new Date(referredUser.joinedAt).getTime() : 0;
  if (!joinedAt || Date.now() - joinedAt < REFERRAL_WEEKLY_MIN_ACCOUNT_AGE_MS) {
    return; // too new — try again on the next trigger, once it's old enough
  }

  const referrer = await findUserByTelegramId(usersCol, referredUser.referredBy);
  if (!referrer || referrer.banned) return;

  const sameDevice = referredUser.deviceId && referrer.deviceId && referredUser.deviceId === referrer.deviceId;
  const referrerIp = referrer.signupIp || referrer.lastIp;
  const sameIp = referredUser.signupIp && referrerIp && referredUser.signupIp === referrerIp;
  if (sameDevice || sameIp) {
    // Permanently disqualified — same person/network as the referrer.
    // Won't change over time, so resolve it now instead of re-checking
    // this pair on every future slash claim.
    await usersCol.updateOne({ _id: referredUser._id }, { $set: { referWeeklyValidBlocked: true } });
    return;
  }

  const claimed = await usersCol.findOneAndUpdate(
    { _id: referredUser._id, referWeeklyValidGiven: { $ne: true } },
    { $set: { referWeeklyValidGiven: true } },
    { returnDocument: 'after' }
  );
  if (!claimed) return;

  await recordWeeklyReferral(referrer.telegramId, referrer.username);
}

// Signal 1: referred friend has played REFERRAL_WEEKLY_VALID_SLASH_COUNT
// slash games (cooldown-gated real activity, but not independently
// verified — see api/slash.js).
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

// Signal 2: referred friend generated a genuine S2S-confirmed ad view
// (GigaPub postback — see api/postback.js). This is the STRONGER signal —
// nothing on the user's own device can fake a call that never goes through
// their device — so it needs no extra threshold, unlike signal 1.
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
  checkReferralWeeklyValid,
  maybeTriggerValidReferral,
};
