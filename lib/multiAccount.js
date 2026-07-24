// lib/multiAccount.js
// One Telegram account = fine. But a person opening the Mini App with a
// SECOND Telegram account on the same phone to farm referral/task rewards
// is what this catches. The frontend sends a `deviceId` (a random ID it
// generates once and stores in Telegram CloudStorage, so it survives across
// app restarts on the same device/Telegram client).
//
// We never auto-ban here — we only FLAG the group so the admin bot can
// review and decide (see 'a_flags' in api/webhook.js), same policy as
// your other apps.

const { usersCol } = require('./db');
const { tgSend } = require('./telegram');

const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID;

async function checkDeviceOnNewUser(telegramId, deviceId) {
  if (!deviceId) return;
  const users = await usersCol();

  const siblings = await users.find({ deviceId, telegramId: { $ne: telegramId } }).toArray();
  if (!siblings.length) return;

  const allIds = [telegramId, ...siblings.map(s => s.telegramId)];
  await users.updateMany(
    { telegramId: { $in: allIds } },
    { $set: { multiAccountFlag: true, multiAccountSiblings: allIds } }
  );

  if (ADMIN_TELEGRAM_ID) {
    await tgSend(
      ADMIN_TELEGRAM_ID,
      `🚩 <b>Multiple accounts detected on one device</b>\n\n` +
      `Accounts: ${allIds.map(id => `<code>${id}</code>`).join(', ')}\n\n` +
      `Use 🚩 Multi-Acc Flags in the admin menu to review.`
    ).catch(() => {});
  }
}

module.exports = { checkDeviceOnNewUser };
