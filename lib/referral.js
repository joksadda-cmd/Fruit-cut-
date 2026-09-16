// lib/referral.js
// "Valid Refer" bonus: once a REFERRED user completes 5 tasks AND watches
// 20 ads (total, any network), their referrer gets a one-time bonus of
// 200 Fruit Coin + 3 Game Tokens — on top of the "Normal Refer" instant
// reward (1 Game Token) already given at signup in api/auth.js.
//
// Called after any event that could move the referred user across the
// threshold — ad credits (lib/adReward.js, api/postback.js) and task
// claims (api/verify_task.js). Guarded so it only ever fires once per
// referred user, even if two triggers race each other.

const { getCollection, findUserByTelegramId } = require('./db');
const { sendTelegramMessage } = require('./notify');
const { TRANSACTION_TYPES } = require('./constants');

const VALID_REFER_TASKS_REQUIRED = 5;
const VALID_REFER_ADS_REQUIRED = 20;
const MINI_APP_URL = 'https://t.me/Fruit_cut_bot/PlayTo_Earn';

async function maybeTriggerValidReferral(referredUser) {
  try {
    if (!referredUser || !referredUser.referredBy) return;
    if (referredUser.validReferralGiven) return;

    const tasksDone = (referredUser.completedTasks || []).length;
    const adsWatched = referredUser.totalAdsWatched || 0;
    if (tasksDone < VALID_REFER_TASKS_REQUIRED || adsWatched < VALID_REFER_ADS_REQUIRED) return;

    const usersCol = await getCollection('users');

    // Atomic claim — if two events (an ad credit and a task credit) both
    // cross the threshold near-simultaneously, only one can win this.
    const claimed = await usersCol.findOneAndUpdate(
      { _id: referredUser._id, validReferralGiven: { $ne: true } },
      { $set: { validReferralGiven: true } },
      { returnDocument: 'after' }
    );
    if (!claimed) return;

    const referrer = await findUserByTelegramId(usersCol, referredUser.referredBy);
    if (!referrer || referrer.banned) return;

    const updatedReferrer = await usersCol.findOneAndUpdate(
      { _id: referrer._id },
      [
        {
          $set: {
            fruitCoin: { $add: [{ $ifNull: ['$fruitCoin', 0] }, 200] },
            // BUG FIX: this tracker field is what the Refer & Earn screen
            // actually reads ("🍎 Fruit Coin Earned") — it was never being
            // updated anywhere, so that number stayed 0 forever even
            // after a Valid Refer bonus was correctly paid into fruitCoin.
            referralFruitCoinEarned: { $add: [{ $ifNull: ['$referralFruitCoinEarned', 0] }, 200] },
            gameTokens: { $add: [{ $ifNull: ['$gameTokens', 3] }, 3] },
            lastActive: new Date(),
          },
        },
      ],
      { returnDocument: 'after' }
    );

    const txCol = await getCollection('transactions');
    await txCol.insertOne({
      telegramId: referrer.telegramId,
      type: TRANSACTION_TYPES.REFERRAL_REWARD,
      amount: 200,
      balanceAfter: updatedReferrer ? updatedReferrer.fruitCoin : referrer.fruitCoin,
      meta: { validRefer: true, referredTelegramId: referredUser.telegramId },
      createdAt: new Date(),
    });

    const joinedWho =
      referredUser.username && referredUser.username !== 'Player' ? `@${referredUser.username}` : 'Your referral';

    sendTelegramMessage(
      referrer.telegramId,
      `🌟 <b>Valid Refer Bonus!</b>\n\n` +
        `${joinedWho} completed 5 tasks + watched 20 ads!\n\n` +
        `🍎 +200 Fruit Coin\n🎮 +3 Game Tokens\n\n` +
        `That's the full referral reward for this friend! 🚀`,
      { reply_markup: { inline_keyboard: [[{ text: '🎮 Open Game', url: MINI_APP_URL }]] } }
    ).catch((e) => console.error('valid-refer notify failed:', e));
  } catch (err) {
    console.error('maybeTriggerValidReferral error:', err);
  }
}

// ── Weekly referral reward ───────────────────────────────────────────
// Separate from the one-time "Valid Refer" bonus above. Every week, any
// referrer who (a) has at least one referral AND (b) personally won at
// least `minSlashWinsRequired` rounds of Slash-the-Fruit THAT week gets a
// bonus of `bonusFcPerReferral` Fruit Coin for each referral they have.
// Run this once per week from the same cron job that distributes the
// leaderboard prizes (see api/slash.js's `cron` action) — it's idempotent
// per week via the `weeklyReferralPaidWeeks` field on the user doc.
async function distributeWeeklyReferralRewards(weekKey, minSlashWinsRequired, bonusFcPerReferral) {
  const { getWeeklyWins } = require('./leaderboard');
  const usersCol = await getCollection('users');
  const txCol = await getCollection('transactions');

  const referrers = await usersCol
    .find({ referralCount: { $gt: 0 }, banned: { $ne: true } })
    .toArray();

  const paid = [];
  for (const referrer of referrers) {
    // Already paid for this week? Skip — keeps this safe to re-run.
    if ((referrer.weeklyReferralPaidWeeks || []).includes(weekKey)) continue;

    const wins = await getWeeklyWins(referrer.telegramId, weekKey);
    if (wins < minSlashWinsRequired) continue;

    const bonus = bonusFcPerReferral * referrer.referralCount;
    if (bonus <= 0) continue;

    const updated = await usersCol.findOneAndUpdate(
      { _id: referrer._id, weeklyReferralPaidWeeks: { $ne: weekKey } },
      {
        $inc: { fruitCoin: bonus },
        $addToSet: { weeklyReferralPaidWeeks: weekKey },
        $set: { lastActive: new Date() },
      },
      { returnDocument: 'after' }
    );
    if (!updated) continue;

    await txCol.insertOne({
      telegramId: referrer.telegramId,
      type: TRANSACTION_TYPES.WEEKLY_REFERRAL_REWARD,
      amount: bonus,
      balanceAfter: updated.fruitCoin,
      meta: { weekKey, referralCount: referrer.referralCount, slashWins: wins },
      createdAt: new Date(),
    });

    sendTelegramMessage(
      referrer.telegramId,
      `🎁 <b>Weekly Refer Reward!</b>\n\n` +
        `You slashed ${wins} times this week (min ${minSlashWinsRequired} required) and have ${referrer.referralCount} referral(s).\n\n` +
        `🍎 +${bonus.toLocaleString()} Fruit Coin added!\n\n` +
        `Keep slashing and inviting to earn every week! 🔪`
    ).catch(() => {});

    paid.push({ telegramId: referrer.telegramId, bonus });
  }

  return { paid };
}

module.exports = {
  maybeTriggerValidReferral,
  distributeWeeklyReferralRewards,
  VALID_REFER_TASKS_REQUIRED,
  VALID_REFER_ADS_REQUIRED,
};
