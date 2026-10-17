// lib/ttlIndexes.js — TTL (auto-cleanup) system, ported from NewTube's setup-indexes and
// extended. MongoDB deletes expired documents by itself (a background job runs about once a
// minute), so the free-tier database never fills up with old data.
//
// Run it from the admin bot: 🧹 Auto-Cleanup (TTL) -> Run setup. It is safe to run again any time
// (creating an index that already exists does nothing).
//
// Already configured elsewhere (listed in the status screen, not touched here):
//   adSessions, adPuzzles, dailyLimits, postbackEvents(3d), leaderboard, referralLeaderboard,
//   slashLog(7d), slashSessions, recentWinners, promoCodes, adminState(1h).

const { getCollection, connectToDatabase } = require('./db');
const { registerBan } = require('./lockup');

const DAY = 86400;

// Dead-account cleanup only removes SMALL idle accounts, so nobody loses real balance.
const DEAD_ACCOUNT_DAYS = 90;
const DEAD_ACCOUNT_MAX_FC = 1000;
const BANNED_USER_DAYS = 60;

// { collection, name, keys, options, label }
const SPECS = [
  { collection: 'gamePlays', name: 'ttl_gamePlays_lastPing', keys: { lastPingAt: 1 }, options: { expireAfterSeconds: 30 * DAY }, label: 'Game play timers — 30 days' },
  { collection: 'wdProfileHistory', name: 'ttl_wdProfileHistory_expire', keys: { expireAt: 1 }, options: { expireAfterSeconds: 0 }, label: 'Closed withdraw-detail periods — deleted 30 days after the withdrawal was approved' },
  { collection: 'wdProfiles', name: 'ttl_wdProfiles_lastAt', keys: { lastAt: 1 }, options: { expireAfterSeconds: 120 * DAY }, label: 'Live withdraw-detail records of users idle for 120 days' },
  { collection: 'channelPosts', name: 'ttl_channelPosts_created', keys: { createdAt: 1 }, options: { expireAfterSeconds: 90 * DAY }, label: 'Channel post history — 90 days' },
  { collection: 'processedAdEvents', name: 'ttl_processedAdEvents_created', keys: { createdAt: 1 }, options: { expireAfterSeconds: 2 * DAY }, label: 'Ad duplicate-guard records — 2 days' },
  { collection: 'ipSignupVelocity', name: 'ttl_ipSignupVelocity_updated', keys: { updatedAt: 1 }, options: { expireAfterSeconds: 1 * DAY }, label: 'IP signup velocity counters — 1 day' },
  { collection: 'transactions', name: 'ttl_transactions_created', keys: { createdAt: 1 }, options: { expireAfterSeconds: 14 * DAY }, label: 'Transaction history — 14 days (biggest collection; nothing in the app reads old ones)' },
  { collection: 'devices', name: 'ttl_devices_lastSeen', keys: { lastSeenAt: 1 }, options: { expireAfterSeconds: 180 * DAY }, label: 'Device records (active owners stay fresh) — 180 days' },
  { collection: 'withdrawals', name: 'ttl_withdrawals_rejected', keys: { processedAt: 1 }, options: { expireAfterSeconds: 90 * DAY, partialFilterExpression: { status: 'rejected' } }, label: 'REJECTED withdrawals only — 90 days (approved ones are kept forever as proof)' },
  { collection: 'gifts', name: 'ttl_gifts_claimed', keys: { claimedAt: 1 }, options: { expireAfterSeconds: 30 * DAY, partialFilterExpression: { status: 'claimed' } }, label: 'CLAIMED gifts only — 30 days' },
  { collection: 'users', name: 'ttl_users_banned', keys: { bannedAt: 1 }, options: { expireAfterSeconds: BANNED_USER_DAYS * DAY, partialFilterExpression: { banned: true } }, label: `Banned users — ${BANNED_USER_DAYS} days after ban (the ban itself is kept forever in bannedRegistry)` },
  { collection: 'users', name: 'ttl_users_dead', keys: { lastActive: 1 }, options: { expireAfterSeconds: DEAD_ACCOUNT_DAYS * DAY, partialFilterExpression: { fruitCoin: { $lt: DEAD_ACCOUNT_MAX_FC } } }, label: `Dead accounts — ${DEAD_ACCOUNT_DAYS} days inactive AND under ${DEAD_ACCOUNT_MAX_FC} FC` },
];

