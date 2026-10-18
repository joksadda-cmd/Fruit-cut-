// lib/slashGuard.js — anti-script protection for the SLASH game (added 2026-10-18).
//
// What it catches
//   1) HAMMERING   a user (or script) that keeps sending start/claim while it is NOT allowed
//                  (still on cooldown, no / fake session, claim faster than a human can play).
//                  2 such tries within 2 min  -> 2-minute pause ("gap"), nothing else happens
//                  4 such tries within 5 min  -> account LOCKED (bot_pattern) + admin alert
//                  Expired / already-used sessions are NOT counted: a slow ad can cause those for a real person.
//   2) SAME-TIME CLUSTERS  5+ different accounts slashing within a few seconds of each other,
//                  and the SAME group doing it again and again (default 3 rounds). A farm that runs
//                  one script on many accounts can't hide from this, even with random delays per account.
//                  -> accounts are marked `slashSuspect`, the admin gets one alert with Lock / Ban buttons.
//                  (A suspect is held back from the weekly prize until the admin clears it.)
//   3) RETRO SCAN  the admin-bot button "Slash Scan" runs the same cluster logic over the last 7 days of
//                  slashLog for the current top slashers, plus "identical stats" groups (e.g. 14 accounts
//                  that all show Level 5 / 16 wins) — the pattern that was visible on the leaderboard.
//   4) PLAY-TIME METRONOME  6 rounds in a row with the same start->claim time (+-0.25s): alert only.
//
// Every number can be tuned with an env var in Vercel (no code edit needed).

const crypto = require('crypto');
const { getCollection, idVariants } = require('./db');
const { notifyAdmin } = require('./notify');
const { lockUser } = require('./lockup');

const numEnv = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };

const CFG = {
  // 1) hammering
  THROTTLE_AT: numEnv('SLASH_THROTTLE_AT', 2),
  THROTTLE_WINDOW_MS: 2 * 60 * 1000,
  THROTTLE_MS: numEnv('SLASH_THROTTLE_S', 120) * 1000,        // the "1-2 minute gap"
  LOCK_AT: numEnv('SLASH_HAMMER_LOCK_AT', 4),
  LOCK_WINDOW_MS: 5 * 60 * 1000,
  // 2) same-time clusters
  SYNC_WINDOW_MS: numEnv('SLASH_SYNC_WINDOW_S', 20) * 1000,   // "same time" = within 20 s
  SYNC_GROUP_MIN: numEnv('SLASH_SYNC_GROUP_MIN', 5),          // 5 accounts together ...
  SYNC_REPEAT: numEnv('SLASH_SYNC_REPEAT', 3),                // ... at least 3 times
  SYNC_ROUND_GAP_MS: 10 * 60 * 1000,                          // one pair counts once per 10 minutes
  SYNC_MAX_GROUP: 12,
  PAIR_RETENTION_MS: 8 * 24 * 3600 * 1000,
  // exact-interval timing (used by api/slash.js)
  PRECISION_TOLERANCE_MS: numEnv('SLASH_PRECISION_TOLERANCE_S', 60) * 1000, // claims within 60 s of the exact cooldown
  PRECISION_NOTIFY_AT: numEnv('SLASH_PRECISION_NOTIFY_AT', 3),
  PRECISION_LOCK_AT: numEnv('SLASH_PRECISION_LOCK_AT', 4),
  // 4) play-time metronome
  PLAY_SAMPLES: 6,
  PLAY_SPREAD_MS: 250,
};

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const userButtons = (id) => ({
  inline_keyboard: [
    [{ text: '🔓 Unlock', callback_data: `lk_unlock_${id}` }, { text: '👤 Profile', callback_data: `lk_profile_${id}` }],
    [{ text: '🚫 Ban', callback_data: `a_ban_${id}` }],
  ],
});
const reviewButtons = (id) => ({
  inline_keyboard: [
    [{ text: '🔒 Lock', callback_data: `lk_lock_${id}` }, { text: '👤 Profile', callback_data: `lk_profile_${id}` }],
    [{ text: '🚫 Ban', callback_data: `a_ban_${id}` }],
  ],
});

