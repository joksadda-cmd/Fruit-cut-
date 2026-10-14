// lib/prizeGift.js
// Weekly contest prizes (Top Slasher / Top Referrer) are handed out as a "gift":
// the winner gets a Telegram message AND, the next time the mini app opens, the same
// animated gift popup the admin's "Send Gift" uses. The Fruit Coin is credited when the
// winner taps CLAIM (api/game_claim.js action 'claim_gift'), exactly once.
//
// Safe to call twice for the same winner + week: the unique (kind, weekKey, telegramId)
// check means a retried cron hit never creates a second gift.

const { getCollection, idVariants } = require('./db');
const { sendTelegramMessage } = require('./notify');

const OPEN_APP_BUTTON = {
  reply_markup: { inline_keyboard: [[{ text: '🎁 Open Fruit Cut & Claim', url: 'https://t.me/Fruit_cut_bot/PlayTo_Earn' }]] },
};

const KINDS = {
  slash_prize: { title: '🏆 You Won!', icon: '🏆', label: 'Weekly Top Slasher', dm: 'Weekly Top Slasher Prize!' },
  refer_prize: { title: '🏆 You Won!', icon: '🏆', label: 'Weekly Top Referrer', dm: 'Weekly Top Referrer Prize!' },
};

// Returns { ok:true } when a new gift was created (and the winner was messaged), { ok:false, reason } otherwise.
async function createPrizeGift({ telegramId, kind, rank, prize, weekKey, detail }) {
  const k = KINDS[kind];
  if (!k || !prize || prize <= 0) return { ok: false, reason: 'bad_params' };

  const usersCol = await getCollection('users');
  const user = await usersCol.findOne({ telegramId: { $in: idVariants(telegramId) } });
  if (!user) return { ok: false, reason: 'user_not_found' };

  const giftsCol = await getCollection('gifts');
  const exists = await giftsCol.findOne({ kind, weekKey, telegramId: user.telegramId });
  if (exists) return { ok: false, reason: 'already_created' };

  await giftsCol.insertOne({
    telegramId: user.telegramId,
    amount: prize,
    reason: `${k.label} — you finished #${rank} this week${detail ? ` (${detail})` : ''}! Congratulations! 🎉`,
    title: k.title,
    icon: k.icon,
    kind,
    weekKey,
    rank,
    status: 'pending',
    createdAt: new Date(),
  });

  sendTelegramMessage(
    user.telegramId,
    `🏆 <b>${k.dm}</b>\n\n` +
      `You finished <b>#${rank}</b> this week${detail ? ` with ${detail}` : ''}.\n` +
      `🎁 Your prize: <b>🍎 ${prize.toLocaleString()} Fruit Coin</b>\n\n` +
      `Open the app and tap <b>CLAIM</b> to get it!`,
    OPEN_APP_BUTTON
  ).catch(() => {});

  return { ok: true };
}

module.exports = { createPrizeGift };
