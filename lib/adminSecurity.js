// lib/adminSecurity.js — admin-bot screens for the LOCKUP / VELOCITY / TTL systems and the
// daily withdraw report. api/bot.js calls handleCallback() first for every button press.
//
// Buttons handled here:
//   lk_list_<page>        🔒 Locked Accounts (paged list)
//   lk_profile_<id>       user profile (from alerts)
//   lk_lock_<id>          lock an account (admin_manual)
//   lk_unlock_<id>        unlock an account
//   lk_ipunlock_<ip>      unlock every account locked by one IP burst
//   a_ttl / ttl_preview / ttl_run   🧹 Auto-Cleanup (TTL)
//   a_wdreport            💵 Withdraw Report

const { getCollection, findUserByTelegramId } = require('./db');
const { lockUser, unlockUser, unlockIpBurst, listLocked, reasonLabel } = require('./lockup');
const { setupTtlIndexes, ttlStatus, previewImmediateDeletes, ELSEWHERE } = require('./ttlIndexes');

const DHAKA_MS = 6 * 60 * 60 * 1000;
const dhakaKey = (d) => new Date(new Date(d).getTime() + DHAKA_MS).toISOString().slice(0, 10);
const num = (v) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0);
const fmtUsdt = (n) => n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');

// ── Daily withdraw numbers (Dhaka time) ─────────────────────────────
async function withdrawNumbers(days = 7) {
  const col = await getCollection('withdrawals');
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const [paid, pendingRows] = await Promise.all([
    col.find({ status: 'approved', processedAt: { $gte: since } }).limit(20000).toArray(),
    col.find({ status: 'pending' }).limit(5000).toArray(),
  ]);
  const byDay = {};
  for (const w of paid) {
    const k = dhakaKey(w.processedAt);
    byDay[k] = byDay[k] || { usdt: 0, fc: 0, count: 0 };
    byDay[k].usdt += num(w.convertedAmount);
    byDay[k].fc += w.amount || 0;
    byDay[k].count += 1;
  }
  const pending = pendingRows.reduce((a, w) => ({ usdt: a.usdt + num(w.convertedAmount), count: a.count + 1 }), { usdt: 0, count: 0 });
  const rows = [];
  for (let i = 0; i < days; i++) {
    const k = dhakaKey(Date.now() - i * 24 * 3600 * 1000);
    rows.push({ key: k, label: i === 0 ? 'Today' : i === 1 ? 'Yesterday' : k, ...(byDay[k] || { usdt: 0, fc: 0, count: 0 }) });
  }
  const total = rows.reduce((a, r) => ({ usdt: a.usdt + r.usdt, fc: a.fc + r.fc, count: a.count + r.count }), { usdt: 0, fc: 0, count: 0 });
  return { rows, total, pending, today: rows[0] };
}

// 3 lines for the main dashboard
async function withdrawSummaryText() {
  const w = await withdrawNumbers(7);
  return (
    `\n💵 <b>Withdrawn today:</b> <b>${fmtUsdt(w.today.usdt)} USDT</b> <i>(${w.today.count} paid)</i>\n` +
    `📆 Last 7 days: <b>${fmtUsdt(w.total.usdt)} USDT</b> <i>(${w.total.count} paid)</i>\n` +
    `⏳ Waiting for approval: <b>${fmtUsdt(w.pending.usdt)} USDT</b> <i>(${w.pending.count})</i>`
  );
}

async function withdrawReportText() {
  const w = await withdrawNumbers(14);
  const lines = w.rows.map((r) => `${r.label}: <b>${fmtUsdt(r.usdt)} USDT</b> · ${r.count} paid · ${r.fc.toLocaleString('en-US')} FC`).join('\n');
  return (
    `💵 <b>Withdraw Report</b> <i>(approved payouts, Dhaka time)</i>\n\n${lines}\n\n` +
    `📊 Last 14 days total: <b>${fmtUsdt(w.total.usdt)} USDT</b> (${w.total.count} paid)\n` +
    `⏳ Pending now: <b>${fmtUsdt(w.pending.usdt)} USDT</b> (${w.pending.count} request(s))`
  );
}

