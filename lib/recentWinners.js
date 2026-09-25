// lib/recentWinners.js
// A small rolling feed of recent weekly-contest winners (both the Slash
// leaderboard's top 20 and the Referral leaderboard's top 10), shown as a
// "🏅 Recent Winners" panel inside the leaderboard modal.
//
// Each entry auto-deletes 15 days after being recorded (TTL index) — this
// is intentionally SEPARATE from the weekly leaderboard collections' own
// 21-day retention (lib/leaderboard.js / lib/referralLeaderboard.js), which
// exists for a different reason (re-query safety around the payout cron)
// and isn't shown to users directly.
//
// Recorded from distributeWeeklyPrizes() / distributeWeeklyReferralPrizes()
// at the moment each winner is actually paid — so this feed only ever shows
// people who really received FC, never a mid-week snapshot.

const { getCollection } = require('./db');

const RETENTION_DAYS = 15;
const RETENTION_SECONDS = RETENTION_DAYS * 24 * 60 * 60;

let indexEnsured = false;
async function ensureIndex(col) {
  if (indexEnsured) return;
  indexEnsured = true;
  try {
    await col.createIndex({ wonAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });
  } catch (e) {
    console.error('recentWinners index setup failed:', e);
  }
}

// type: 'slash' | 'referral'
async function recordRecentWinner({ telegramId, username, type, rank, prize, weekKey }) {
  const col = await getCollection('recentWinners');
  await ensureIndex(col);
  await col.insertOne({
    telegramId: String(telegramId),
    username: username || 'Player',
    type,
    rank,
    prize,
    weekKey,
    wonAt: new Date(),
  });
}

// Most recent winners first, across both competitions. `limit` caps how many
// come back for the panel — the TTL index is what actually caps how far
// back in time results can reach (15 days), this is just a display limit.
async function getRecentWinners(limit = 20) {
  const col = await getCollection('recentWinners');
  return col.find({}).sort({ wonAt: -1 }).limit(limit).toArray();
}

module.exports = { recordRecentWinner, getRecentWinners, RETENTION_DAYS };
