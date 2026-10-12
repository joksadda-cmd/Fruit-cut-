// lib/gamePlay.js
// Server-measured play time for the in-game reward ("10 FC per 3 minutes of play").
// The client only shows a timer; the REAL time is counted here from the gap between
// heartbeats (game_start / game_ping, every ~30s) using the SERVER clock, so editing
// the page or spamming pings can never give more play time than really passed.
//
// One doc per user in `gamePlays`: { _id, telegramId, gameId, playMs, lastPingAt }
//   touch(telegramId, gameId, isStart) -> { playMs, claimMs, claimable }
//   getState(telegramId)               -> { playMs, claimMs, claimable }
//   consumeClaim(telegramId)           -> true if 3 minutes were spent (atomic)
//   refundClaim(telegramId)            -> gives the 3 minutes back

const { getCollection } = require('./db');

const CLAIM_MS = 3 * 60 * 1000;          // 3 minutes of play per reward
const MAX_GAP_MS = 45 * 1000;            // heartbeat gap above this = tab was hidden/closed, not counted
const MAX_STORED_MS = CLAIM_MS * 5;      // bank at most 5 rewards worth of time (matches the UI bar)

const state = (doc) => {
  const playMs = doc ? Math.max(0, doc.playMs || 0) : 0;
  return { playMs, claimMs: CLAIM_MS, claimable: playMs >= CLAIM_MS };
};

async function touch(telegramId, gameId, isStart) {
  const col = await getCollection('gamePlays');
  const _id = String(telegramId);
  const now = new Date();
  const prev = await col.findOne({ _id });

  if (!prev) {
    try {
      await col.insertOne({ _id, telegramId, gameId: gameId || null, playMs: 0, lastPingAt: now, startedAt: now });
    } catch (e) { /* parallel insert — fine, state is read below */ }
    return state(await col.findOne({ _id }));
  }

  let add = 0;
  if (!isStart && prev.gameId === (gameId || null) && prev.lastPingAt) {
    const gap = now.getTime() - new Date(prev.lastPingAt).getTime();
    if (gap > 0 && gap <= MAX_GAP_MS) add = gap;
  }
  const playMs = Math.min(MAX_STORED_MS, (prev.playMs || 0) + add);

  // optimistic guard: only apply if no parallel ping moved lastPingAt meanwhile
  const r = await col.updateOne(
    { _id, lastPingAt: prev.lastPingAt },
    { $set: { gameId: gameId || null, playMs, lastPingAt: now, ...(isStart ? { startedAt: now } : {}) } }
  );
  if (!r.matchedCount) return state(await col.findOne({ _id }));
  return state({ playMs });
}

async function getState(telegramId) {
  const col = await getCollection('gamePlays');
  return state(await col.findOne({ _id: String(telegramId) }));
}

async function consumeClaim(telegramId) {
  const col = await getCollection('gamePlays');
  const r = await col.findOneAndUpdate(
    { _id: String(telegramId), playMs: { $gte: CLAIM_MS } },
    { $inc: { playMs: -CLAIM_MS } },
    { returnDocument: 'after' }
  );
  return !!r;
}

async function refundClaim(telegramId) {
  const col = await getCollection('gamePlays');
  await col.updateOne({ _id: String(telegramId) }, { $inc: { playMs: CLAIM_MS } });
}

module.exports = { touch, getState, consumeClaim, refundClaim, CLAIM_MS };
