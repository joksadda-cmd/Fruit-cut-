// lib/promo.js
// Promo code system — admin generates short-lived codes from the admin bot
// (api/bot.js); users redeem them in-app (via api/convert.js's
// 'redeem_promo' action) after watching one ad, proving they're a real,
// active user and not a script.
//
// Every code is valid for exactly 24 hours from creation. `expiresAt`
// doubles as a MongoDB TTL field — ensureIndexes() below sets up a TTL
// index (expireAfterSeconds: 0) the first time this file runs on a cold
// start, so expired codes are auto-deleted by MongoDB itself instead of
// piling up forever. No separate setup endpoint needed (keeps us at 12
// Serverless Functions), and no terminal/mongosh access needed either.

const { getCollection } = require('./db');
const crypto = require('crypto');

const CODE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let indexesEnsured = false;
async function ensureIndexes(col) {
  if (indexesEnsured) return;
  indexesEnsured = true;
  try {
    // Auto-delete the whole document once expiresAt is in the past —
    // this is what actually implements "old promo data gets cleaned up".
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await col.createIndex({ code: 1 }, { unique: true });
  } catch (e) {
    console.error('promo index setup failed:', e);
  }
}

function generateCode() {
  // e.g. FC-7K2P9X4M — short enough to type/paste on mobile.
  const rand = crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 8);
  return `FC-${rand}`;
}

async function createPromoCode({ rewardFc, maxUses, createdBy }) {
  const col = await getCollection('promoCodes');
  await ensureIndexes(col);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  let code = generateCode();

  // Astronomically unlikely, but guard against a collision anyway.
  for (let i = 0; i < 3; i++) {
    const exists = await col.findOne({ code });
    if (!exists) break;
    code = generateCode();
  }

  await col.insertOne({
    code,
    rewardFc,
    maxUses: maxUses || 0, // 0 = unlimited (until the 24h expiry hits)
    usedCount: 0,
    redeemedBy: [],
    active: true,
    createdBy: String(createdBy),
    createdAt: now,
    expiresAt,
  });

  return { code, rewardFc, maxUses: maxUses || 0, expiresAt };
}

async function redeemPromoCode(telegramId, rawCode) {
  const col = await getCollection('promoCodes');
  await ensureIndexes(col);

  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { ok: false, reason: 'invalid_code' };

  const promo = await col.findOne({ code });
  if (!promo || !promo.active) return { ok: false, reason: 'invalid_code' };
  if (promo.expiresAt < new Date()) return { ok: false, reason: 'expired' };
  if (promo.redeemedBy && promo.redeemedBy.includes(String(telegramId))) {
    return { ok: false, reason: 'already_redeemed' };
  }
  if (promo.maxUses > 0 && promo.usedCount >= promo.maxUses) {
    return { ok: false, reason: 'promo_exhausted' };
  }

  // Atomic: re-checks everything in the filter itself, so two simultaneous
  // requests for the same user/code (or the last two slots of a limited
  // code) can't both slip through between the reads above and this write.
  const filter = {
    code,
    active: true,
    expiresAt: { $gt: new Date() },
    redeemedBy: { $ne: String(telegramId) },
  };
  if (promo.maxUses > 0) filter.usedCount = { $lt: promo.maxUses };

  const updated = await col.findOneAndUpdate(
    filter,
    { $inc: { usedCount: 1 }, $addToSet: { redeemedBy: String(telegramId) } },
    { returnDocument: 'after' }
  );

  if (!updated) return { ok: false, reason: 'promo_exhausted' };

  return { ok: true, rewardFc: updated.rewardFc, code };
}

async function listActivePromoCodes(limit = 10) {
  const col = await getCollection('promoCodes');
  await ensureIndexes(col);
  return col
    .find({ active: true, expiresAt: { $gt: new Date() } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

async function revertPromoRedeem(rawCode, telegramId) {
  const col = await getCollection('promoCodes');
  const code = String(rawCode || '').trim().toUpperCase();
  await col.updateOne(
    { code, redeemedBy: String(telegramId) },
    { $inc: { usedCount: -1 }, $pull: { redeemedBy: String(telegramId) } }
  );
}

module.exports = { createPromoCode, redeemPromoCode, listActivePromoCodes, revertPromoRedeem };
