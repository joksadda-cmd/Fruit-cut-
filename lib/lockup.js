// lib/lockup.js — ACCOUNT LOCKUP system (ported from NewTube, improved).
//
// A LOCK is softer than a ban: the balance stays, the user can keep using the app,
// but money can't leave the account until the admin reviews it.
//
//   accountLocked: true
//   accountLockedReason: 'ip_signup_velocity' | 'bot_pattern' | 'api_flood' | 'admin_manual'
//   accountLockedAt: Date
//
// What a lock blocks
//   every lock       -> withdrawal requests (api/withdraw.js)
//                       referral rewards: no FC / commission / weekly-contest credit
//                       to or from a locked account (lib/referral.js, lib/onboarding.js)
//   'bot_pattern' / 'api_flood' -> also ad rewards and the in-game claim (api/ads.js)
//
// Who sets it
//   lib/velocity.js  -> 'ip_signup_velocity' (a burst of new accounts from one IP)
//   lib/botGuard.js  -> 'bot_pattern'       (scripted ad claiming, only when clearly a script)
//   lib/rateLimit.js -> 'api_flood'         (300+ requests in 5 minutes from one account)
//   admin bot        -> 'admin_manual'      (Lock / Unlock buttons on the user profile)
//
// BAN REGISTRY (pairs with the TTL system, lib/ttlIndexes.js): banned user documents are
// auto-deleted after 60 days to save database space. A tiny permanent record per banned
// Telegram ID is kept in `bannedRegistry` so a banned person can never sign up again.

const { getCollection, findUserByTelegramId } = require('./db');

const REASON_LABELS = {
  ip_signup_velocity: 'IP signup burst',
  bot_pattern: 'Bot / script pattern',
  api_flood: 'API flood (too many requests)',
  admin_manual: 'Locked by admin',
};
const reasonLabel = (r) => REASON_LABELS[r] || r || 'unknown';

const isLocked = (u) => !!(u && u.accountLocked);
const isBotLocked = (u) => !!(u && u.accountLocked && (u.accountLockedReason === 'bot_pattern' || u.accountLockedReason === 'api_flood'));

// -> true only when THIS call changed the account from unlocked to locked.
async function lockUser(userDocOrId, reason, extra = {}) {
  const usersCol = await getCollection('users');
  const user = userDocOrId && userDocOrId._id ? userDocOrId : await findUserByTelegramId(usersCol, userDocOrId);
  if (!user) return false;
  const r = await usersCol.findOneAndUpdate(
    { _id: user._id, accountLocked: { $ne: true } },
    { $set: { accountLocked: true, accountLockedAt: new Date(), accountLockedReason: reason, ...extra } }
  );
  return !!r;
}

// Clears the lock AND the samples that caused it, so the same old data can't re-lock the user.
async function unlockUser(userDocOrId) {
  const usersCol = await getCollection('users');
  const user = userDocOrId && userDocOrId._id ? userDocOrId : await findUserByTelegramId(usersCol, userDocOrId);
  if (!user) return false;
  await usersCol.updateOne(
    { _id: user._id },
    {
      $set: { accountLocked: false },
      $unset: { accountLockedAt: '', accountLockedReason: '', recentAdClaims: '', botFlaggedAt: '', velocityFlaggedAt: '', velocityFlaggedReason: '' },
    }
  );
  return true;
}

// Unlock every account that a single IP burst locked (one tap from the admin alert).
async function unlockIpBurst(ip) {
  const usersCol = await getCollection('users');
  const r = await usersCol.updateMany(
    { accountLocked: true, accountLockedReason: 'ip_signup_velocity', signupIp: ip },
    {
      $set: { accountLocked: false },
      $unset: { accountLockedAt: '', accountLockedReason: '', velocityFlaggedAt: '', velocityFlaggedReason: '' },
    }
  );
  return r.modifiedCount || 0;
}

async function listLocked(page = 0, perPage = 8) {
  const usersCol = await getCollection('users');
  const total = await usersCol.countDocuments({ accountLocked: true });
  const rows = await usersCol
    .find({ accountLocked: true })
    .sort({ accountLockedAt: -1 })
    .skip(page * perPage)
    .limit(perPage)
    .toArray();
  return { total, rows };
}

// ── Ban registry ────────────────────────────────────────────────────
async function registerBan(telegramId, reason = 'admin_manual') {
  const col = await getCollection('bannedRegistry');
  await col.updateOne(
    { _id: String(telegramId) },
    { $set: { bannedAt: new Date(), reason }, $setOnInsert: { firstBannedAt: new Date() } },
    { upsert: true }
  );
}
async function unregisterBan(telegramId) {
  const col = await getCollection('bannedRegistry');
  await col.deleteOne({ _id: String(telegramId) });
}
async function isBannedInRegistry(telegramId) {
  const col = await getCollection('bannedRegistry');
  return !!(await col.findOne({ _id: String(telegramId) }));
}

module.exports = { reasonLabel, isLocked, isBotLocked, lockUser, unlockUser, unlockIpBurst, listLocked, registerBan, unregisterBan, isBannedInRegistry };