// ═══════════════ 1) HAMMERING ═══════════════
const COUNTED_SESSION_REASONS = new Set(['missing_session', 'not_found', 'mismatch', 'too_fast']);
const countsAsHammer = (reason) => reason === 'on_cooldown' || COUNTED_SESSION_REASONS.has(reason);

function throttleRemainingMs(user, now = Date.now()) {
  const t = user && user.slashThrottleUntil ? new Date(user.slashThrottleUntil).getTime() : 0;
  return Math.max(0, t - now);
}

// Pure decision: `times` = timestamps (ms) of earlier rejected tries INCLUDING this one.
function hammerDecision(times, now = Date.now()) {
  const inLock = times.filter((t) => t >= now - CFG.LOCK_WINDOW_MS).length;
  if (inLock >= CFG.LOCK_AT) return 'lock';
  const inThrottle = times.filter((t) => t >= now - CFG.THROTTLE_WINDOW_MS).length;
  if (inThrottle >= CFG.THROTTLE_AT) return 'throttle';
  return 'none';
}

// Call whenever start/claim was refused for `reason`. Never throws.
// -> { throttledUntil: Date|null, locked: boolean }
async function recordRejectedAttempt(user, reason, action = 'claim') {
  try {
    if (!countsAsHammer(reason)) return { throttledUntil: null, locked: false };
    const usersCol = await getCollection('users');
    const now = Date.now();
    const after = await usersCol.findOneAndUpdate(
      { _id: user._id },
      { $push: { slashRejects: { $each: [now], $slice: -8 } } },
      { returnDocument: 'after' }
    );
    if (!after) return { throttledUntil: null, locked: false };
    const decision = hammerDecision((after.slashRejects || []).map(Number), now);

    if (decision === 'lock') {
      const locked = await lockUser(after, 'bot_pattern', { botFlaggedAt: new Date() });
      if (locked) {
        notifyAdmin(
          `🤖 <b>Slash script suspected — account LOCKED</b>\n\n` +
            `User <code>${esc(after.telegramId)}</code> (@${esc(after.username || 'unknown')}) sent <b>${CFG.LOCK_AT}+</b> refused ` +
            `slash requests within ${CFG.LOCK_WINDOW_MS / 60000} minutes (last: <b>${esc(action)}</b> → <b>${esc(reason)}</b>).\n` +
            `A real player's app never does this.\n\nThe account is 🔒 locked (no slash, ads, withdrawals). Balance is untouched.`,
          { reply_markup: userButtons(after.telegramId) }
        ).catch(() => {});
      }
      return { throttledUntil: null, locked: true };
    }
    if (decision === 'throttle') {
      const until = new Date(now + CFG.THROTTLE_MS);
      await usersCol.updateOne({ _id: after._id }, { $set: { slashThrottleUntil: until } });
      return { throttledUntil: until, locked: false };
    }
    return { throttledUntil: null, locked: false };
  } catch (e) {
    console.error('recordRejectedAttempt failed (ignored):', e);
    return { throttledUntil: null, locked: false };
  }
}

// ═══════════════ 4) PLAY-TIME METRONOME (alert only) ═══════════════
function playMetronome(samples) {
  if (!Array.isArray(samples) || samples.length < CFG.PLAY_SAMPLES) return false;
  const last = samples.slice(-CFG.PLAY_SAMPLES).map(Number);
  return Math.max(...last) - Math.min(...last) <= CFG.PLAY_SPREAD_MS;
}
async function checkPlayTime(user) {
  try {
    if (!playMetronome(user.slashPlay)) return;
    const usersCol = await getCollection('users');
    const mark = await usersCol.updateOne(
      { _id: user._id, $or: [{ slashPlayFlagAt: { $exists: false } }, { slashPlayFlagAt: { $lt: new Date(Date.now() - 24 * 3600 * 1000) } }] },
      { $set: { slashPlayFlagAt: new Date() } }
    );
    if (mark.modifiedCount > 0) {
      const ms = (user.slashPlay || []).slice(-CFG.PLAY_SAMPLES).map((x) => `${(x / 1000).toFixed(2)}s`).join(', ');
      notifyAdmin(
        `⚠️ <b>Slash play-time metronome — NOT locked</b>\n\nUser <code>${esc(user.telegramId)}</code> (@${esc(user.username || 'unknown')})\n` +
          `Last ${CFG.PLAY_SAMPLES} rounds took exactly the same time from start to claim: ${ms}\nHumans never repeat this precisely. Nothing was blocked.`,
        { reply_markup: reviewButtons(user.telegramId) }
      ).catch(() => {});
    }
  } catch (e) { console.error('checkPlayTime failed (ignored):', e); }
}

