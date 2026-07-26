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

async function connectToDatabase() {
  if (cachedDb) {
    return cachedDb;
  }

  if (!cachedClient) {
    cachedClient = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });
    await cachedClient.connect();
  }

  cachedDb = cachedClient.db(DB_NAME);
  return cachedDb;
}

// Helper to get a specific collection directly
async function getCollection(name) {
  const db = await connectToDatabase();
  return db.collection(name);
}

// ── telegramId type-safety helper ───────────────────────────────
// Telegram's own initData always gives user.id as a JS Number, and all
// current code stores/queries it as a String (see lib/telegramAuth.js).
// This helper exists purely as a safety net: if any OLDER document in
// the DB was ever written with the id as a Number (e.g. from an earlier
// version of this codebase before the String convention), a plain
// `findOne({ telegramId })` would silently miss it and look like
// "user_not_found". Matching both forms makes lookups immune to that.
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

module.exports = { connectToDatabase, getCollection, idVariants, findUserByTelegramId };
