// lib/slashSession.js
// Same pattern as lib/adSession.js, applied to the slash mini-game:
//   1. Frontend opens the arena -> asks for a session (createSlashSession)
//   2. Player actually cuts the fruit (3-5 taps client-side)
//   3. Frontend asks to claim that session (claimSlashSession)
//   4. Claim only succeeds if: session belongs to this user, hasn't been
//      used before, hasn't expired, AND at least MIN_PLAY_MS has passed
//      since it was created — checked with the SERVER's clock, so a
//      script that calls start+claim back-to-back (or replays an old
//      claim on a loop from Termux/devtools without ever opening the
//      real mini-app) fails outright instead of getting a free reward.
//
// This does not, by itself, stop a patient script that waits the right
// amount of time — it stops the trivial "just POST /api/slash claim every
// 30 minutes forever" replay attack, which is the common case. Combined
// with the daily/weekly caps and cooldown already enforced in api/slash.js.

const { getCollection } = require('./db');
const crypto = require('crypto');

const SESSION_TTL_MS = 90 * 1000; // session must be claimed within 90s of being opened
const MIN_PLAY_MS = 1200; // fastest a real 3-cut round can finish (see index.html CUT_DEBOUNCE_MS)

let indexesEnsured = false;
async function ensureIndexes(col) {
  if (indexesEnsured) return;
  indexesEnsured = true;
  try {
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await col.createIndex({ sessionId: 1 }, { unique: true });
  } catch (e) {
    console.error('slashSession index setup failed:', e);
  }
}

async function createSlashSession(telegramId) {
  const col = await getCollection('slashSessions');
  await ensureIndexes(col);
  const sessionId = crypto.randomBytes(16).toString('hex');
  await col.insertOne({
    sessionId,
    telegramId,
    status: 'pending',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return sessionId;
}

async function claimSlashSession(telegramId, sessionId) {
  if (!sessionId) return { ok: false, reason: 'missing_session' };
  const col = await getCollection('slashSessions');
  const session = await col.findOne({ sessionId });

  if (!session) return { ok: false, reason: 'not_found' };
  if (session.telegramId !== telegramId) return { ok: false, reason: 'mismatch' };
  if (session.status !== 'pending') return { ok: false, reason: 'already_used' };
  if (session.expiresAt < new Date()) return { ok: false, reason: 'expired' };

  const elapsed = Date.now() - session.createdAt.getTime();
  if (elapsed < MIN_PLAY_MS) return { ok: false, reason: 'too_fast' };

  // Atomic claim — only one request can flip pending -> claimed.
  const updateResult = await col.updateOne(
    { sessionId, status: 'pending' },
    { $set: { status: 'claimed', claimedAt: new Date() } }
  );
  if (updateResult.modifiedCount === 0) return { ok: false, reason: 'race_lost' };

  return { ok: true };
}

module.exports = { createSlashSession, claimSlashSession };