// ═══════════════ 2/3) SAME-TIME CLUSTERS ═══════════════
const pairKey = (a, b) => (String(a) < String(b) ? `${a}|${b}` : `${b}|${a}`);
const sortedPair = (a, b) => (String(a) < String(b) ? [String(a), String(b)] : [String(b), String(a)]);

// Union-find: connected groups of ids joined by `edges` ([a, b] pairs).
function components(edges) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const [a, b] of edges) {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  }
  const groups = new Map();
  for (const id of parent.keys()) { const r = find(id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(id); }
  return [...groups.values()];
}

// PURE. claims = [{ id, t(ms) }]. Splits the timeline into "rounds" (accounts that claimed within `windowMs`
// of the round's first claim); in every round with enough different accounts, all pairs get +1.
// Accounts that repeatedly appear together form a cluster.
function findClusters(claims, opts = {}) {
  const windowMs = opts.windowMs || CFG.SYNC_WINDOW_MS;
  const groupMin = opts.groupMin || CFG.SYNC_GROUP_MIN;
  const repeat = opts.repeat || CFG.SYNC_REPEAT;
  const sorted = [...claims].sort((x, y) => x.t - y.t);
  const pairs = new Map(); // key -> { a, b, rounds, last }
  // Sliding window: every claim is tried as the start of a window, so one unrelated claim can never cut a real
  // group in half. A pair is counted at most once per SYNC_ROUND_GAP_MS (the same pair cannot slash twice inside one cooldown).
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i].t;
    const members = new Set();
    for (let j = i; j < sorted.length && sorted[j].t <= start + windowMs; j++) members.add(String(sorted[j].id));
    if (members.size < groupMin) continue;
    const ids = [...members].sort().slice(0, 40);
    for (let x = 0; x < ids.length; x++) for (let y = x + 1; y < ids.length; y++) {
      const k = `${ids[x]}|${ids[y]}`;
      const p = pairs.get(k);
      if (!p) pairs.set(k, { a: ids[x], b: ids[y], rounds: 1, last: start });
      else if (start - p.last > CFG.SYNC_ROUND_GAP_MS) { p.rounds++; p.last = start; }
    }
  }
  const strong = [...pairs.values()].filter((p) => p.rounds >= repeat);
  const maxRounds = new Map();
  for (const p of strong) for (const id of [p.a, p.b]) maxRounds.set(id, Math.max(maxRounds.get(id) || 0, p.rounds));
  return components(strong.map((p) => [p.a, p.b]))
    .filter((g) => g.length >= groupMin)
    .map((ids) => ({ ids: ids.sort(), size: ids.length, rounds: Math.max(...ids.map((id) => maxRounds.get(id) || 0)) }))
    .sort((a, b) => b.size - a.size);
}

