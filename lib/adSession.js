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

// `expiresAt` was being written on every session doc but nothing ever
// created a TTL index for it — sessions were piling up in Mongo forever
// instead of being auto-deleted once expired. Same fix/pattern as
// lib/promo.js's ensureIndexes().
let indexesEnsured = false;
async function ensureIndexes(col) {
  if (indexesEnsured) return;
  indexesEnsured = true;
  try {
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await col.createIndex({ sessionId: 1 }, { unique: true });
    await col.createIndex({ telegramId: 1, network: 1, status: 1, claimedAt: 1 }); // speeds up countClaimedToday
  } catch (e) {
    console.error('adSession index setup failed:', e);
  }
}

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
  // Withdraw-unlock gate ad — shown via the same Adsgram click-based SDK
  // (showAdsgramSpecialAd on the frontend), so it resolves the same way:
  // trust Adsgram's own "watched till the end" guarantee, 0 extra delay.
  withdrawGate: 0,
  // In-game reward claim: GigaPub's 5s + postback checks are enforced in api/ads.js,
  // Adsgram resolves only after a full watch — so no extra delay needed here.
  gameAd: 0,
};

// `extra` = optional extra fields saved on the session (e.g. { provider } for the in-game claim).
async function createAdSession(telegramId, network, extra) {
  const col = await getCollection('adSessions');
  await ensureIndexes(col);
  const sessionId = crypto.randomBytes(16).toString('hex');
  await col.insertOne({
    ...(extra && typeof extra === 'object' ? extra : {}),
    sessionId,
    telegramId,
    network,
    status: 'pending',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return sessionId;
}

// Read one session (used by api/ads.js for the in-game claim + GigaPub postback check).
async function getAdSession(sessionId) {
  if (!sessionId) return null;
  const col = await getCollection('adSessions');
  return col.findOne({ sessionId: String(sessionId) });
}

// Called by api/postback.js: GigaPub's own server confirmed an in-game ad view.
// Marks the user's newest still-pending in-game GigaPub session. Returns true if one was marked.
async function markGameGigapubPostback(telegramId) {
  const col = await getCollection('adSessions');
  const r = await col.findOneAndUpdate(
    {
      telegramId: { $in: [String(telegramId), Number(telegramId)].filter((v) => !Number.isNaN(v)) },
      network: 'gameAd',
      provider: 'gigapub',
      status: 'pending',
      postbackSeen: { $ne: true },
      expiresAt: { $gt: new Date() },
    },
    { $set: { postbackSeen: true, postbackAt: new Date() } },
    { sort: { createdAt: -1 } }
  );
  return !!r;
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

  // Atomic claim — only one request can flip pending -> claimed.
  // Also push expiresAt out to 7 days from claim time (was left at the
  // original 3-min pending expiry) — otherwise the existing TTL index on
  // `expiresAt` deletes this doc within minutes of creation regardless of
  // claim status, and countClaimedToday() silently stops seeing earlier
  // claims from later the same day, undermining the daily ad-watch cap.
  // 7 days also happens to match "clean up ad-watch trash after a week".
  const CLAIMED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const updateResult = await col.updateOne(
    { sessionId, status: 'pending' },
    { $set: { status: 'claimed', claimedAt: new Date(), expiresAt: new Date(Date.now() + CLAIMED_RETENTION_MS) } }
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

// ── Reopen a session whose reward credit failed AFTER it was marked claimed ──
// claimAdSession() flips pending -> claimed to atomically stop double-claims.
// But the actual Fruit Coin credit (creditAdReward) happens as a SEPARATE step
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

// ── All four ad counters for today, straight from the server ──────────────
// The frontend used to keep these counts ONLY in memory (window.G.xxxCount),
// so closing + reopening the mini app reset every counter to 0 and the ads
// list showed a full 10/10, 20/20 again even after the user had watched ads.
// api/auth.js and api/init.js now return this so the UI always shows the
// real remaining count. GigaPub is rewarded via the S2S postback (see
// api/postback.js), so its count comes from `postbackEvents`, not adSessions.
async function getAdCountsToday(telegramId) {
  const startOfDay = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
  const postbackCol = await getCollection('postbackEvents');
  const [adsgram, adsgramDaily, monetag, gigapub] = await Promise.all([
    countClaimedToday(telegramId, 'adsgram'),
    countClaimedToday(telegramId, 'adsgramDaily'),
    countClaimedToday(telegramId, 'monetag'),
    postbackCol.countDocuments({
      telegramId: { $in: [String(telegramId), Number(telegramId)] },
      network: 'gigapub',
      receivedAt: { $gte: startOfDay },
    }),
  ]);
  return {
    adsgramCount: adsgram,
    adsgramDailyCount: adsgramDaily,
    gigapubCount: gigapub,
    monetagCount: monetag,
  };
}

// Called by api/postback.js when ADSGRAM's server confirms a reward (Reward URL).
// `network` = 'adsgram' (Special block) or 'adsgramDaily' (Daily block; the in-game Adsgram
// ad uses the same block, so a pending in-game Adsgram claim counts too).
// Marks the user's newest still-pending matching session. A repeat call within 8s is ignored
// (Adsgram retries must not confirm a second session).
async function markAdsgramPostback(telegramId, network) {
  const col = await getCollection('adSessions');
  const ids = [String(telegramId), Number(telegramId)].filter((v) => !Number.isNaN(v));
  const recent = await col.findOne({
    telegramId: { $in: ids },
    postbackNetwork: network,
    postbackAt: { $gt: new Date(Date.now() - 8000) },
  });
  if (recent) return false;
  const match = network === 'adsgram'
    ? { network: 'adsgram' }
    : { $or: [{ network: 'adsgramDaily' }, { network: 'gameAd', provider: 'adsgram' }] };
  const r = await col.findOneAndUpdate(
    {
      ...match,
      telegramId: { $in: ids },
      status: 'pending',
      postbackSeen: { $ne: true },
      expiresAt: { $gt: new Date() },
    },
    { $set: { postbackSeen: true, postbackAt: new Date(), postbackNetwork: network } },
    { sort: { createdAt: -1 } }
  );
  return !!r;
}

module.exports = { markAdsgramPostback, createAdSession, claimAdSession, getAdSession, markGameGigapubPostback, countClaimedToday, revertAdSession, getAdCountsToday };
