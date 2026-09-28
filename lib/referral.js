// lib/referral.js
// 4-Step Referral Milestone Reward System:
// Step 1: Friend confirms channel & group join -> Referrer gets: 30 FC + 5 XP
// Step 2: Friend completes 10 tasks -> Referrer gets: 80 FC + 5 XP
// Step 3: Friend plays 10 slash games -> Referrer gets: 120 FC + 10 XP
// Step 4: Friend reaches Level 3 -> Referrer gets: 200 FC + 10 XP
// Total per complete referral: 430 FC + 30 XP
//
// Separately: grantWeeklyReferralValidity() below gates whether a referral
// counts toward the WEEKLY "Top Referrer" leaderboard (lib/referralLeaderboard.js).
// A fresh signup does not count instantly — the friend must first join the
// channel+group and play their first game (see the UPDATED note below).
// This only gates leaderboard eligibility, not the Step 1-4 FC rewards.

const { getCollection, findUserByTelegramId } = require('./db');
const { sendTelegramMessage, notifyAdmin } = require('./notify');
const { TRANSACTION_TYPES } = require('./constants');
const { recordWeeklyReferral } = require('./referralLeaderboard');
const { getSettings } = require('./settings');

const MINI_APP_URL = 'https://t.me/Fruit_cut_bot/PlayTo_Earn';
// UPDATED 2026-09-28: a referral now counts toward the weekly Top Referrer
// leaderboard as soon as the referred friend has
//   (1) joined the official channel + group (verified by Telegram's own
//       getChatMember API — see lib/joinGate.js / referStep1Given), AND
//   (2) finished their first real slash game (single-use server session +
//       server-side minimum play time — see lib/slashSession.js).
// No ad is required (an ad after the first game makes new users leave), and
// the old captcha / 20-hour account-age wait / same-IP block are gone.
//
// Script defence now comes from: a real Telegram-signed account per referral
// (initData is verified), a real channel+group join per account, a real
// session-gated game per account, and the burst limit below (a referrer
// suddenly getting many "valid" referrals in a short time is held back and
// the admin is alerted). The 20-referral minimum for prizes is unchanged.
const REFERRAL_WEEKLY_VALID_SLASH_COUNT = 1;

// Burst limit: if one referrer already got this many referrals validated in
// the last BURST_WINDOW_MS, further ones are HELD (not lost — they are
// re-checked on the friend's next game) and the admin gets one alert.
const REFERRAL_BURST_LIMIT = 6;
const REFERRAL_BURST_WINDOW_MS = 60 * 60 * 1000; // 1 hour

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

