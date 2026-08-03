// lib/gameSession.js
// Server-authoritative "did a real level actually get started" proof —
// mirrors lib/adSession.js's pattern.
//
// FIXES A CRITICAL BUG: api/game_claim.js's level-complete branch
// (action omitted / 'level') used to have ZERO gate before it — no Game
// Token check, no proof a level was even started, and it blindly trusted
// a client-sent `isAdWatched` boolean to double the reward. That meant
// anyone with a valid Telegram initData (readable from the Mini App
// itself) could script direct POST requests to /api/game_claim in a
// tight loop and mint unlimited Gold — no real gameplay required at all.
// This is what let one account withdraw real money after only 3 days.
//
// Flow now:
//   1. start_game (real token spend OR a genuine "watch ad to play free"
//      call) creates a session here.
//   2. Every level-complete/skip claim must present that sessionId.
//      claimGameSession() only succeeds if: the session belongs to this
//      user, is still active, hasn't expired from inactivity, AND at
//      least MIN_LEVEL_GAP_MS has really passed (server clock) since the
//      last claim on it — so a script hammering the claim endpoint in a
//      loop fails every time after the first.
//   3. A successful claim rolls the session forward (extends its idle
//      expiry, resets the gap timer) so a real player can keep clearing
//      levels one after another under the same session, exactly like
//      before — nothing about legitimate continuous play changes.

const { getCollection } = require('./db');
const crypto = require('crypto');

const SESSION_IDLE_TTL_MS = 30 * 60 * 1000; // session dies after 30 min with no claims
const MIN_LEVEL_GAP_MS = 3000;              // must be >=3s between claims — real slicing takes longer
const HOURLY_CLAIM_CAP = 30;                // matches MAX_AD_WATCHES... / MAX_GAMES_PER_HOUR in
// lib/constants.js — that constant existed before but was never actually
// enforced anywhere. This is defense-in-depth: even if the session logic
// above ever has a bug, no single account can earn more than this many
// level-rewards per hour.

let indexesEnsured = false;
async function ensureIndexes(col) {
  if (indexesEnsured) return;
  indexesEnsured = true;
  try {
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await col.createIndex({ sessionId: 1 }, { unique: true });
  } catch (e) {
    console.error('gameSession index setup failed:', e);
  }
}

async function createGameSession(telegramId, { free } = {}) {
  const col = await getCollection('gameSessions');
  await ensureIndexes(col);
  const sessionId = crypto.randomBytes(16).toString('hex');
  const now = new Date();
  await col.insertOne({
    sessionId,
    telegramId,
    free: !!free, // true = started via "watch ad to play free" (no token spent)
    status: 'active',
    createdAt: now,
    lastClaimAt: now,
    expiresAt: new Date(now.getTime() + SESSION_IDLE_TTL_MS),
  });
  return sessionId;
}

async function claimGameSession(telegramId, sessionId) {
  if (!sessionId) return { ok: false, reason: 'missing_session' };

  const col = await getCollection('gameSessions');
  const session = await col.findOne({ sessionId });

  if (!session) return { ok: false, reason: 'not_found' };
  if (session.telegramId !== telegramId) return { ok: false, reason: 'mismatch' };
  if (session.status !== 'active') return { ok: false, reason: 'inactive' };
  if (session.expiresAt < new Date()) return { ok: false, reason: 'expired' };

  const now = new Date();
  const elapsed = now.getTime() - session.lastClaimAt.getTime();
  if (elapsed < MIN_LEVEL_GAP_MS) return { ok: false, reason: 'too_fast' };

  // Atomic — only succeeds if lastClaimAt in the DB still matches what we
  // just read, so two near-simultaneous claims on the same session can't
  // both slip through the gap check (same compare-and-swap pattern as
  // lib/tokens.js's applyRegen).
  const result = await col.updateOne(
    { sessionId, lastClaimAt: session.lastClaimAt },
    { $set: { lastClaimAt: now, expiresAt: new Date(now.getTime() + SESSION_IDLE_TTL_MS) } }
  );
  if (result.modifiedCount === 0) return { ok: false, reason: 'race_lost' };

  return { ok: true };
}

// Generic per-user-per-hour cap — same atomic upsert pattern already used
// by lib/dailyLimit.js, just keyed by UTC hour instead of UTC day.
async function checkHourlyClaimCap(telegramId, maxPerHour = HOURLY_CLAIM_CAP) {
  const col = await getCollection('gameClaimHourly');
  try {
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  } catch (e) {
    // non-fatal — index creation racing across warm instances is fine to ignore
  }

  const hourKey = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)
  const _id = `${telegramId}_${hourKey}`;

  const existing = await col.findOne({ _id });
  const currentCount = existing ? existing.count : 0;
  if (currentCount >= maxPerHour) {
    return { allowed: false, count: currentCount };
  }

  const result = await col.findOneAndUpdate(
    { _id, count: { $lt: maxPerHour } },
    {
      $inc: { count: 1 },
      $set: { telegramId, hourKey, updatedAt: new Date(), expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000) },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, returnDocument: 'after' }
  );

  if (!result) {
    return { allowed: false, count: maxPerHour };
  }
  return { allowed: true, count: result.count };
}

module.exports = { createGameSession, claimGameSession, checkHourlyClaimCap, MIN_LEVEL_GAP_MS };
