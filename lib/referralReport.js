// lib/referralReport.js
// Admin tools for a withdrawal request: list the user's referrals (with each one's ads in the last 7 days),
// and find everyone who must be banned together with a cheater.

const { getCollection, idVariants } = require('./db');
const { getLevelForXp } = require('./levelSystem');

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n = (v) => Number(v || 0).toLocaleString('en-US');
const DAY = 86400000;

function ago(d) {
  if (!d) return '—';
  const ms = Date.now() - new Date(d).getTime();
  if (!(ms >= 0)) return '—';
  const h = Math.floor(ms / 3600000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60000))}m`;
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// All users directly invited by `telegramId`.
async function getReferrals(telegramId) {
  const usersCol = await getCollection('users');
  return usersCol.find(
    { referredBy: { $in: [...idVariants(telegramId), ...idVariants(telegramId).map(String)] } },
    { projection: { telegramId: 1, username: 1, firstName: 1, xp: 1, joinedAt: 1, totalAdsWatched: 1, referralCount: 1, fruitCoin: 1, banned: 1, signupIp: 1, completedTasks: 1, totalSlices: 1, accountLocked: 1 } }
  ).toArray();
}

// Cheap live count (profile screen) — counts everybody who signed up through this user's link.
async function countReferrals(telegramId) {
  const usersCol = await getCollection('users');
  const v = [...idVariants(telegramId), ...idVariants(telegramId).map(String)];
  return usersCol.countDocuments({ referredBy: { $in: v } });
}

// What each id did in the last 7 days: { ads, tasks, slashes }. (transactions are kept 14 days, slashLog 7.)
async function activity7d(ids) {
  const out = new Map();
  const get = (id) => { const k = String(id); if (!out.has(k)) out.set(k, { ads: 0, tasks: 0, slashes: 0 }); return out.get(k); };
  if (!ids.length) return out;
  const since = new Date(Date.now() - 7 * DAY);
  try {
    const txCol = await getCollection('transactions');
    const rows = await txCol.aggregate([
      { $match: { type: { $in: ['ad_reward', 'task_reward'] }, telegramId: { $in: ids }, createdAt: { $gte: since } } },
      { $group: { _id: { id: '$telegramId', t: '$type' }, c: { $sum: 1 } } },
    ]).toArray();
    for (const r of rows) get(r._id.id)[r._id.t === 'ad_reward' ? 'ads' : 'tasks'] += r.c;
  } catch (e) { /* report just shows 0 */ }
  try {
    const logCol = await getCollection('slashLog');
    const rows = await logCol.aggregate([
      { $match: { telegramId: { $in: ids }, createdAt: { $gte: since } } },
      { $group: { _id: '$telegramId', c: { $sum: 1 } } },
    ]).toArray();
    for (const r of rows) get(r._id).slashes += r.c;
  } catch (e) { /* report just shows 0 */ }
  return out;
}

// Ads watched in the last 7 days, per user (kept for older callers).
async function ads7d(ids) {
  const m = await activity7d(ids);
  const out = new Map();
  for (const [k, v] of m) out.set(k, v.ads);
  return out;
}

// Returns { text, count, banned, active, inactive, dead } — HTML text (kept under Telegram's 4096 limit).
// Per referral: ads 7d/all, tasks 7d, slashes 7d, how many people THEY referred, how long ago they joined.
async function referralReport(telegramId) {
  const refs = await getReferrals(telegramId);
  if (!refs.length) return { text: '👥 <b>Referrals</b>\n\nThis user has no referrals.', count: 0, banned: 0, active: 0, inactive: 0, dead: 0 };

  const ids = refs.map((r) => r.telegramId);
  const act = await activity7d(ids);
  const rows = refs.map((r) => {
    const a = act.get(String(r.telegramId)) || { ads: 0, tasks: 0, slashes: 0 };
    const active = a.ads + a.tasks + a.slashes > 0;
    const dead = !(r.totalAdsWatched > 0) && !(r.totalSlices > 0) && !((r.completedTasks || []).length > 0); // never did anything, ever
    return { r, a, active, dead };
  });
  // least active first: those are the ones worth a look
  rows.sort((x, y) => (x.dead - y.dead) * -1 || (x.active - y.active) || ((x.a.ads + x.a.tasks + x.a.slashes) - (y.a.ads + y.a.tasks + y.a.slashes)));

  const joined7 = refs.filter((r) => r.joinedAt && Date.now() - new Date(r.joinedAt).getTime() < 7 * DAY).length;
  const bannedCnt = refs.filter((r) => r.banned).length;
  // already-banned referrals are listed but never counted as active / inactive / dead
  const live = rows.filter((x) => !x.r.banned);
  const activeCnt = live.filter((x) => x.active).length;
  const deadCnt = live.filter((x) => x.dead).length;
  const inactiveCnt = live.length - activeCnt;
  const tot = live.reduce((s2, x) => ({ ads: s2.ads + x.a.ads, tasks: s2.tasks + x.a.tasks, slashes: s2.slashes + x.a.slashes }), { ads: 0, tasks: 0, slashes: 0 });
  const sameIp = new Map();
  for (const r of refs) if (r.signupIp) sameIp.set(r.signupIp, (sameIp.get(r.signupIp) || 0) + 1);
  const bigIp = [...sameIp.values()].filter((c) => c >= 3).reduce((s2, c) => s2 + c, 0);

  const pctInactive = live.length ? Math.round((100 * inactiveCnt) / live.length) : 0;
  const verdict = pctInactive >= 70 ? '🔴 Most referrals did NOTHING this week — looks fake / farmed'
    : pctInactive >= 40 ? '🟡 Many referrals are inactive — check before paying'
    : '🟢 Most referrals are active';

  let head =
    `👥 <b>Referrals of <code>${esc(telegramId)}</code></b> — last 7 days\n` +
    `Total: <b>${n(refs.length)}</b> · joined last 7d: <b>${n(joined7)}</b> · already banned: ${n(bannedCnt)}\n` +
    `✅ Active: <b>${n(activeCnt)}</b> · 💤 Inactive: <b>${n(inactiveCnt)}</b> (${pctInactive}%) · 💀 Never did anything: <b>${n(deadCnt)}</b>\n` +
    `Together they did: 📺 <b>${n(tot.ads)}</b> ads · ✅ <b>${n(tot.tasks)}</b> tasks · 🔪 <b>${n(tot.slashes)}</b> slashes\n` +
    (bigIp ? `🌐 ${n(bigIp)} of them share a signup IP with 2+ other referrals\n` : '') +
    `${verdict}\n\n<i>📺 ads 7d/all · ✅ tasks 7d · 🔪 slashes 7d · 👥 their referrals · joined — least active first</i>\n`;
  const lines = [];
  let len = head.length;
  let shown = 0;
  for (const { r, a, active, dead } of rows) {
    const name = r.username ? '@' + esc(r.username) : esc(r.firstName || r.telegramId);
    const mark = r.banned ? '🚫' : dead ? '💀' : active ? '•' : '💤';
    const line = `${mark} ${name} · L${getLevelForXp(r.xp || 0)} · 📺${n(a.ads)}/${n(r.totalAdsWatched)} · ✅${n(a.tasks)} · 🔪${n(a.slashes)} · 👥${n(r.referralCount)} · ${ago(r.joinedAt)}`;
    if (len + line.length + 1 > 3700) break;
    lines.push(line); len += line.length + 1; shown++;
  }
  if (shown < rows.length) lines.push(`… +${rows.length - shown} more`);
  return { text: head + lines.join('\n'), count: refs.length, banned: bannedCnt, active: activeCnt, inactive: inactiveCnt, dead: deadCnt };
}

module.exports = { getReferrals, countReferrals, activity7d, referralReport };
