// lib/publicStats.js — the "community stats" card at the bottom of the Player Profile (added 2026-10-19).
//
//   totalUsers   everybody who joined the mini app (banned accounts are NOT counted)
//   activeToday  users who opened the app in the last 24 hours
//   payoutMonth  USDT paid out since the 1st of the CURRENT calendar month (UTC), resets on the 1st
//   payoutPrev   same for the previous calendar month, so people can compare
//
// Only totals leave the server — never a name, ID or single withdrawal.
// The numbers are cached for 5 minutes (in the database, shared by every serverless instance, plus 60 s
// in memory), so thousands of people opening their profile cost the database ONE small query set per 5 minutes.

const { getCollection } = require('./db');

const DB_TTL_MS = 5 * 60 * 1000;
const MEM_TTL_MS = 60 * 1000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

let mem = null; // { at, key, data }

// Calendar month boundaries in UTC (the same clock the weekly contest uses).
function monthBounds(now = new Date()) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  return {
    key: `${y}-${String(m + 1).padStart(2, '0')}`,
    start: new Date(Date.UTC(y, m, 1)),
    prevStart: new Date(Date.UTC(y, m - 1, 1)),
    label: `${MONTHS[m]} ${y}`,
    prevLabel: `${MONTHS[(m + 11) % 12]} ${m === 0 ? y - 1 : y}`,
  };
}

async function paidBetween(wdCol, from, to) {
  const match = { status: 'approved', $or: [{ processedAt: { $gte: from, ...(to ? { $lt: to } : {}) } }, { paidAt: { $gte: from, ...(to ? { $lt: to } : {}) } }] };
  const rows = await wdCol.aggregate([
    { $match: match },
    { $group: { _id: null, usd: { $sum: { $convert: { input: '$convertedAmount', to: 'double', onError: 0, onNull: 0 } } }, count: { $sum: 1 } } },
  ]).toArray();
  const r = rows[0] || { usd: 0, count: 0 };
  return { usd: Math.round(r.usd * 100) / 100, count: r.count };
}

async function compute(now = new Date()) {
  const usersCol = await getCollection('users');
  const wdCol = await getCollection('withdrawals');
  const mb = monthBounds(now);
  const [totalUsers, activeToday, thisMonth, prevMonth] = await Promise.all([
    usersCol.countDocuments({ banned: { $ne: true } }),
    usersCol.countDocuments({ banned: { $ne: true }, lastActive: { $gte: new Date(now.getTime() - 24 * 3600 * 1000) } }),
    paidBetween(wdCol, mb.start, null),
    paidBetween(wdCol, mb.prevStart, mb.start),
  ]);
  return {
    totalUsers,
    activeToday,
    payoutMonthUsd: thisMonth.usd,
    payoutMonthCount: thisMonth.count,
    payoutPrevUsd: prevMonth.usd,
    payoutPrevCount: prevMonth.count,
    monthLabel: mb.label,
    prevMonthLabel: mb.prevLabel,
    updatedAt: now.toISOString(),
  };
}

async function getPublicStats() {
  const now = new Date();
  const mb = monthBounds(now);
  if (mem && mem.key === mb.key && now.getTime() - mem.at < MEM_TTL_MS) return mem.data;
  const col = await getCollection('appStats');
  try {
    const doc = await col.findOne({ _id: 'public' });
    if (doc && doc.monthKey === mb.key && now.getTime() - new Date(doc.updatedAt).getTime() < DB_TTL_MS) {
      mem = { at: now.getTime(), key: mb.key, data: doc.data };
      return doc.data;
    }
  } catch (e) { /* recompute below */ }
  const data = await compute(now);
  mem = { at: now.getTime(), key: mb.key, data };
  col.updateOne({ _id: 'public' }, { $set: { data, monthKey: mb.key, updatedAt: now } }, { upsert: true }).catch(() => {});
  return data;
}

module.exports = { getPublicStats, monthBounds, compute };