// ── User profile (used by the lookup flow and by alert buttons) ─────
async function profileMessage(user) {
  const wdCol = await getCollection('withdrawals');
  const agg = await wdCol.aggregate([
    { $match: { telegramId: user.telegramId, status: 'approved' } },
    { $group: { _id: null, totalFc: { $sum: '$amount' }, count: { $sum: 1 }, lastAt: { $max: '$processedAt' } } },
  ]).toArray();
  const wd = agg[0] || { totalFc: 0, count: 0, lastAt: null };
  const daysAgo = (d) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null);
  const joined = daysAgo(user.joinedAt), lastW = daysAgo(user.lastWithdrawAt || wd.lastAt);
  const text =
    `👤 <b>@${user.username || 'unknown'}</b>\n` +
    `ID: <code>${user.telegramId}</code>\n` +
    `🍎 Fruit Coin: <b>${user.fruitCoin || 0}</b>\n` +
    `⭐ Level: <b>${user.level || 1}</b> (XP: <b>${user.xp || 0}</b>)\n` +
    `⚔️ Total Slices: <b>${user.totalSlices || 0}</b>\n` +
    `📺 Total Ads Watched: <b>${user.totalAdsWatched || 0}</b>\n` +
    `👥 Referrals: <b>${user.referralCount || 0}</b>\n` +
    `📅 Joined: <b>${joined !== null ? joined + ' day(s) ago' : 'Unknown'}</b>\n` +
    `💸 Total Withdrawn: <b>${(wd.totalFc || 0).toLocaleString()} Fruit Coin</b> <i>(${wd.count || 0} approved)</i>\n` +
    `🕒 Last Withdraw: <b>${lastW !== null ? lastW + ' day(s) ago' : 'Never'}</b>\n` +
    `🌐 Signup IP: <code>${user.signupIp || '—'}</code>\n` +
    `🔒 Locked: <b>${user.accountLocked ? 'YES — ' + reasonLabel(user.accountLockedReason) : 'No ✅'}</b>\n` +
    (user.velocityFlaggedAt ? `🚩 Velocity flag: <b>${user.velocityFlaggedReason || 'yes'}</b>\n` : '') +
    `🚫 Banned: <b>${user.banned ? 'Yes' : 'No'}</b>`;
  const kb = {
    inline_keyboard: [
      [user.accountLocked ? { text: '🔓 Unlock Account', callback_data: `lk_unlock_${user.telegramId}` } : { text: '🔒 Lock Account', callback_data: `lk_lock_${user.telegramId}` }],
      [user.banned ? { text: '✅ Unban', callback_data: `a_unban_${user.telegramId}` } : { text: '🚫 Ban', callback_data: `a_ban_${user.telegramId}` }],
      [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }],
    ],
  };
  return { text, kb };
}