const ELSEWHERE = [
  'adSessions / adPuzzles — auto-expire after a few minutes',
  'dailyLimits, leaderboard, referralLeaderboard — expire with their day/week',
  'postbackEvents — 3 days · slashLog — 7 days · adminState — 1 hour',
  'promoCodes — removed when the code expires',
];

async function setupTtlIndexes() {
  const results = [];

  // Backfill: banned users that have no bannedAt yet get one now (so they expire in 60 days)
  // and are written to the permanent ban registry FIRST, so the ban survives the deletion.
  try {
    const usersCol = await getCollection('users');
    const unstamped = await usersCol.find({ banned: true, bannedAt: { $exists: false } }, { projection: { telegramId: 1, bannedReason: 1 } }).toArray();
    for (const u of unstamped) await registerBan(u.telegramId, u.bannedReason || 'admin_manual');
    if (unstamped.length) await usersCol.updateMany({ banned: true, bannedAt: { $exists: false } }, { $set: { bannedAt: new Date() } });
    results.push({ name: 'backfill banned users', ok: true, note: `${unstamped.length} ban(s) saved to the registry` });
  } catch (e) { results.push({ name: 'backfill banned users', ok: false, error: e.message }); }

  for (const s of SPECS) {
    try {
      const col = await getCollection(s.collection);
      try {
        await col.createIndex(s.keys, { name: s.name, ...s.options });
      } catch (e) {
        // Same index name already exists with an OLD time limit (e.g. transactions was 180 days):
        // change the limit in place instead of failing.
        if (e && (e.code === 85 || e.code === 86 || /already exists|different options/i.test(String(e.message)))) {
          const db = await connectToDatabase();
          await db.command({ collMod: s.collection, index: { name: s.name, expireAfterSeconds: s.options.expireAfterSeconds } });
        } else { throw e; }
      }
      results.push({ name: s.name, ok: true, label: s.label });
    } catch (e) {
      results.push({ name: s.name, ok: false, label: s.label, error: String(e.message || e).slice(0, 120) });
    }
  }
  return results;
}

// -> [{ label, present }]
async function ttlStatus() {
  const out = [];
  const cache = {};
  for (const s of SPECS) {
    let present = false;
    try {
      if (!cache[s.collection]) cache[s.collection] = await (await getCollection(s.collection)).indexes();
      present = cache[s.collection].some((i) => i.name === s.name && i.expireAfterSeconds === s.options.expireAfterSeconds);
    } catch (e) { present = false; }
    out.push({ label: s.label, present });
  }
  return out;
}

// How many documents the FIRST run would delete right away (MongoDB removes everything that is
// already older than the limit as soon as the index exists). Shown to the admin before they confirm.
async function previewImmediateDeletes() {
  const out = [];
  for (const s of SPECS) {
    try {
      const col = await getCollection(s.collection);
      const field = Object.keys(s.keys)[0];
      const cutoff = new Date(Date.now() - s.options.expireAfterSeconds * 1000);
      const filter = { [field]: { $lt: cutoff }, ...(s.options.partialFilterExpression || {}) };
      out.push({ label: s.label, collection: s.collection, count: await col.countDocuments(filter) });
    } catch (e) { out.push({ label: s.label, collection: s.collection, count: null }); }
  }
  return out;
}

module.exports = { setupTtlIndexes, ttlStatus, previewImmediateDeletes, SPECS, ELSEWHERE };
