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
    { projection: { telegramId: 1, username: 1, firstName: 1, xp: 1, joinedAt: 1, totalAdsWatched: 1, referralCount: 1, fruitCoin: 1, banned: 1, signupIp: 1 } }
  ).toArray();
}

// Ads watched in the last 7 days, per user (transactions are kept 14 days).
async function ads7d(ids) {
  const out = new Map();
  if (!ids.length) return out;
  try {
    const txCol = await getCollection('transactions');
    const rows = await txCol.aggregate([
      { $match: { type: 'ad_reward', telegramId: { $in: ids }, createdAt: { $gte: new Date(Date.now() - 7 * DAY) } } },
      { $group: { _id: '$telegramId', c: { $sum: 1 } } },
    ]).toArray();
    for (const r of rows) out.set(String(r._id), r.c);
  } catch (e) { /* report just shows 0 */ }
  return out;
}

// Returns { text, count, banned } — HTML text (kept under Telegram's 4096 limit).
async function referralReport(telegramId) {
  const refs = await getReferrals(telegramId);
  if (!refs.length) return { text: '👥 <b>Referrals</b>\n\nThis user has no referrals.', count: 0, banned: 0 };

  const ids = refs.map((r) => r.telegramId);
  const adMap = await ads7d(ids);
  const rows = refs.map((r) => ({ r, a7: adMap.get(String(r.telegramId)) || 0 }));
  rows.sort((x, y) => y.a7 - x.a7 || (y.r.totalAdsWatched || 0) - (x.r.totalAdsWatched || 0));

  const joined7 = refs.filter((r) => r.joinedAt && Date.now() - new Date(r.joinedAt).getTime() < 7 * DAY).length;
  const bannedCnt = refs.filter((r) => r.banned).length;
  const total7 = rows.reduce((s, x) => s + x.a7, 0);
  const sameIp = new Map();
  for (const r of refs) if (r.signupIp) sameIp.set(r.signupIp, (sameIp.get(r.signupIp) || 0) + 1);
  const bigIp = [...sameIp.values()].filter((c) => c >= 3).reduce((s, c) => s + c, 0);

  let head =
    `👥 <b>Referrals of <code>${esc(telegramId)}</code></b>\n` +
    `Total: <b>${n(refs.length)}</b> · joined last 7d: <b>${n(joined7)}</b> · already banned: ${n(bannedCnt)}\n` +
    `Ads watched by them in last 7d: <b>${n(total7)}</b>` +
    (bigIp ? `\n🌐 ${n(bigIp)} of them share a signup IP with 2+ other referrals` : '') +
    `\n\n<i>name · Lv · ads 7d / all · their referrals · joined</i>\n`;
  const lines = [];
  let len = head.length;
  let shown = 0;
  for (const { r, a7 } of rows) {
    const name = r.username ? '@' + esc(r.username) : esc(r.firstName || r.telegramId);
    const line = `${r.banned ? '🚫' : '•'} ${name} · L${getLevelForXp(r.xp || 0)} · ${n(a7)}/${n(r.totalAdsWatched)} · 👥${n(r.referralCount)} · ${ago(r.joinedAt)}`;
    if (len + line.length + 1 > 3700) break;
    lines.push(line); len += line.length + 1; shown++;
  }
  if (shown < rows.length) lines.push(`… +${rows.length - shown} more (sorted by most ads in 7d)`);
  return { text: head + lines.join('\n'), count: refs.length, banned: bannedCnt };
}

module.exports = { getReferrals, referralReport };