async function lockedListScreen(page) {
  const { total, rows } = await listLocked(page, 8);
  if (!total) return { text: '🔒 <b>Locked Accounts</b>\n\nNo locked accounts. ✅', kb: { inline_keyboard: [[{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] } };
  const lines = rows.map((u, i) => `${page * 8 + i + 1}. @${u.username || 'unknown'} <code>${u.telegramId}</code> — ${reasonLabel(u.accountLockedReason)} · ${u.fruitCoin || 0} FC`).join('\n');
  const kb = rows.map((u) => [
    { text: `🔓 Unlock ${String(u.username || u.telegramId).slice(0, 14)}`, callback_data: `lk_unlock_${u.telegramId}` },
    { text: '👤', callback_data: `lk_profile_${u.telegramId}` },
  ]);
  const nav = [];
  if (page > 0) nav.push({ text: '◀️ Prev', callback_data: `lk_list_${page - 1}` });
  if ((page + 1) * 8 < total) nav.push({ text: 'Next ▶️', callback_data: `lk_list_${page + 1}` });
  if (nav.length) kb.push(nav);
  kb.push([{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]);
  return { text: `🔒 <b>Locked Accounts</b> (${total})\n\n${lines}`, kb: { inline_keyboard: kb } };
}

// ctx: { chatId, msgId, send, edit, backKb }
async function handleCallback(data, ctx) {
  const { chatId, msgId, send, edit, backKb } = ctx;

  if (data === 'a_wdreport') { await edit(chatId, msgId, await withdrawReportText(), { reply_markup: backKb }); return true; }

  if (data.startsWith('lk_list_')) {
    const s = await lockedListScreen(parseInt(data.slice(8), 10) || 0);
    await edit(chatId, msgId, s.text, { reply_markup: s.kb });
    return true;
  }
  if (data.startsWith('lk_profile_')) {
    const usersCol = await getCollection('users');
    const user = await findUserByTelegramId(usersCol, data.slice(11));
    if (!user) { await send(chatId, '❌ User not found.', { reply_markup: backKb }); return true; }
    const p = await profileMessage(user);
    await send(chatId, p.text, { reply_markup: p.kb });
    return true;
  }
  if (data.startsWith('lk_lock_')) {
    const id = data.slice(8);
    const ok = await lockUser(id, 'admin_manual');
    await send(chatId, ok ? `🔒 <b>${id}</b> is now locked (no withdrawals, no referral rewards).` : `ℹ️ ${id} was already locked or not found.`, { reply_markup: backKb });
    return true;
  }
  if (data.startsWith('lk_unlock_')) {
    const id = data.slice(10);
    const ok = await unlockUser(id);
    await send(chatId, ok ? `🔓 <b>${id}</b> unlocked.` : `❌ User ${id} not found.`, { reply_markup: backKb });
    return true;
  }
  if (data.startsWith('lk_ipunlock_')) {
    const n = await unlockIpBurst(data.slice(12));
    await send(chatId, `🔓 Unlocked <b>${n}</b> account(s) from that IP.`, { reply_markup: backKb });
    return true;
  }

  // ── TTL ──
  if (data === 'a_ttl') {
    const st = await ttlStatus();
    const lines = st.map((x) => `${x.present ? '✅' : '⚪'} ${x.label}`).join('\n');
    const done = st.filter((x) => x.present).length;
    await edit(chatId, msgId,
      `🧹 <b>Auto-Cleanup (TTL)</b>\n\nOld data deletes itself so the free database never fills up.\n\n${lines}\n\n<b>Already automatic:</b>\n${ELSEWHERE.map((l) => '• ' + l).join('\n')}\n\n${done}/${st.length} rules active.`,
      { reply_markup: { inline_keyboard: [[{ text: done === st.length ? '🔁 Re-check / Run setup again' : '🔍 Preview & Run Setup', callback_data: 'ttl_preview' }], [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] } });
    return true;
  }
  if (data === 'ttl_preview') {
    const pv = await previewImmediateDeletes();
    const hit = pv.filter((x) => x.count > 0);
    const text = hit.length
      ? `⚠️ <b>Before you run it</b>\n\nMongoDB deletes everything that is ALREADY older than a rule's limit the moment the rule exists. Right now that would remove:\n\n${hit.map((x) => `• <b>${x.count}</b> — ${x.label}`).join('\n')}\n\nDeleted data can't be brought back. Continue?`
      : `✅ Nothing is old enough to be deleted right now. Running the setup only turns the automatic cleanup on for the future.`;
    await edit(chatId, msgId, text, { reply_markup: { inline_keyboard: [[{ text: '✅ Yes, run setup', callback_data: 'ttl_run' }], [{ text: '❌ Cancel', callback_data: 'a_ttl' }]] } });
    return true;
  }
  if (data === 'ttl_run') {
    await edit(chatId, msgId, '⏳ Setting up auto-cleanup...');
    const res = await setupTtlIndexes();
    const lines = res.map((r) => `${r.ok ? '✅' : '❌'} ${r.label || r.name}${r.note ? ' — ' + r.note : ''}${r.ok ? '' : '\n    ' + r.error}`).join('\n');
    const bad = res.filter((r) => !r.ok).length;
    await edit(chatId, msgId, `🧹 <b>Auto-Cleanup setup finished</b>\n\n${lines}\n\n${bad ? `⚠️ ${bad} rule(s) failed — send me this message.` : '✅ All rules are active. MongoDB cleans up about once a minute.'}`, { reply_markup: { inline_keyboard: [[{ text: '📋 View status', callback_data: 'a_ttl' }], [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] } });
    return true;
  }
  return false;
}

module.exports = { handleCallback, profileMessage, withdrawSummaryText, withdrawReportText };