// Withdraw commission: fired from api/bot.js whenever a referred user's
// withdrawal is APPROVED by the admin. The referrer gets a percentage
// (settings.referralWithdrawCommissionPercent, default 10%) of the FC
// amount withdrawn. Unlike Steps 1-4 above this is NOT a one-time
// milestone — it has no "already given" flag, and fires again on every
// future withdrawal the same referred user makes.
//
// Same device/IP legitimacy check as grantWeeklyReferralValidity below —
// added even though it wasn't explicitly requested, because without it
// this is a self-dealing loophole: refer your own second account, grind
// FC on it, withdraw it, and collect a further commission on your own
// money back into your main account. The check costs a genuine referral
// nothing and closes that gap. (Was previously called from api/bot.js on
// every withdrawal approval but never implemented/exported at all — every
// approval threw before the admin's confirm message rendered, and no
// commission was ever paid. Fixed 2026-09-27.)
async function grantWithdrawCommission(withdrawingTelegramId, withdrawAmountFc) {
  try {
    const usersCol = await getCollection('users');
    const withdrawingUser = await findUserByTelegramId(usersCol, withdrawingTelegramId);
    if (!withdrawingUser || !withdrawingUser.referredBy) return; // wasn't referred by anyone

    const referrer = await findUserByTelegramId(usersCol, withdrawingUser.referredBy);
    if (!referrer || referrer.banned) return;

    const sameDevice = withdrawingUser.deviceId && referrer.deviceId && withdrawingUser.deviceId === referrer.deviceId;
    const referrerIp = referrer.signupIp || referrer.lastIp;
    const sameIp = withdrawingUser.signupIp && referrerIp && withdrawingUser.signupIp === referrerIp;
    if (sameDevice || sameIp) return; // same person/network as the referrer — no commission

    const settings = await getSettings();
    const commissionPercent = settings.referralWithdrawCommissionPercent ?? 10;
    const commissionFc = Math.round((withdrawAmountFc || 0) * (commissionPercent / 100));
    if (commissionFc <= 0) return;

    const updatedReferrer = await usersCol.findOneAndUpdate(
      { _id: referrer._id },
      {
        $inc: { fruitCoin: commissionFc, referralFruitCoinEarned: commissionFc },
        $set: { lastActive: new Date() },
      },
      { returnDocument: 'after' }
    );

    const txCol = await getCollection('transactions');
    await txCol.insertOne({
      telegramId: referrer.telegramId,
      type: TRANSACTION_TYPES.REFERRAL_REWARD,
      amount: commissionFc,
      balanceAfter: updatedReferrer ? updatedReferrer.fruitCoin : referrer.fruitCoin,
      meta: {
        kind: 'withdraw_commission',
        referredTelegramId: withdrawingUser.telegramId,
        withdrawAmountFc,
        commissionPercent,
      },
      createdAt: new Date(),
    });

    const friendName = withdrawingUser.username && withdrawingUser.username !== 'Player'
      ? `@${withdrawingUser.username}`
      : 'Your friend';

    const msg =
      `💰 <b>Referral Commission!</b>\n\n` +
      `${friendName} just withdrew ${(withdrawAmountFc || 0).toLocaleString()} Fruit Coin — you earned ${commissionPercent}% commission!\n\n` +
      `🍎 +${commissionFc} Fruit Coin\n\n` +
      `Keep sharing to earn more! 🚀`;

    sendTelegramMessage(referrer.telegramId, msg, {
      reply_markup: { inline_keyboard: [[{ text: '🎮 Open Game', url: MINI_APP_URL }]] },
    }).catch(() => {});
  } catch (err) {
    console.error('grantWithdrawCommission error:', err);
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

// ── Referral verification captcha ───────────────────────────────────
// New (2026-09-26): an in-app-only "tap the fruits in order" challenge
// shown to a referred user right after signup. Solving it + then watching
// one GigaPub ad (S2S-confirmed, see api/postback.js) fast-tracks their
// referral to weekly-leaderboard validity.
// NOTE (2026-09-28): NO LONGER USED by the referral flow — auth.js never asks
// for it now and grantWeeklyReferralValidity ignores it. Code kept dormant.
//
// Honest scope of what this does and doesn't stop: the challenge itself
// (random emoji sequence, minimum solve time, limited attempts) is meant
// to stop a NAIVE script that just replays the API calls directly without
// ever rendering/solving anything — that's the actual automation pattern
// this defends against. It is NOT, and no custom-built captcha like this
// can be, a defense against a human manually operating many burner
// accounts on different devices — nothing short of the device/IP check
// below (which still ALWAYS applies, captcha or not) meaningfully raises
// the cost of that.
const CAPTCHA_EMOJI_POOL = ['🍎', '🍊', '🍇', '🍉', '🍓', '🍋', '🍑', '🥝'];
const CAPTCHA_SEQUENCE_LEN = 3;
const CAPTCHA_GRID_SIZE = 6;
const CAPTCHA_MIN_SOLVE_MS = 600;      // faster than a real read-then-tap sequence
const CAPTCHA_MAX_SOLVE_MS = 90 * 1000; // stale — frontend must request a fresh one
const CAPTCHA_MAX_ATTEMPTS = 5;         // wrong guesses before the challenge itself resets

function shuffleArr(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Issues a fresh challenge for a referred user who still needs it. Safe to
// call repeatedly (e.g. frontend requesting a new one after too many wrong
// guesses) — always overwrites any previous challenge.
async function startReferralCaptcha(telegramId) {
  const usersCol = await getCollection('users');
  const user = await findUserByTelegramId(usersCol, telegramId);
  if (!user) return { success: false, error: 'user_not_found' };
  if (!user.referredBy) return { success: false, error: 'not_referred' };
  if (user.referCaptchaPassed || user.referWeeklyValidGiven || user.referWeeklyValidBlocked) {
    return { success: false, error: 'not_needed' };
  }

  const grid = shuffleArr(CAPTCHA_EMOJI_POOL).slice(0, CAPTCHA_GRID_SIZE);
  const target = shuffleArr(grid).slice(0, CAPTCHA_SEQUENCE_LEN);

  await usersCol.updateOne(
    { _id: user._id },
    { $set: { referCaptcha: { grid, target, issuedAt: new Date(), attempts: 0 } } }
  );

  return { success: true, grid, target };
}

// Verifies a solve attempt. tappedSequence must be an array of emoji
// strings in the order the user tapped them.
async function verifyReferralCaptcha(telegramId, tappedSequence) {
  const usersCol = await getCollection('users');
  const user = await findUserByTelegramId(usersCol, telegramId);
  if (!user) return { success: false, error: 'user_not_found' };

  const challenge = user.referCaptcha;
  if (!challenge || !challenge.target) return { success: false, error: 'no_active_challenge' };

  const elapsed = Date.now() - new Date(challenge.issuedAt).getTime();
  if (elapsed > CAPTCHA_MAX_SOLVE_MS) {
    return { success: false, error: 'expired' };
  }
  if (elapsed < CAPTCHA_MIN_SOLVE_MS) {
    return { success: false, error: 'too_fast' };
  }

  const correct =
    Array.isArray(tappedSequence) &&
    tappedSequence.length === challenge.target.length &&
    tappedSequence.every((v, i) => v === challenge.target[i]);

  if (!correct) {
    const attempts = (challenge.attempts || 0) + 1;
    if (attempts >= CAPTCHA_MAX_ATTEMPTS) {
      // Clear it outright — a fresh challenge (new random target) resets
      // the guessing space instead of letting one challenge be ground
      // down by repeated blind guesses.
      await usersCol.updateOne({ _id: user._id }, { $unset: { referCaptcha: '' } });
      return { success: false, error: 'too_many_attempts' };
    }
    await usersCol.updateOne({ _id: user._id }, { $set: { 'referCaptcha.attempts': attempts } });
    return { success: false, error: 'wrong', attemptsLeft: CAPTCHA_MAX_ATTEMPTS - attempts };
  }

  await usersCol.updateOne(
    { _id: user._id },
    { $set: { referCaptchaPassed: true }, $unset: { referCaptcha: '' } }
  );
  return { success: true };
}

// Shared core: atomically flip the one-time "this referral counts for the
// weekly leaderboard" flag, then credit the referrer. Two triggers can call
// it (slash claim, ad postback) — whichever fires first wins, and the flag
// stops a second trigger from double-counting.
//
// A referral is valid when the friend (1) verified channel+group membership
// and (2) played at least REFERRAL_WEEKLY_VALID_SLASH_COUNT slash game(s).
// Then two safety checks run:
//   - same DEVICE as the referrer -> never counts (one-device-one-account
//     is enforced elsewhere too, so this almost never fires). Same IP/wifi
//     is now ALLOWED: real friends/family share wifi, and a person making a
//     second account by hand is not a problem for us.
//   - burst limit (see REFERRAL_BURST_LIMIT above) -> held, admin alerted.
// Neither check touches the lifetime Step 1-4 rewards.
async function grantWeeklyReferralValidity(referredUser) {
  const usersCol = await getCollection('users');

  // Already resolved (granted earlier, or disqualified below).
  if (referredUser.referWeeklyValidGiven || referredUser.referWeeklyValidBlocked) return;
  if (referredUser.banned) return;

  // (1) Telegram-verified channel + group join.
  if (!referredUser.referStep1Given) return;
  // (2) Played real game(s).
  if ((referredUser.totalSlices || 0) < REFERRAL_WEEKLY_VALID_SLASH_COUNT) return;

  const referrer = await findUserByTelegramId(usersCol, referredUser.referredBy);
  if (!referrer || referrer.banned) return;

  const sameDevice = referredUser.deviceId && referrer.deviceId && referredUser.deviceId === referrer.deviceId;
  if (sameDevice) {
    await usersCol.updateOne({ _id: referredUser._id }, { $set: { referWeeklyValidBlocked: true } });
    return;
  }

  // Burst limit — script-farming pattern: many referrals validated at once.
  const since = new Date(Date.now() - REFERRAL_BURST_WINDOW_MS);
  const recentValid = await usersCol.countDocuments({
    referredBy: referredUser.referredBy,
    referWeeklyValidAt: { $gte: since },
  });
  if (recentValid >= REFERRAL_BURST_LIMIT) {
    // Held, not blocked: re-evaluated the next time this friend plays.
    if (!referrer.referBurstAlertedAt || referrer.referBurstAlertedAt < since) {
      await usersCol.updateOne({ _id: referrer._id }, { $set: { referBurstAlertedAt: new Date() } });
      notifyAdmin(
        `⚠️ <b>Referral burst held</b>\n\n` +
          `Referrer <code>${referrer.telegramId}</code> (@${referrer.username || 'unknown'}) already got ` +
          `<b>${recentValid}</b> valid referrals in the last hour. Further ones are on hold — ` +
          `possible script/farming, worth a manual look.`
      ).catch(() => {});
    }
    return;
  }

  const claimed = await usersCol.findOneAndUpdate(
    { _id: referredUser._id, referWeeklyValidGiven: { $ne: true } },
    { $set: { referWeeklyValidGiven: true, referWeeklyValidAt: new Date() } },
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
  startReferralCaptcha,
  verifyReferralCaptcha,
  grantWithdrawCommission,
};
