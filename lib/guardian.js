// lib/guardian.js — ANTI-CHEAT GUARDIAN (added 2026-10-16)
//
// Built after one account used an "unlimited ads" script and cashed out 30+ times.
// The rule behind everything here: the SERVER decides what is possible. Whatever a
// hack tool sends, a reward is only paid when the server has its own proof, and money
// only leaves the app when the account's history looks like a human's.
//
// What this file does
//   1. blockedFromEarning(user)  -> true for banned / script-locked accounts (used by every reward endpoint)
//   2. withdrawRisk(user, addr)  -> checked right before a withdrawal is created:
//        a) account younger than MIN_ACCOUNT_AGE_MS            -> not yet
//        b) earned far more in 24h than the capped sources allow (a hack tool) -> account LOCKED + admin alert
//        c) the wallet address is used by ANOTHER account       -> blocked + admin alert
//   3. The admin gets one alert per user per 24h with Lock / Profile / Ban buttons.
//
// Tune with env vars (no code edit): GUARD_MIN_ACCOUNT_HOURS, GUARD_DAILY_EARN_CEILING, GUARD_DAILY_AD_COUNT_CEILING.

const { getCollection, idVariants } = require('./db');
const { lockUser, isBotLocked } = require('./lockup');
const { notifyAdmin } = require('./notify');

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

const MIN_ACCOUNT_AGE_MS = num(process.env.GUARD_MIN_ACCOUNT_HOURS, 48) * 3600 * 1000;

// Most FC a real player can earn in 24h from the CAPPED sources (ads + slash + treasure box):
//   ads  ≈ 200 + 400 + 100 + 1,000 (Adsgram task) + 1,000 (in-game) = 2,700
//   slash 48 × 40 = 1,920 · treasure box 2 × 100 = 200 · level-up bonuses ≈ 1,000-2,000 on a lucky day
// 7,000 leaves a safe margin; a script that bypasses the caps goes far beyond it.
const DAILY_EARN_CEILING_FC = num(process.env.GUARD_DAILY_EARN_CEILING, 7000);
// All ad caps added up are ~155 views a day; anything above this is not a human.
const DAILY_AD_COUNT_CEILING = num(process.env.GUARD_DAILY_AD_COUNT_CEILING, 220);

const EARN_TYPES = ['ad_reward', 'slash_reward', 'daily_gift_reward'];

const blockedFromEarning = (u) => !!(u && (u.banned || isBotLocked(u)));

async function alertOnce(user, title, body) {
  try {
    const usersCol = await getCollection('users');
    const r = await usersCol.updateOne(
      { _id: user._id, $or: [{ guardianAlertAt: { $exists: false } }, { guardianAlertAt: { $lt: new Date(Date.now() - 24 * 3600 * 1000) } }] },
      { $set: { guardianAlertAt: new Date() } }
    );
    if (!r.modifiedCount) return;
    await notifyAdmin(`🛡 <b>${title}</b>\n\nUser: <code>${user.telegramId}</code> (@${user.username || 'unknown'})\n${body}`, {
      reply_markup: { inline_keyboard: [
        [{ text: '🔓 Unlock', callback_data: `lk_unlock_${user.telegramId}` }, { text: '👤 Profile', callback_data: `lk_profile_${user.telegramId}` }],
        [{ text: '🚫 Ban', callback_data: `a_ban_${user.telegramId}` }],
      ] },
    });
  } catch (e) { console.error('guardian alert failed:', e); }
}

// -> { ok:true } or { ok:false, code, message }
async function withdrawRisk(user, address) {
  try {
    const ageMs = user.joinedAt ? Date.now() - new Date(user.joinedAt).getTime() : Infinity;
    if (ageMs < MIN_ACCOUNT_AGE_MS) {
      const hrs = Math.max(1, Math.ceil((MIN_ACCOUNT_AGE_MS - ageMs) / 3600000));
      return { ok: false, code: 'too_new', message: `New accounts can withdraw after ${Math.round(MIN_ACCOUNT_AGE_MS / 3600000)} hours. Try again in about ${hrs} hour${hrs > 1 ? 's' : ''}.` };
    }

    // b) earning speed — the fingerprint of a hack tool
    const txCol = await getCollection('transactions');
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const agg = await txCol.aggregate([
      { $match: { telegramId: { $in: idVariants(user.telegramId) }, type: { $in: EARN_TYPES }, createdAt: { $gte: since } } },
      { $group: { _id: null, fc: { $sum: '$amount' }, ads: { $sum: { $cond: [{ $eq: ['$type', 'ad_reward'] }, 1, 0] } } } },
    ]).toArray();
    const fc = agg[0] ? agg[0].fc : 0;
    const ads = agg[0] ? agg[0].ads : 0;
    if (fc > DAILY_EARN_CEILING_FC || ads > DAILY_AD_COUNT_CEILING) {
      await lockUser(user, 'earn_anomaly', { earnAnomalyAt: new Date() });
      alertOnce(user, 'Impossible earning speed — account locked',
        `Last 24h: <b>${fc.toLocaleString()} FC</b> from ads/slash/box (limit ${DAILY_EARN_CEILING_FC.toLocaleString()}) · <b>${ads}</b> ad rewards (limit ${DAILY_AD_COUNT_CEILING}).\nThis is not possible within the daily caps — likely a script. Withdrawal blocked, account locked.`);
      return { ok: false, code: 'review', message: '🔒 Your account is under review. Please contact support in our Official Community.' };
    }

    // c) one wallet = one account
    if (address) {
      const usersCol = await getCollection('users');
      const wdCol = await getCollection('withdrawals');
      const ids = idVariants(user.telegramId);
      const other = await usersCol.countDocuments({ withdrawWalletAddress: address, telegramId: { $nin: ids } });
      const otherWd = await wdCol.countDocuments({ address, telegramId: { $nin: ids } });
      if (other > 0 || otherWd > 0) {
        alertOnce(user, 'Same wallet used by another account — withdrawal blocked',
          `Wallet <code>${address}</code> is also used by ${Math.max(other, otherWd)} other account(s). Likely multi-accounting.`);
        return { ok: false, code: 'wallet_shared', message: 'This wallet address is already linked to another account. Contact support in our Official Community.' };
      }
    }
    return { ok: true };
  } catch (e) {
    // The guardian must never block a real user because of a database hiccup — but it must not be silent either.
    console.error('guardian.withdrawRisk failed (allowed):', e);
    return { ok: true };
  }
}

module.exports = { blockedFromEarning, withdrawRisk, DAILY_EARN_CEILING_FC, DAILY_AD_COUNT_CEILING, MIN_ACCOUNT_AGE_MS };
