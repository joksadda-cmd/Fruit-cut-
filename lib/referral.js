// lib/referral.js
// "Valid Refer" bonus: once a REFERRED user completes 5 tasks AND watches
// 20 ads (total, any network), their referrer gets a one-time bonus of
// 200 Fruit Coin + 3 Game Tokens + 1 Lottery Token — on top of the
// "Normal Refer" instant reward (1 Game Token + 1 Lottery Token) already
// given at signup in api/auth.js.
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
            gameTokens: { $add: [{ $ifNull: ['$gameTokens', 3] }, 3] },
            lotteryTokens: { $add: [{ $ifNull: ['$lotteryTokens', 0] }, 1] },
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
        `🍎 +200 Fruit Coin\n🎮 +3 Game Tokens\n🎰 +1 Lottery Token\n\n` +
        `That's the full referral reward for this friend! 🚀`,
      { reply_markup: { inline_keyboard: [[{ text: '🎮 Open Game', url: MINI_APP_URL }]] } }
    ).catch((e) => console.error('valid-refer notify failed:', e));
  } catch (err) {
    console.error('maybeTriggerValidReferral error:', err);
  }
}

module.exports = { maybeTriggerValidReferral, VALID_REFER_TASKS_REQUIRED, VALID_REFER_ADS_REQUIRED };
