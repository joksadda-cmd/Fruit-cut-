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
//   lk_refs_<id>          👥 referral report of a user (7-day activity of every referral)
//   lk_rbanask_<id>_<r|u> "are you sure?" screen before banning referrals (r = referrals only, u = user + referrals)
//   lk_rbanok_<id>_<r|u>_<t>  the ban itself (valid for 2 minutes after the confirm screen)
//   a_slashscan           🕵️ Slash Scan — finds bot clusters / identical-stat accounts in the weekly slash leaderboard
//   sy_view|lock|clear|banask|banok_<clusterId>   actions on a found cluster
//   a_signups / sb_scan_<hours>   🆕 Signup Bursts — many accounts created at the same time (list, IDs, data)
//   sb_view|page|lock|clear|banask|banok_<burstId>  actions on one burst (Lock / Ban always ask first)

const { getCollection, findUserByTelegramId, idVariants } = require('./db');
const { lockUser, unlockUser, unlockIpBurst, listLocked, reasonLabel, clearSlashSuspect, banAccounts, lockMany, unlockMany } = require('./lockup');
const signupBursts = require('./signupBursts');
const { countReferrals, getReferrals, activity7d, referralReport } = require('./referralReport');
const slashGuard = require('./slashGuard');
const { getWeekKey, getWeeklyWins, getTopSlashers } = require('./leaderboard');
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
const hx = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tsNow36 = () => Math.floor(Date.now() / 1000).toString(36);
const tsFresh = (t36, maxSec = 120) => { const t = parseInt(t36, 36); return Number.isFinite(t) && Date.now() / 1000 - t <= maxSec && t <= Date.now() / 1000 + 5; };

