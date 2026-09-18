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
    await Promise.allSettled([
      db.collection('adSessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection('dailyLimits').createIndex({ createdAt: 1 }, { expireAfterSeconds: 172800 }),
      db.collection('postbackEvents').createIndex({ receivedAt: 1 }, { expireAfterSeconds: 259200 }),
      db.collection('transactions').createIndex({ telegramId: 1, createdAt: -1 }),
      db.collection('users').createIndex({ telegramId: 1 }),
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
