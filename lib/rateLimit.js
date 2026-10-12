// lib/rateLimit.js — FLOOD PROTECTION (protects MongoDB + the Vercel function budget).
//
// Called by every /api endpoint right after the Telegram signature check, BEFORE any database work:
//     if (await rateGuard(req, res, verify, 'ads')) return;
// It returns true when it already answered (HTTP 429) and the endpoint must stop.
//
// LAYERS
//  1) Invalid logins per IP (in memory, no DB): signed initData can't be forged, so a client that
//     keeps sending BAD signatures is an attacker. >30 bad requests / minute from one IP -> 429.
//     (Normal users are never limited by IP: many Bangladeshi phones share one carrier IP.)
//  2) Soft limit per account (in memory, no DB): more than 60 requests / minute -> 429.
//     A real player makes roughly 1-15 requests a minute.
//  3) Hard limit per account (shared across all servers, 1 small DB write per 10 requests):
//     more than 300 requests in 5 minutes -> the account is
//        - 🔒 LOCKED  (reason 'api_flood': no withdraw, no ad/game rewards, no referral credit)
//        - blocked from the API for 15 minutes (429, answered from memory)
//        - reported to the ADMIN on Telegram with Unlock / Profile / Ban buttons (once).
//  The guard fails OPEN: if anything inside it breaks, the request is allowed through.
//
// Limits can be changed without a code edit via env vars RL_SOFT_PER_MIN / RL_HARD_PER_5MIN.

const { getCollection } = require('./db');
const { notifyAdmin } = require('./notify');
const { lockUser } = require('./lockup');

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const SOFT_PER_MIN = num(process.env.RL_SOFT_PER_MIN, 60);
const HARD_PER_5MIN = num(process.env.RL_HARD_PER_5MIN, 300);
const BAD_AUTH_PER_MIN = num(process.env.RL_BAD_AUTH_PER_MIN, 30);
const BLOCK_MS = 15 * 60 * 1000;
const FLUSH_EVERY = 10;          // requests per server before the shared DB counter is updated
const WINDOW_MS = 5 * 60 * 1000;

const users = new Map();         // telegramId -> in-memory counters of THIS server
const badIps = new Map();        // ip -> { b, n }

let indexReady = false;
async function col() {
  const c = await getCollection('rateLimits');
  if (!indexReady) {
    indexReady = true;
    c.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
  }
  return c;
}

function prune(now) {
  if (users.size > 5000) {
    for (const [k, r] of users) if (r.blockedUntil < now && now - r.lastSeen > WINDOW_MS) users.delete(k);
  }
  if (badIps.size > 5000) {
    const b = Math.floor(now / 60000);
    for (const [k, r] of badIps) if (r.b !== b) badIps.delete(k);
  }
}

const ipOf = (req) => {
  const x = req.headers && req.headers['x-forwarded-for'];
  return (x ? String(x).split(',')[0].trim() : (req.socket && req.socket.remoteAddress)) || '?';
};

function reject(res, retryAfterSec) {
  try { res.setHeader('Retry-After', String(retryAfterSec)); } catch (e) {}
  res.status(429).json({ success: false, ok: false, error: 'rate_limited', message: 'rate_limited', retryAfter: retryAfterSec });
}

// Called once when an account crosses the hard limit. Only the FIRST server to get here locks + alerts:
// the upsert below hits a duplicate-key error for everybody else while the block is active.
async function trip(uid, r, total) {
  const now = Date.now();
  r.blockedUntil = now + BLOCK_MS;
  try {
    const c = await col();
    try {
      await c.findOneAndUpdate(
        { _id: uid, $or: [{ blockedUntil: { $exists: false } }, { blockedUntil: { $lt: new Date(now) } }] },
        { $set: { blockedUntil: new Date(now + BLOCK_MS), n: total, bucket: r.fiveB, expireAt: new Date(now + BLOCK_MS + 10 * 60000) } },
        { upsert: true }
      );
    } catch (e) {
      return; // duplicate key = another server already locked + reported this account
    }
    const locked = await lockUser(uid, 'api_flood', { apiFloodAt: new Date() }).catch(() => false);
    const eps = Object.entries(r.eps).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(', ') || '—';
    notifyAdmin(
      `🚨 <b>API flood detected</b>\n\nUser: <code>${uid}</code>\nRequests: <b>${total}</b> in under 5 min (limit ${HARD_PER_5MIN})\nEndpoints (this server): ${eps}\n` +
      (locked ? '🔒 The account is now locked (no withdraw, no ad/game rewards).' : 'ℹ️ The account was already locked or has no profile yet.') +
      `\n⛔ API access blocked for ${BLOCK_MS / 60000} minutes.`,
      { reply_markup: { inline_keyboard: [
        [{ text: '🔓 Unlock', callback_data: `lk_unlock_${uid}` }, { text: '👤 Profile', callback_data: `lk_profile_${uid}` }],
        [{ text: '🚫 Ban', callback_data: `a_ban_${uid}` }],
      ] } }
    ).catch(() => {});
  } catch (e) {
    console.error('rateLimit trip failed:', e);
  }
}

