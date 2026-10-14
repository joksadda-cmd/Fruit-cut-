// lib/withdrawAlert.js
// Tells the admin bot about new withdrawal requests.
//  - alertWithdrawal(w): called right after a user's request is saved (api/withdraw.js).
//  - alertPendingWithdrawals(): safety net, called every minute by the cron job
//    (/api/cron_notify?job=ton_deposits). If the first message failed (Telegram hiccup, timeout, ...),
//    the next minute's run sends it again, so a request can never go unnoticed.

const { getCollection } = require('./db');
const { notifyAdmin } = require('./notify');
const { userReport } = require('./withdrawInfo');

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildText(w) {
  const amount = Number(w.amount) || 0;
  const fee = Number(w.feeFc) || 0;
  return (
    `💰 <b>New withdrawal request!</b>\n\n` +
    `👤 ${w.username && w.username !== 'unknown' ? '@' + esc(w.username) : 'User'} (<code>${esc(w.telegramId)}</code>)\n` +
    `🍎 ${amount.toLocaleString('en-US')} FC → <b>${esc(w.convertedAmount)} ${esc(w.unit || 'USDT')}</b> (fee ${fee.toLocaleString('en-US')} FC)\n` +
    `👛 <code>${esc(w.address)}</code>\n\n` +
    `Open the admin bot → 💰 Withdrawals to approve.`
  );
}

const BUTTON = { reply_markup: { inline_keyboard: [[{ text: '💰 Open Withdrawals', callback_data: 'a_withdrawals' }]] } };

async function alertWithdrawal(w, { timeoutMs = 6000 } = {}) {
  let r;
  try {
    r = await Promise.race([
      (async () => notifyAdmin(buildText(w) + (await userReport({ ...w, createdAt: w.createdAt || new Date() })), BUTTON))(),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs)),
    ]);
  } catch (e) {
    r = { ok: false, reason: String(e) };
  }
  const ok = !!(r && r.ok !== false);
  try {
    const col = await getCollection('withdrawals');
    await col.updateOne(
      { _id: w._id },
      ok ? { $set: { adminNotified: true, adminNotifiedAt: new Date() } }
         : { $set: { adminAlertError: String((r && (r.description || r.reason || r.error)) || 'failed').slice(0, 200) } }
    );
  } catch (e) { /* best effort */ }
  if (!ok) console.error('withdraw admin alert failed:', JSON.stringify(r));
  return ok;
}

// Re-sends alerts for recent pending requests whose first alert never went through.
async function alertPendingWithdrawals() {
  const col = await getCollection('withdrawals');
  const now = Date.now();
  const list = await col
    .find({
      status: 'pending',
      adminNotified: { $ne: true },
      createdAt: { $lt: new Date(now - 45 * 1000), $gt: new Date(now - 6 * 3600 * 1000) },
    })
    .sort({ createdAt: 1 })
    .limit(5)
    .toArray();
  let sent = 0;
  for (const w of list) {
    if (await alertWithdrawal(w, { timeoutMs: 6000 })) sent++;
  }
  return { checked: list.length, sent };
}

module.exports = { alertWithdrawal, alertPendingWithdrawals };