async function profileMessage(user) {
  const wdCol = await getCollection('withdrawals');
  const usersCol = await getCollection('users');
  const idStr = String(user.telegramId);

  const [agg, totalRefs, own7d, wins, sameIp] = await Promise.all([
    wdCol.aggregate([
      { $match: { telegramId: user.telegramId, status: 'approved' } },
      { $group: { _id: null, totalFc: { $sum: '$amount' }, count: { $sum: 1 }, lastAt: { $max: '$processedAt' } } },
    ]).toArray(),
    countReferrals(user.telegramId).catch(() => 0),
    activity7d([user.telegramId]).catch(() => new Map()),
    getWeeklyWins(user.telegramId).catch(() => 0),
    user.signupIp
      ? usersCol.find({ signupIp: user.signupIp, telegramId: { $nin: idVariants(user.telegramId) } }, { projection: { telegramId: 1, username: 1, banned: 1 } }).limit(30).toArray().catch(() => [])
      : Promise.resolve([]),
  ]);
  const wd = agg[0] || { totalFc: 0, count: 0, lastAt: null };
  const me7 = own7d.get(idStr) || { ads: 0, tasks: 0, slashes: 0 };

  // referral activity (only when the user has referrals; capped so a huge list stays fast)
  let refLine = '';
  if (totalRefs > 0) {
    let joined7 = 0, active = 0;
    try {
      const refs = (await usersCol.find(
        { referredBy: { $in: [...idVariants(user.telegramId), ...idVariants(user.telegramId).map(String)] } },
        { projection: { telegramId: 1, joinedAt: 1 } }
      ).limit(3000).toArray());
      joined7 = refs.filter((r) => r.joinedAt && Date.now() - new Date(r.joinedAt).getTime() < 7 * 86400000).length;
      const act = await activity7d(refs.map((r) => r.telegramId));
      active = refs.filter((r) => { const a = act.get(String(r.telegramId)); return a && a.ads + a.tasks + a.slashes > 0; }).length;
      const inactivePct = refs.length ? Math.round((100 * (refs.length - active)) / refs.length) : 0;
      refLine = `   ↳ joined last 7d: <b>${joined7}</b> · active last 7d: <b>${active}</b>/${refs.length} · inactive: <b>${inactivePct}%</b>` +
        (inactivePct >= 70 ? ' 🔴' : inactivePct >= 40 ? ' 🟡' : ' 🟢') + '\n';
    } catch (e) { /* profile still shows the total */ }
  }

  const daysAgo = (d) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null);
  const joined = daysAgo(user.joinedAt), lastW = daysAgo(user.lastWithdrawAt || wd.lastAt);

  const flags = [];
  if (user.slashSuspect) flags.push('🕵️ slash-cluster suspect');
  if (user.slashThrottleUntil && new Date(user.slashThrottleUntil) > new Date()) flags.push('⏳ slash paused (too many tries)');
  if ((user.slashPreciseStreak || 0) >= 2) flags.push(`🤖 exact-interval slash streak ${user.slashPreciseStreak}`);
  if (user.botFlaggedAt) flags.push('🤖 bot-flagged');
  const ipLine = sameIp.length
    ? `🌐 Same signup IP: <b>${sameIp.length}</b> other account(s)${sameIp.length >= 3 ? ' 🔴' : ''}: ` +
      sameIp.slice(0, 4).map((u) => `${u.banned ? '🚫' : ''}<code>${hx(u.telegramId)}</code>`).join(', ') + (sameIp.length > 4 ? ' …' : '') + '\n'
    : '';

  const text =
    `👤 <b>@${hx(user.username || 'unknown')}</b>\n` +
    `ID: <code>${user.telegramId}</code>\n` +
    (user.referredBy ? `🔗 Invited by: <code>${hx(user.referredBy)}</code>\n` : '') +
    `🍎 Fruit Coin: <b>${user.fruitCoin || 0}</b>\n` +
    `⭐ Level: <b>${user.level || 1}</b> (XP: <b>${user.xp || 0}</b>)\n` +
    `⚔️ Total Slices: <b>${user.totalSlices || 0}</b> · this week's wins: <b>${wins}</b>\n` +
    `📺 Total Ads Watched: <b>${user.totalAdsWatched || 0}</b>\n` +
    `👥 Total Referrals: <b>${totalRefs}</b> <i>(${user.referralCount || 0} counted as valid)</i>\n` +
    refLine +
    `📊 <b>Last 7 days:</b> 📺 ${me7.ads} ads · ✅ ${me7.tasks} tasks · 🔪 ${me7.slashes} slashes\n` +
    `📅 Joined: <b>${joined !== null ? joined + ' day(s) ago' : 'Unknown'}</b>\n` +
    `💸 Total Withdrawn: <b>${(wd.totalFc || 0).toLocaleString()} Fruit Coin</b> <i>(${wd.count || 0} approved)</i>\n` +
    `🕒 Last Withdraw: <b>${lastW !== null ? lastW + ' day(s) ago' : 'Never'}</b>\n` +
    `🌐 Signup IP: <code>${user.signupIp || '—'}</code>\n` +
    ipLine +
    `🔒 Locked: <b>${user.accountLocked ? 'YES — ' + reasonLabel(user.accountLockedReason) : 'No ✅'}</b>\n` +
    (user.velocityFlaggedAt ? `🚩 Velocity flag: <b>${user.velocityFlaggedReason || 'yes'}</b>\n` : '') +
    (flags.length ? `🚨 Flags: <b>${flags.join(' · ')}</b>\n` : '') +
    `🚫 Banned: <b>${user.banned ? 'Yes' : 'No'}</b>`;
  const rows = [
    [user.accountLocked ? { text: '🔓 Unlock Account', callback_data: `lk_unlock_${user.telegramId}` } : { text: '🔒 Lock Account', callback_data: `lk_lock_${user.telegramId}` }],
    [user.banned ? { text: '✅ Unban', callback_data: `a_unban_${user.telegramId}` } : { text: '🚫 Ban', callback_data: `a_ban_${user.telegramId}` }],
  ];
  if (totalRefs > 0) rows.push([{ text: `👥 Referral Report — ${totalRefs} (7-day activity)`, callback_data: `lk_refs_${user.telegramId}` }]);
  rows.push([{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]);
  return { text, kb: { inline_keyboard: rows } };
}

