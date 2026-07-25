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

module.exports = { connectToDatabase, getCollection };