// Adds this server's unreported requests to the shared per-user counter and reads the answer back.
async function flush(uid, r, add, now) {
  const c = await col();
  const expireAt = new Date(now + WINDOW_MS + BLOCK_MS + 10 * 60000);
  let doc = await c.findOneAndUpdate({ _id: uid, bucket: r.fiveB }, { $inc: { n: add }, $set: { expireAt } });
  if (doc) doc = { ...doc, n: (doc.n || 0) + add };
  else doc = await c.findOneAndUpdate({ _id: uid }, { $set: { bucket: r.fiveB, n: add, expireAt } }, { upsert: true, returnDocument: 'after' });
  return doc;
}

async function checkUser(uid, endpoint) {
  const now = Date.now();
  let r = users.get(uid);
  if (!r) { r = { minB: 0, minN: 0, fiveB: 0, fiveN: 0, unflushed: 0, blockedUntil: 0, lastSeen: now, eps: {} }; users.set(uid, r); prune(now); }
  r.lastSeen = now;
  if (r.blockedUntil > now) return { ok: false, retryAfter: Math.ceil((r.blockedUntil - now) / 1000) };

  const minB = Math.floor(now / 60000), fiveB = Math.floor(now / WINDOW_MS);
  if (r.minB !== minB) { r.minB = minB; r.minN = 0; }
  if (r.fiveB !== fiveB) { r.fiveB = fiveB; r.fiveN = 0; r.unflushed = 0; r.eps = {}; }
  r.minN++; r.fiveN++; r.unflushed++;
  r.eps[endpoint] = (r.eps[endpoint] || 0) + 1;

  // hard limit seen by this server alone
  if (r.fiveN > HARD_PER_5MIN) { await trip(uid, r, r.fiveN); return { ok: false, retryAfter: Math.ceil(BLOCK_MS / 1000) }; }

  // hard limit across ALL servers (shared counter, updated every FLUSH_EVERY requests)
  if (r.unflushed >= FLUSH_EVERY) {
    const add = r.unflushed; r.unflushed = 0;
    try {
      const doc = await flush(uid, r, add, now);
      if (doc && doc.blockedUntil && new Date(doc.blockedUntil).getTime() > now) {
        r.blockedUntil = new Date(doc.blockedUntil).getTime();
        return { ok: false, retryAfter: Math.ceil((r.blockedUntil - now) / 1000) };
      }
      if (doc && doc.n > HARD_PER_5MIN) { await trip(uid, r, doc.n); return { ok: false, retryAfter: Math.ceil(BLOCK_MS / 1000) }; }
    } catch (e) { console.error('rateLimit flush failed (allowed):', e); }
  }

  // soft limit: just slow the client down
  if (r.minN > SOFT_PER_MIN) return { ok: false, retryAfter: Math.max(1, 60 - Math.floor((now % 60000) / 1000)) };
  return { ok: true };
}

// verify = result of verifyTelegramInitData(...). Returns true if it already replied (429).
async function rateGuard(req, res, verify, endpoint = 'api') {
  try {
    if (!verify || !verify.valid) {
      const now = Date.now(), b = Math.floor(now / 60000), ip = ipOf(req);
      let e = badIps.get(ip);
      if (!e || e.b !== b) { e = { b, n: 0 }; badIps.set(ip, e); prune(now); }
      if (++e.n > BAD_AUTH_PER_MIN) { reject(res, 60); return true; }
      return false; // the endpoint sends its normal 401
    }
    const r = await checkUser(String(verify.user.id), endpoint);
    if (!r.ok) { reject(res, r.retryAfter); return true; }
    return false;
  } catch (e) {
    console.error('rateGuard error (allowed):', e);
    return false;
  }
}

module.exports = { rateGuard, _internals: { users, badIps } };
