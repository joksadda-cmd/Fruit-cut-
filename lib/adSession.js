// lib/adSession.js
// A lightweight stand-in for true S2S postbacks — works identically for
// ALL ad networks (adsgram, adsgramDaily, gigapub, monetag) with ZERO
// per-network dashboard configuration required.
//
// Flow:
//   1. Before showing an ad, frontend asks for a session (createAdSession)
//   2. Frontend shows the ad via the network's own SDK
//   3. On success, frontend asks to claim that session (claimAdSession)
//   4. Claim only succeeds if: session belongs to this user, hasn't been
//      used before, hasn't expired, AND at least MIN_WATCH_MS has passed
//      since it was created — this is checked with the SERVER's clock,
//      so a console/script call right after createAdSession fails.

const { getCollection } = require('./db');
const crypto = require('crypto');

const SESSION_TTL_MS = 3 * 60 * 1000;   // session valid for 3 minutes

// Different ad networks have genuinely different completion mechanics:
//  - Adsgram (Special & Daily): per Adsgram's own official docs
//    (docs.adsgram.ai/publisher/api-reference), AdController.show()'s
//    promise "becomes resolved if the user watches the ad till the end,
//    otherwise rejected" — that's a guarantee from Adsgram itself, not
//    something we need to double-check with our own timer. So we trust
//    it completely: 0 extra delay required beyond a valid, single-use,
//    non-expired session belonging to this user.
//  - GigaPub / Monetag: no such guarantee — purely time-based. Reward
//    only if at least 5s really elapsed since the ad session was opened.
const MIN_WATCH_MS = {
  adsgram: 0,
  adsgramDaily: 0,
  gigapub: 5000,
  monetag: 5000,
};

async function createAdSession(telegramId, network) {
  const col = await getCollection('adSessions');
  const sessionId = crypto.randomBytes(16).toString('hex');
  await col.insertOne({
    sessionId,
    telegramId,
    network,
    status: 'pending',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return sessionId;
}

async function claimAdSession(telegramId, sessionId, expectedNetwork) {
  const col = await getCollection('adSessions');
  const session = await col.findOne({ sessionId });

  if (!session) return { ok: false, reason: 'not_found' };
  if (session.telegramId !== telegramId) return { ok: false, reason: 'mismatch' };
  if (session.network !== expectedNetwork) return { ok: false, reason: 'network_mismatch' };
  if (session.status !== 'pending') return { ok: false, reason: 'already_used' };
  if (session.expiresAt < new Date()) return { ok: false, reason: 'expired' };

  const elapsed = Date.now() - session.createdAt.getTime();
  const minRequired = MIN_WATCH_MS[expectedNetwork] ?? 5000;
  if (elapsed < minRequired) return { ok: false, reason: 'too_fast' };

  // Atomic claim — only one request can flip pending -> claimed
  const updateResult = await col.updateOne(
    { sessionId, status: 'pending' },
    { $set: { status: 'claimed', claimedAt: new Date() } }
  );
  if (updateResult.modifiedCount === 0) return { ok: false, reason: 'race_lost' };

  return { ok: true };
}

// Count how many sessions this user has successfully claimed for a given
// network TODAY (UTC calendar day) — used to enforce daily watch limits
// server-side, matching the "5/5 remaining" reset behavior already shown
// in your UI (client-side counters alone can be edited in devtools).
async function countClaimedToday(telegramId, network) {
  const col = await getCollection('adSessions');
  const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const startOfDay = new Date(todayStr + 'T00:00:00.000Z');
  return col.countDocuments({
    telegramId,
    network,
    status: 'claimed',
    claimedAt: { $gte: startOfDay },
  });
}

// ── Reopen a session whose gold credit failed AFTER it was marked claimed ──
// claimAdSession() flips pending -> claimed to atomically stop double-claims.
// But the actual gold credit (creditGoldForAd) happens as a SEPARATE step
// right after — if that step fails for any reason (a transient DB hiccup,
// the user document briefly not being found, etc.), the session is already
// 'claimed' even though no reward was ever given. Without this, the user
// watched a real ad, got nothing, AND burned one of their limited daily
// slots on a session they can never retry (claimAdSession rejects anything
// that isn't 'pending' with reason 'already_used').
//
// This puts the session back to 'pending' with a short fresh expiry window
// so the very next claim attempt (the frontend can just retry the SAME
// sessionId) has a real chance to succeed instead of the reward being lost
// forever. Only reverts a session that is still genuinely 'claimed' and
// still belongs to this user — never touches anything else.
async function revertAdSession(sessionId, telegramId) {
  const col = await getCollection('adSessions');
  const REOPEN_WINDOW_MS = 2 * 60 * 1000; // 2 more minutes to retry the claim
  await col.updateOne(
    { sessionId, telegramId, status: 'claimed' },
    {
      $set: {
        status: 'pending',
        expiresAt: new Date(Date.now() + REOPEN_WINDOW_MS),
      },
      $unset: { claimedAt: '' },
    }
  );
}

module.exports = { createAdSession, claimAdSession, countClaimedToday, revertAdSession };