// ── Signup Bursts (many accounts created at the same time) ──────────
const dhakaClock = (ms) => new Date(ms + DHAKA_MS).toISOString().slice(5, 19).replace('T', ' ');   // "10-18 14:52:10" (Dhaka time)
const dhakaHms = (ms) => new Date(ms + DHAKA_MS).toISOString().slice(11, 19);
const spanText = (ms) => { const s2 = Math.max(0, Math.round(ms / 1000)); return s2 >= 60 ? `${Math.floor(s2 / 60)} min ${s2 % 60}s` : `${s2}s`; };
const rangeLabel = (h) => (h >= 168 ? '7 days' : h >= 24 ? `${Math.round(h / 24)} day${h >= 48 ? 's' : ''}` : `${h} hour${h > 1 ? 's' : ''}`);

function burstButtons(cid, n) {
  return { inline_keyboard: [
    [{ text: '👁 Members (IDs + data)', callback_data: `sb_view_${cid}` }],
    [{ text: `🔒 Lock all ${n}`, callback_data: `sb_lock_${cid}` }, { text: `🚫 Ban all ${n}`, callback_data: `sb_banask_${cid}` }],
    [{ text: '✅ Real users — unlock', callback_data: `sb_clear_${cid}` }],
  ] };
}

async function runSignupScan(ctx, hours) {
  const { chatId, msgId, send, edit } = ctx;
  await edit(chatId, msgId, `🆕 Scanning sign-ups of the last ${rangeLabel(hours)}...`);
  const res = await signupBursts.scanBursts(hours);
  const top = res.bursts.slice(0, 5);
  const inBursts = res.bursts.reduce((a, b) => a + b.size, 0);
  const rangeKb = { inline_keyboard: [
    [{ text: (hours === 1 ? '• ' : '') + '1 hour', callback_data: 'sb_scan_1' }, { text: (hours === 24 ? '• ' : '') + '24 hours', callback_data: 'sb_scan_24' }, { text: (hours === 168 ? '• ' : '') + '7 days', callback_data: 'sb_scan_168' }],
    [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }],
  ] };
  await edit(chatId, msgId,
    `🆕 <b>Signup Bursts</b> — last ${rangeLabel(hours)} <i>(Dhaka time)</i>\n\n` +
      `New accounts: <b>${res.total.toLocaleString('en-US')}</b>\n` +
      `Bursts found: <b>${res.bursts.length}</b> · accounts inside bursts: <b>${inBursts.toLocaleString('en-US')}</b>\n\n` +
      `<i>Burst = ${signupBursts.CFG.MIN}+ accounts where each one joined within ${signupBursts.CFG.GAP_MS / 1000}s of the previous one.</i>\n` +
      (res.bursts.length ? (res.bursts.length > top.length ? `\nShowing the ${top.length} biggest ↓` : '\nDetails ↓') : '\n🟢 No burst found in this period.'),
    { reply_markup: rangeKb });

  let i = 0;
  for (const b of top) {
    i++;
    const cid = await slashGuard.saveCluster(b.ids, 'signup', 500);
    const inf = b.info || {};
    const dur = b.end - b.start;
    const perMin = dur >= 30000 ? ` · ~${Math.round(b.size / (dur / 60000))} accounts/min` : '';
    const pct = (x, n) => `${x}/${b.size} (${Math.round((100 * x) / b.size)}%)`;
    await send(chatId,
      `🆕 <b>Burst #${i} — ${b.size} accounts</b>\n` +
        `🕐 ${dhakaClock(b.start)} → ${dhakaHms(b.end)} <i>(${spanText(dur)}${perMin})</i>\n\n` +
        `🌐 Same signup IP: <b>${pct(inf.ipN || 0)}</b>${inf.topIp ? ` — <code>${hx(inf.topIp)}</code>` : ''}\n` +
        `🔗 Same referrer: <b>${pct(inf.refN || 0)}</b>${inf.topRef ? ` — <code>${hx(inf.topRef)}</code>` : ''}\n` +
        `💀 Never did anything: <b>${pct(inf.dead || 0)}</b>\n` +
        `🚫 Already banned: ${inf.banned || 0} · 🔒 locked: ${inf.locked || 0}\n` +
        (inf.bystanders ? `🧍 ${inf.bystanders} real-looking account(s) that joined in the same minute were left out of this list (different IP + referrer, and they really used the app).\n` : '') + '\n' +
        `<b>${inf.verdict || ''}</b>`,
      { reply_markup: burstButtons(cid, b.size) });
  }
}

