// lib/signupBursts.js — "many accounts created at the same time" detector (added 2026-10-18).
//
// A farm creates dozens of accounts in a few minutes (the Telegram group screenshot: hundreds of
// members whose "last seen" is the exact same minute). This module finds those groups in the
// app's own sign-ups, whatever IP or referrer they use:
//
//   BURST  = a run of new accounts where each one joined within SIGNUP_BURST_GAP_S (60 s) of the
//            previous one, at least SIGNUP_BURST_MIN (8) accounts, cut into pieces of max 10 minutes.
//   SIGNALS (to tell a farm from a real viral spike): same IP, same referrer, accounts that never did
//            anything. The admin sees the signals + a verdict (🔴 / 🟡 / 🟢) and decides.
//
//   Live alert  : when 10+ accounts joined in the last 5 minutes the admin gets ONE message (max every
//                 15 minutes) with a button that opens the list (admin bot: 🆕 Signup Bursts).
//   Admin panel : lists the bursts of the last 1 h / 24 h / 7 days with ID + data of every account and
//                 Lock all / Ban all (with "are you sure?") buttons — see lib/adminSecurity.js (sb_*).
//
// Tunable from Vercel env: SIGNUP_BURST_GAP_S, SIGNUP_BURST_MIN, SIGNUP_BURST_LIVE_MIN.

const { getCollection } = require('./db');
const { notifyAdmin } = require('./notify');

const numEnv = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const CFG = {
  GAP_MS: numEnv('SIGNUP_BURST_GAP_S', 60) * 1000,
  MIN: numEnv('SIGNUP_BURST_MIN', 8),
  MAX_SPAN_MS: 10 * 60 * 1000,
  LIVE_WINDOW_MS: 5 * 60 * 1000,
  LIVE_MIN: numEnv('SIGNUP_BURST_LIVE_MIN', 10),
  ALERT_COOLDOWN_MS: 15 * 60 * 1000,
};

// PURE. rows = [{ id, t(ms) }] -> [{ ids, start, end, size }] (bursts only, biggest first)
function findBursts(rows, opts = {}) {
  const gap = opts.gapMs || CFG.GAP_MS;
  const min = opts.min || CFG.MIN;
  const maxSpan = opts.maxSpanMs || CFG.MAX_SPAN_MS;
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length >= min) out.push({ ids: cur.map((x) => String(x.id)), start: cur[0].t, end: cur[cur.length - 1].t, size: cur.length }); cur = []; };
  for (const r of sorted) {
    if (cur.length && (r.t - cur[cur.length - 1].t > gap || r.t - cur[0].t > maxSpan)) flush();
    cur.push(r);
  }
  flush();
  return out.sort((a, b) => b.size - a.size);
}

const neverActive = (u) => !(u.totalAdsWatched > 0) && !(u.totalSlices > 0) && !((u.completedTasks || []).length > 0);

// PURE. users = full-ish user docs of ONE burst -> signals + verdict.
function analyzeBurst(users) {
  const n = users.length || 1;
  const count = (key) => { const m = new Map(); for (const u of users) { const v = u[key]; if (v) m.set(String(v), (m.get(String(v)) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0]; };
  const [topIp, ipN] = count('signupIp');
  const [topRef, refN] = count('referredBy');
  const dead = users.filter(neverActive).length;
  const banned = users.filter((u) => u.banned).length;
  const locked = users.filter((u) => u.accountLocked).length;
  const ipShare = ipN / n, refShare = refN / n, deadShare = dead / n;
  const score = (ipShare >= 0.5 ? 2 : ipShare >= 0.25 ? 1 : 0) + (refShare >= 0.6 ? 2 : refShare >= 0.3 ? 1 : 0) + (deadShare >= 0.7 ? 2 : deadShare >= 0.4 ? 1 : 0);
  const verdict = score >= 4 ? '🔴 Looks like a farm' : score >= 2 ? '🟡 Suspicious — check members' : '🟢 Could be a real spike';
  return { topIp, ipN, topRef, refN, dead, banned, locked, score, verdict, ipShare, refShare, deadShare };
}

// Scans the last `hours` of sign-ups. -> { total, bursts:[{ids,start,end,size,info}] }
async function scanBursts(hours = 24) {
  const usersCol = await getCollection('users');
  const since = new Date(Date.now() - hours * 3600 * 1000);
  const docs = await usersCol.find(
    { joinedAt: { $gte: since } },
    { projection: { telegramId: 1, joinedAt: 1, signupIp: 1, referredBy: 1, totalAdsWatched: 1, totalSlices: 1, completedTasks: 1, banned: 1, accountLocked: 1 } }
  ).limit(30000).toArray();
  const rows = docs.map((d) => ({ id: String(d.telegramId), t: new Date(d.joinedAt).getTime() }));
  const bursts = findBursts(rows);
  const byId = new Map(docs.map((d) => [String(d.telegramId), d]));
  for (const b of bursts) {
    let members = b.ids.map((id) => byId.get(id)).filter(Boolean);
    let info = analyzeBurst(members);
    // Bystander protection: when most of the burst shares one IP or one referrer, an account that matches
    // NEITHER and has really used the app is almost certainly a real person who just happened to sign up
    // at the same minute — it is left out of the list, so Lock all / Ban all can never hit it.
    if (info.ipShare >= 0.5 || info.refShare >= 0.5) {
      const bystanders = members.filter((u) => !(info.topIp && String(u.signupIp) === info.topIp) && !(info.topRef && String(u.referredBy) === info.topRef) && !neverActive(u));
      if (bystanders.length) {
        const drop = new Set(bystanders.map((u) => String(u.telegramId)));
        b.ids = b.ids.filter((id) => !drop.has(id));
        members = members.filter((u) => !drop.has(String(u.telegramId)));
        b.size = b.ids.length;
        info = analyzeBurst(members);
        info.bystanders = bystanders.length;
      }
    }
    b.info = info;
  }
  bursts.sort((a, b) => b.size - a.size);
  return { total: docs.length, bursts };
}

// Called right after a new account was created. Never throws, never slows signup noticeably.
async function checkSignupBurst() {
  try {
    const usersCol = await getCollection('users');
    const n = await usersCol.countDocuments({ joinedAt: { $gte: new Date(Date.now() - CFG.LIVE_WINDOW_MS) } });
    if (n < CFG.LIVE_MIN) return;
    const col = await getCollection('burstAlerts');
    const now = new Date();
    try {
      // only one request per cooldown wins this update; the others hit a duplicate key and stay silent
      const r = await col.updateOne(
        { _id: 'live', $or: [{ lastAt: { $exists: false } }, { lastAt: { $lt: new Date(now.getTime() - CFG.ALERT_COOLDOWN_MS) } }] },
        { $set: { lastAt: now, lastCount: n } },
        { upsert: true }
      );
      if (!r.modifiedCount && !r.upsertedCount) return;
    } catch (e) { return; }
    notifyAdmin(
      `🆕 <b>Many new accounts at once</b>\n\n<b>${n}</b> accounts joined in the last ${CFG.LIVE_WINDOW_MS / 60000} minutes.\n` +
        `A real viral post can do this — a farm script does too. Open the list to see the IDs, their data, and whether they share an IP / referrer.`,
      { reply_markup: { inline_keyboard: [[{ text: '📋 Open Signup Bursts', callback_data: 'a_signups' }]] } }
    ).catch(() => {});
  } catch (e) { console.error('checkSignupBurst failed (ignored):', e); }
}

module.exports = { CFG, findBursts, analyzeBurst, scanBursts, checkSignupBurst };