// PURE. Accounts that show EXACTLY the same stats (e.g. all "Level 5 / 16 wins"): rows = [{ id, wins, level }].
function identicalStatGroups(rows, minSize = 4) {
  const map = new Map();
  for (const r of rows) {
    if (!r.wins) continue;
    const k = `${r.wins}|${r.level}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(String(r.id));
  }
  return [...map.entries()]
    .filter(([, ids]) => ids.length >= minSize)
    .map(([k, ids]) => { const [wins, level] = k.split('|'); return { wins: Number(wins), level: Number(level), ids }; })
    .sort((a, b) => b.ids.length - a.ids.length);
}

async function saveCluster(ids, kind, max = 60) {
  const col = await getCollection('slashClusters');
  const _id = crypto.randomBytes(4).toString('hex');
  await col.insertOne({ _id, ids: ids.map(String).slice(0, max), kind, createdAt: new Date(), expireAt: new Date(Date.now() + 7 * 24 * 3600 * 1000) });
  return _id;
}
async function loadCluster(cid) {
  const col = await getCollection('slashClusters');
  return col.findOne({ _id: String(cid) });
}

async function markSuspects(ids, reason) {
  const usersCol = await getCollection('users');
  const variants = ids.flatMap((id) => idVariants(id));
  const before = await usersCol.find({ telegramId: { $in: variants }, slashSuspect: { $ne: true } }, { projection: { telegramId: 1 } }).toArray();
  if (!before.length) return [];
  await usersCol.updateMany(
    { telegramId: { $in: before.map((u) => u.telegramId) } },
    { $set: { slashSuspect: true, slashSuspectAt: new Date(), slashSuspectReason: reason } }
  );
  return before.map((u) => String(u.telegramId));
}

async function describeIds(ids, max = 15) {
  const usersCol = await getCollection('users');
  const rows = await usersCol.find({ telegramId: { $in: ids.flatMap((id) => idVariants(id)) } }, { projection: { telegramId: 1, username: 1, level: 1, totalSlices: 1 } }).toArray();
  const by = new Map(rows.map((u) => [String(u.telegramId), u]));
  const lines = ids.slice(0, max).map((id) => { const u = by.get(String(id)); return `• @${esc((u && u.username) || 'unknown')} <code>${esc(id)}</code>`; });
  if (ids.length > max) lines.push(`… +${ids.length - max} more`);
  return lines.join('\n');
}

function clusterButtons(cid, n) {
  return {
    inline_keyboard: [
      [{ text: `🔒 Lock all ${n}`, callback_data: `sy_lock_${cid}` }, { text: '👁 Members', callback_data: `sy_view_${cid}` }],
      [{ text: `🚫 Ban all ${n}`, callback_data: `sy_banask_${cid}` }],
      [{ text: '✅ Looks real — clear flags', callback_data: `sy_clear_${cid}` }],
    ],
  };
}

// Live check, called after every successful slash claim. Looks at who else claimed within the window,
// counts every pair once per round, and alerts when a group of 5+ keeps doing it together. Never throws.
async function checkSyncGroup(user, now = new Date()) {
  try {
    const me = String(user.telegramId);
    const t = now.getTime();
    const logCol = await getCollection('slashLog');
    const near = await logCol.find(
      { createdAt: { $gte: new Date(t - CFG.SYNC_WINDOW_MS), $lte: new Date(t + CFG.SYNC_WINDOW_MS) } },
      { projection: { telegramId: 1 } }
    ).limit(80).toArray();
    const group = new Set(near.map((d) => String(d.telegramId)));
    group.add(me);
    if (group.size < CFG.SYNC_GROUP_MIN) return;

    // me first, then the rest, capped (keeps work small even during a real traffic spike)
    const ids = [me, ...[...group].filter((x) => x !== me).sort()].slice(0, CFG.SYNC_MAX_GROUP);
    const keys = [];
    for (let x = 0; x < ids.length; x++) for (let y = x + 1; y < ids.length; y++) keys.push(pairKey(ids[x], ids[y]));

    const pairCol = await getCollection('slashSync');
    const existing = await pairCol.find({ _id: { $in: keys } }).toArray();
    const have = new Map(existing.map((d) => [d._id, d]));
    const ops = [];
    for (const k of keys) {
      const d = have.get(k);
      const [a, b] = k.split('|');
      if (!d) {
        ops.push({ updateOne: { filter: { _id: k }, update: { $setOnInsert: { a, b, count: 1, lastRoundAt: now, expireAt: new Date(t + CFG.PAIR_RETENTION_MS) } }, upsert: true } });
      } else if (!d.lastRoundAt || t - new Date(d.lastRoundAt).getTime() > CFG.SYNC_ROUND_GAP_MS) {
        // optimistic guard: only the request that sees the same lastRoundAt may count this round
        ops.push({ updateOne: { filter: { _id: k, lastRoundAt: d.lastRoundAt }, update: { $inc: { count: 1 }, $set: { lastRoundAt: now, expireAt: new Date(t + CFG.PAIR_RETENTION_MS) } } } });
      }
    }
    if (ops.length) { try { await pairCol.bulkWrite(ops, { ordered: false }); } catch (e) { /* duplicate-key races are harmless */ } }

    // Expand from "me" over pairs that already repeated enough.
    let frontier = [me];
    const cluster = new Set([me]);
    for (let hop = 0; hop < 3 && frontier.length; hop++) {
      const rows = await pairCol.find({ count: { $gte: CFG.SYNC_REPEAT }, $or: [{ a: { $in: frontier } }, { b: { $in: frontier } }] }).limit(200).toArray();
      const next = [];
      for (const r of rows) for (const id of [r.a, r.b]) if (!cluster.has(id)) { cluster.add(id); next.push(id); }
      frontier = next;
      if (cluster.size > 60) break;
    }
    if (cluster.size < CFG.SYNC_GROUP_MIN) return;

    const fresh = await markSuspects([...cluster], 'sync_cluster');
    if (!fresh.length) return; // already flagged earlier — the admin has been told
    const all = [...cluster];

    // One ring = one saved cluster + one alert. While a ring is still growing, the SAME saved list is extended
    // (so the Lock / Ban buttons always act on everybody found so far) and the admin is only pinged again when
    // 3 or more new accounts joined.
    const clCol = await getCollection('slashClusters');
    const prevCluster = await clCol.findOne({ kind: 'live', createdAt: { $gte: new Date(Date.now() - 6 * 3600 * 1000) }, ids: { $in: all } });
    let cid, grew = false, members = all;
    if (prevCluster) {
      members = [...new Set([...(prevCluster.ids || []), ...all])].slice(0, 60);
      await clCol.updateOne({ _id: prevCluster._id }, { $set: { ids: members } });
      cid = prevCluster._id; grew = true;
      if (fresh.length < 3) return;
    } else {
      cid = await saveCluster(all, 'live');
    }
    notifyAdmin(
      `🕵️ <b>${grew ? 'Slash cluster GROWING' : 'Slash cluster detected'} — ${members.length} accounts slash together</b>\n\n` +
        `At least ${CFG.SYNC_GROUP_MIN} different accounts slashed within ${CFG.SYNC_WINDOW_MS / 1000}s of each other, and the same group did it ≥${CFG.SYNC_REPEAT} times. ` +
        `Real players do not move in a pack — this looks like one script running many accounts.\n\n` +
        `${await describeIds(members)}\n\n` +
        `They are flagged <b>suspect</b> (held back from the weekly prize). Nothing is locked yet — you decide:`,
      { reply_markup: clusterButtons(cid, members.length) }
    ).catch(() => {});
  } catch (e) { console.error('checkSyncGroup failed (ignored):', e); }
}

// RETRO SCAN over slashLog (7 days). Used by the admin button and by the weekly prize payout.
// `candidateIds` limits the work to e.g. the top slashers. -> { clusters:[{ids,size,rounds}], identical:[{wins,level,ids}] }
async function scanSlashFarms({ candidateIds = null, rows = null, days = 7 } = {}) {
  const logCol = await getCollection('slashLog');
  const q = { createdAt: { $gte: new Date(Date.now() - days * 24 * 3600 * 1000) } };
  if (candidateIds && candidateIds.length) q.telegramId = { $in: candidateIds.flatMap((id) => idVariants(id)) };
  const docs = await logCol.find(q, { projection: { telegramId: 1, createdAt: 1 } }).limit(120000).toArray();
  const claims = docs.map((d) => ({ id: String(d.telegramId), t: new Date(d.createdAt).getTime() }));
  // a slightly wider window than live detection: the scan has no repeat-pair history to lean on
  const clusters = findClusters(claims, { windowMs: Math.max(CFG.SYNC_WINDOW_MS, 30000) });
  const identical = rows ? identicalStatGroups(rows) : [];
  return { clusters, identical, claimsScanned: claims.length };
}

module.exports = {
  CFG, throttleRemainingMs, recordRejectedAttempt, hammerDecision, countsAsHammer,
  checkPlayTime, playMetronome,
  checkSyncGroup, findClusters, identicalStatGroups, components,
  saveCluster, loadCluster, markSuspects, describeIds, clusterButtons, scanSlashFarms,
  userButtons, reviewButtons,
};