// ── Slash Scan (finds bot farms in this week's slash leaderboard) ───
async function runSlashScan(ctx) {
  const { chatId, msgId, send, edit, backKb } = ctx;
  await edit(chatId, msgId, '🕵️ Scanning this week\'s top 100 slashers... (a few seconds)');
  const wk = getWeekKey();
  const top = await getTopSlashers(wk, 100);
  if (!top.length) { await edit(chatId, msgId, '🕵️ <b>Slash Scan</b>\n\nNo slash wins this week yet.', { reply_markup: backKb }); return; }
  const usersCol = await getCollection('users');
  const urows = await usersCol.find({ telegramId: { $in: top.flatMap((e) => idVariants(e.telegramId)) } }, { projection: { telegramId: 1, level: 1 } }).toArray();
  const lvl = new Map(urows.map((u) => [String(u.telegramId), u.level || 1]));
  const rows = top.map((e) => ({ id: String(e.telegramId), wins: e.wins, level: lvl.get(String(e.telegramId)) || 1 }));
  const scan = await slashGuard.scanSlashFarms({ candidateIds: rows.map((r) => r.id), rows });
  const topIdent = scan.identical.slice(0, 3);
  const topClusters = scan.clusters.slice(0, 4);

  const verdict = (topClusters.length || topIdent.length)
    ? `🔴 <b>Suspicious groups found</b> — details below.`
    : `🟢 <b>Nothing suspicious found</b> in the top 100.`;
  await edit(chatId, msgId,
    `🕵️ <b>Slash Scan</b> — week ${wk}\n\n` +
      `Looked at the top <b>${top.length}</b> slashers and <b>${scan.claimsScanned.toLocaleString('en-US')}</b> slash records.\n\n` +
      `🔴 Same-time clusters (${slashGuard.CFG.SYNC_GROUP_MIN}+ accounts slashing within 30s, repeatedly): <b>${scan.clusters.length}</b>\n` +
      `🟡 Identical-stat groups (4+ accounts, same wins AND same level): <b>${scan.identical.length}</b>\n\n${verdict}`,
    { reply_markup: backKb });

  for (const c of topClusters) {
    const cid = await slashGuard.saveCluster(c.ids, 'scan');
    await send(chatId,
      `🔴 <b>Same-time cluster — ${c.size} accounts</b>\nThe same group slashed together in up to <b>${c.rounds}</b> separate rounds.\n\n${await slashGuard.describeIds(c.ids, 10)}`,
      { reply_markup: slashGuard.clusterButtons(cid, c.size) });
  }
  for (const g of topIdent) {
    const already = new Set(topClusters.flatMap((c) => c.ids));
    const fresh = g.ids.filter((id) => !already.has(id));
    if (fresh.length < 4) continue;
    const cid = await slashGuard.saveCluster(fresh, 'identical');
    await send(chatId,
      `🟡 <b>Identical stats — ${fresh.length} accounts</b>\nAll show <b>Level ${g.level}</b> and exactly <b>${g.wins} wins</b>. Real players never line up like this.\n\n${await slashGuard.describeIds(fresh, 10)}`,
      { reply_markup: slashGuard.clusterButtons(cid, fresh.length) });
  }
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

  // ── Signup bursts ──
  if (data === 'a_signups') { await runSignupScan(ctx, 24); return true; }
  if (data.startsWith('sb_scan_')) { const h = parseInt(data.slice(8), 10); await runSignupScan(ctx, [1, 24, 168].includes(h) ? h : 24); return true; }
  if (data.startsWith('sb_')) {
    const m = /^sb_(view|page|lock|clear|banask|banok)_([0-9a-f]{8})(?:_([0-9a-z]+))?$/.exec(data);
    if (!m) return false;
    const [, act, cid, arg] = m;
    const cl = await slashGuard.loadCluster(cid);
    if (!cl) { await send(chatId, '⚠️ This list is too old (saved for 7 days) — open 🆕 Signup Bursts again.', { reply_markup: backKb }); return true; }
    const ids = cl.ids;
    if (act === 'view' || act === 'page') {
      const per = 20;
      const page = act === 'page' ? Math.max(0, parseInt(arg, 10) || 0) : 0;
      const usersCol = await getCollection('users');
      const rows = (await usersCol.find({ telegramId: { $in: ids.flatMap((id) => idVariants(id)) } }).limit(600).toArray())
        .sort((a, b) => new Date(a.joinedAt || 0) - new Date(b.joinedAt || 0));
      const slice = rows.slice(page * per, page * per + per);
      const lines = slice.map((u) =>
        `${u.banned ? '🚫' : u.accountLocked ? '🔒' : '•'} ${u.joinedAt ? dhakaHms(new Date(u.joinedAt).getTime()) : '—'} @${hx(u.username || 'unknown')} <code>${u.telegramId}</code> · L${u.level || 1} · ${u.fruitCoin || 0}FC · 📺${u.totalAdsWatched || 0}` +
        `${u.referredBy ? ` · ref <code>${hx(u.referredBy)}</code>` : ''}${u.signupIp ? ` · ${hx(u.signupIp)}` : ''}`);
      const nav = [];
      if (page > 0) nav.push({ text: '◀️ Prev', callback_data: `sb_page_${cid}_${page - 1}` });
      if ((page + 1) * per < rows.length) nav.push({ text: 'Next ▶️', callback_data: `sb_page_${cid}_${page + 1}` });
      const kb = [];
      if (nav.length) kb.push(nav);
      kb.push([{ text: `🔒 Lock all ${ids.length}`, callback_data: `sb_lock_${cid}` }, { text: `🚫 Ban all ${ids.length}`, callback_data: `sb_banask_${cid}` }]);
      kb.push([{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]);
      await send(chatId,
        `👁 <b>Accounts of this burst</b> — ${page * per + 1}–${page * per + slice.length} of ${rows.length}\n<i>time (Dhaka) · name · ID · level · FC · ads · referrer · IP</i>\n\n${lines.join('\n') || '—'}`,
        { reply_markup: { inline_keyboard: kb } });
      return true;
    }
    if (act === 'lock') {
      const n = await lockMany(ids, 'signup_burst');
      await send(chatId, `🔒 Locked <b>${n}</b> of ${ids.length} accounts.\nThey cannot withdraw and earn no referral rewards; the app still opens. If some are real people, tap ✅ Real users — unlock on the burst.`, { reply_markup: backKb });
      return true;
    }
    if (act === 'clear') {
      const n = await unlockMany(ids, 'signup_burst');
      await send(chatId, `✅ Unlocked <b>${n}</b> account(s) that were locked as a signup burst.`, { reply_markup: backKb });
      return true;
    }
    if (act === 'banask') {
      await edit(chatId, msgId,
        `⚠️ <b>Ban ${ids.length} accounts for good?</b>\n\n` +
          `• They can never sign up again (permanent ban record)\n• Their pending withdrawals are cancelled (no refund)\n• This cannot be undone\n\n` +
          `Open 👁 Members first if you are not sure — a real person among them would be banned too.\n\n<i>This confirmation expires in 2 minutes.</i>`,
        { reply_markup: { inline_keyboard: [
          [{ text: '❌ No, cancel', callback_data: `sb_view_${cid}` }],
          [{ text: `✅ Yes, ban all ${ids.length}`, callback_data: `sb_banok_${cid}_${tsNow36()}` }],
        ] } });
      return true;
    }
    if (act === 'banok') {
      if (!tsFresh(arg)) { await edit(chatId, msgId, '⌛ Confirmation expired. Open the burst again if you still want to ban.', { reply_markup: backKb }); return true; }
      const r = await banAccounts(ids, 'admin_signup_burst');
      await edit(chatId, msgId, `🚫 <b>Done.</b> ${r.banned} banned (${r.already} were already banned). ${r.cancelledWithdrawals} pending withdrawal(s) cancelled.`, { reply_markup: backKb });
      return true;
    }
    return false;
  }

  // ── Slash Scan + cluster actions ──
  if (data === 'a_slashscan') { await runSlashScan(ctx); return true; }
  if (data.startsWith('sy_')) {
    const m = /^sy_(view|lock|clear|banask|banok)_([0-9a-f]{8})(?:_([0-9a-z]+))?$/.exec(data);
    if (!m) return false;
    const [, act, cid, t36] = m;
    const cl = await slashGuard.loadCluster(cid);
    if (!cl) { await send(chatId, '⚠️ This cluster is too old (saved for 7 days) — run 🕵️ Slash Scan again.', { reply_markup: backKb }); return true; }
    const ids = cl.ids;
    if (act === 'view') {
      const usersCol = await getCollection('users');
      const rows = await usersCol.find({ telegramId: { $in: ids.flatMap((id) => idVariants(id)) } }).toArray();
      const wins = await Promise.all(rows.map((u) => getWeeklyWins(u.telegramId).catch(() => 0)));
      const lines = rows.slice(0, 25).map((u, i) =>
        `${u.banned ? '🚫' : u.accountLocked ? '🔒' : u.slashSuspect ? '🕵️' : '•'} @${hx(u.username || 'unknown')} <code>${u.telegramId}</code> · L${u.level || 1} · ${wins[i]} wins · ${u.fruitCoin || 0} FC`);
      await send(chatId,
        `👁 <b>Cluster members (${ids.length})</b>\n\n${lines.join('\n')}${rows.length > 25 ? `\n… +${rows.length - 25} more` : ''}`,
        { reply_markup: slashGuard.clusterButtons(cid, ids.length) });
      return true;
    }
    if (act === 'lock') {
      let n = 0;
      for (const id of ids) { try { if (await lockUser(id, 'bot_pattern', { botFlaggedAt: new Date() })) n++; } catch (e) { /* skip */ } }
      await slashGuard.markSuspects(ids, 'admin_cluster_lock').catch(() => {});
      await send(chatId, `🔒 Locked <b>${n}</b> of ${ids.length} accounts (no slash, ads or withdrawals; balances untouched). Unlock any of them from 🔒 Locked Accounts.`, { reply_markup: backKb });
      return true;
    }
    if (act === 'clear') {
      const usersCol = await getCollection('users');
      const rows = await usersCol.find({ telegramId: { $in: ids.flatMap((id) => idVariants(id)) } }, { projection: { telegramId: 1, accountLockedReason: 1, accountLocked: 1 } }).toArray();
      let unlocked = 0;
      for (const u of rows) { if (u.accountLocked && u.accountLockedReason === 'bot_pattern') { await unlockUser(u.telegramId); unlocked++; } }
      const cleared = await clearSlashSuspect(ids);
      await send(chatId, `✅ Flags cleared on <b>${cleared}</b> account(s); <b>${unlocked}</b> unlocked. They are eligible for prizes again.`, { reply_markup: backKb });
      return true;
    }
    if (act === 'banask') {
      await edit(chatId, msgId,
        `🚫 <b>Ban ${ids.length} accounts for good?</b>\n\n` +
          `• They can never sign up again (permanent ban record)\n• Their pending withdrawals are cancelled (no refund)\n• This cannot be undone\n\n` +
          `Check 👁 Members first if you are not sure — a real player in this list would be banned too.\n\n<i>This confirmation expires in 2 minutes.</i>`,
        { reply_markup: { inline_keyboard: [
          [{ text: '❌ No, cancel', callback_data: `sy_view_${cid}` }],
          [{ text: `✅ Yes, ban all ${ids.length}`, callback_data: `sy_banok_${cid}_${tsNow36()}` }],
        ] } });
      return true;
    }
    if (act === 'banok') {
      if (!tsFresh(t36)) { await edit(chatId, msgId, '⌛ Confirmation expired. Open the cluster again if you still want to ban.', { reply_markup: backKb }); return true; }
      const r = await banAccounts(ids, 'admin_slash_farm');
      await edit(chatId, msgId, `🚫 <b>Done.</b> ${r.banned} banned (${r.already} were already banned). ${r.cancelledWithdrawals} pending withdrawal(s) cancelled.`, { reply_markup: backKb });
      return true;
    }
    return false;
  }

  // ── Referral report + "ban fake referrals" (always asks first) ──
  if (data.startsWith('lk_refs_')) {
    const id = data.slice(8);
    const rep = await referralReport(id);
    const rows = [];
    if (rep.count) {
      rows.push([{ text: `🚫 Ban the ${rep.count - rep.banned} referral(s) only`, callback_data: `lk_rbanask_${id}_r` }]);
      rows.push([{ text: `🚫 Ban user + ${rep.count - rep.banned} referral(s)`, callback_data: `lk_rbanask_${id}_u` }]);
    }
    rows.push([{ text: '👤 Profile', callback_data: `lk_profile_${id}` }, { text: '◀️ Menu', callback_data: 'a_menu' }]);
    await send(chatId, rep.text, { reply_markup: { inline_keyboard: rows } });
    return true;
  }
  if (data.startsWith('lk_rbanask_')) {
    const m = /^lk_rbanask_(.+)_([ru])$/.exec(data);
    if (!m) return false;
    const [, id, mode] = m;
    const refs = (await getReferrals(id)).filter((r) => !r.banned);
    const act = await activity7d(refs.map((r) => r.telegramId));
    const activeCnt = refs.filter((r) => { const a = act.get(String(r.telegramId)); return a && a.ads + a.tasks + a.slashes > 0; }).length;
    const total = refs.length + (mode === 'u' ? 1 : 0);
    await edit(chatId, msgId,
      `⚠️ <b>Are you sure?</b>\n\n` +
        (mode === 'u' ? `You are about to ban <b>user <code>${hx(id)}</code></b> AND <b>${refs.length}</b> of their referrals (${total} accounts).\n\n` : `You are about to ban <b>${refs.length}</b> referral accounts of <code>${hx(id)}</code>. The user themself stays.\n\n`) +
        (activeCnt ? `🟡 <b>${activeCnt}</b> of these referrals were ACTIVE in the last 7 days — they may be real people.\n\n` : `🔴 None of them did anything in the last 7 days.\n\n`) +
        `• Permanent ban (they can never sign up again)\n• Their pending withdrawals are cancelled (no refund)\n• This cannot be undone\n\n<i>This confirmation expires in 2 minutes.</i>`,
      { reply_markup: { inline_keyboard: [
        [{ text: '❌ No, go back', callback_data: `lk_refs_${id}` }],
        [{ text: `✅ Yes, ban ${total} account(s)`, callback_data: `lk_rbanok_${id}_${mode}_${tsNow36()}` }],
      ] } });
    return true;
  }
  if (data.startsWith('lk_rbanok_')) {
    const m = /^lk_rbanok_(.+)_([ru])_([0-9a-z]+)$/.exec(data);
    if (!m) return false;
    const [, id, mode, t36] = m;
    if (!tsFresh(t36)) { await edit(chatId, msgId, '⌛ Confirmation expired. Open the referral report again if you still want to ban.', { reply_markup: backKb }); return true; }
    const refs = (await getReferrals(id)).filter((r) => !r.banned);
    const targets = refs.map((r) => String(r.telegramId));
    if (mode === 'u') targets.push(String(id));
    const r = await banAccounts(targets, mode === 'u' ? 'admin_fake_referral_ring' : 'admin_fake_referrals');
    await edit(chatId, msgId,
      `🚫 <b>Done.</b> ${r.banned} account(s) banned${mode === 'u' ? ' (including the referrer)' : ''}. ${r.cancelledWithdrawals} pending withdrawal(s) cancelled.`,
      { reply_markup: backKb });
    return true;
  }

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
