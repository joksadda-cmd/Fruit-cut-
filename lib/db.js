// lib/db.js
// MongoDB connection pooling — serverless-safe (reuses connection across
// warm Vercel function invocations instead of opening a new one every call).
// Uses env var: MONGODB_URI (already set in Vercel).

const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const DB_NAME = 'fruitcut'; // single DB for this project

if (!uri) {
  throw new Error('MONGODB_URI is not set in environment variables');
}

let cachedClient = null;
let cachedDb = null;
let ttlIndexesEnsured = false;

async function ensureTtlIndexes(db) {
  if (ttlIndexesEnsured) return;
  ttlIndexesEnsured = true;
  try {
    // dailyLimits used to have a single blanket TTL on `createdAt` (48h) —
    // that's correct for daily counters, but the new weekly slash-cap
    // counter (checkAndIncrementWeeklyLimit, see lib/dailyLimit.js) needs to
    // survive a full week+, not 48h, or it'd silently reset mid-week and
    // let the 366/week cap be bypassed. Switched to a per-document `expireAt`
    // field instead (daily docs get +3 days, weekly docs get +10 days — see
    // lib/dailyLimit.js) so one TTL index correctly handles both. Drop the
    // old field-based index first (safe no-op if it's already gone).
    await db.collection('dailyLimits').dropIndex('createdAt_1').catch(() => {});

    await Promise.allSettled([
      db.collection('adSessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection('dailyLimits').createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection('postbackEvents').createIndex({ receivedAt: 1 }, { expireAfterSeconds: 259200 }),
      db.collection('transactions').createIndex({ telegramId: 1, createdAt: -1 }),
      db.collection('users').createIndex({ telegramId: 1 }),
      // Weekly "Top Slasher" leaderboard (lib/leaderboard.js) and weekly
      // "Top Referrer" leaderboard (lib/referralLeaderboard.js) — each row
      // and each week's payout marker carries its own `expireAt` (~21 days
      // out, well past that week's cron payout) so old weeks self-clean
      // instead of piling up forever on a free-tier Mongo cluster.
      db.collection('leaderboard').createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection('referralLeaderboard').createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection('slashLog').createIndex({ createdAt: 1 }, { expireAfterSeconds: 604800 }), // 7 days
    ]);
  } catch (err) {
    console.warn('ensureTtlIndexes notice:', err.message);
  }
}

async function connectToDatabase() {
  if (cachedDb) {
    return cachedDb;
  }

  if (!cachedClient) {
    const client = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });
    try {
      await client.connect();
      cachedClient = client;
    } catch (err) {
      cachedClient = null;
      throw err;
    }
  }

  cachedDb = cachedClient.db(DB_NAME);
  ensureTtlIndexes(cachedDb).catch(() => {});
  return cachedDb;
}

// Helper to get a specific collection directly
async function getCollection(name) {
  const db = await connectToDatabase();
  return db.collection(name);
}

// ── telegramId type-safety helper ───────────────────────────────
function idVariants(telegramId) {
  const asString = String(telegramId);
  const asNumber = Number(telegramId);
  return Number.isFinite(asNumber) && String(asNumber) === asString
    ? [asString, asNumber]
    : [asString];
}

async function findUserByTelegramId(usersCol, telegramId) {
  return usersCol.findOne({ telegramId: { $in: idVariants(telegramId) } });
}

module.exports = { connectToDatabase, getCollection, idVariants, findUserByTelegramId, ensureTtlIndexes };
