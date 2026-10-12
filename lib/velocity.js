// lib/velocity.js — VELOCITY system (ported from NewTube, improved).
//
// "Velocity" = how FAST something happens. Real people sign up slowly (they must see the
// link, open Telegram, pass verification). A farm script creates dozens of accounts in
// minutes. We measure two things:
//
//  1) IP SIGNUP VELOCITY  -> new accounts from ONE IP.
//        6+ accounts in 3 minutes  OR  25+ accounts in 1 hour  => the NEW account is
//        locked (lib/lockup.js, reason ip_signup_velocity) and the admin is alerted with
//        one-tap Unlock-all / Review / Ban buttons.
//        (The 1-hour window is new — it catches slow farms that stay under the 3-minute rule.)
//  2) REFERRAL SIGNUP VELOCITY -> signups under ONE referrer.
//        20+ in 2 minutes => ALERT ONLY (nothing is blocked; a real viral post can do this).
//        The admin decides: Lock / Profile / Ban.
//
// Shared mobile-carrier IPs (CGNAT) can cause false positives, so a velocity lock is soft
// (withdrawals + referral rewards only) and the admin can unlock the whole burst in one tap.

const { getCollection } = require('./db');
const { notifyAdmin } = require('./notify');

const IP_WINDOW_MS = 3 * 60 * 1000;
const IP_THRESHOLD = 6;
const IP_HOUR_WINDOW_MS = 60 * 60 * 1000;
const IP_HOUR_THRESHOLD = 25;
const REFERRAL_WINDOW_MS = 2 * 60 * 1000;
const REFERRAL_THRESHOLD = 20;

// Records one new signup for this IP. -> { count, countHour, locked }
async function recordSignupAndCheck(ip) {
  if (!ip || ip === 'unknown') return { count: 0, countHour: 0, locked: false }; // never gate on a detection failure
  const col = await getCollection('ipSignupVelocity');
  const now = new Date();
  const doc = await col.findOneAndUpdate(
    { _id: ip },
    { $push: { recentSignups: { $each: [now], $slice: -80 } }, $set: { updatedAt: now } }, // updatedAt feeds the TTL cleanup
    { upsert: true, returnDocument: 'after' }
  );
  const list = (doc && doc.recentSignups) || [];
  const t = now.getTime();
  const count = list.filter((x) => new Date(x).getTime() >= t - IP_WINDOW_MS).length;
  const countHour = list.filter((x) => new Date(x).getTime() >= t - IP_HOUR_WINDOW_MS).length;
  return { count, countHour, locked: count >= IP_THRESHOLD || countHour >= IP_HOUR_THRESHOLD };
}

// Admin alert: once at the threshold, then every +10 while the burst continues.
function alertIpBurst({ ip, count, countHour, userId }) {
  const n = Math.max(count, countHour);
  const trigger = count >= IP_THRESHOLD ? IP_THRESHOLD : IP_HOUR_THRESHOLD;
  if (!(n === trigger || n % 10 === 0)) return Promise.resolve();
  return notifyAdmin(
    `🔒 <b>IP signup velocity — new accounts auto-locked</b>\n\n` +
      `IP <code>${ip}</code> created <b>${count}</b> accounts in 3 min / <b>${countHour}</b> in 1 hour — looks like a farming script.\n\n` +
      `Latest account (locked: withdrawals + referral rewards blocked): <code>${userId}</code>\n\n` +
      `If this is a shared network (cyber-café, mobile carrier), unlock the whole burst with one tap.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔓 Unlock all from this IP', callback_data: `lk_ipunlock_${ip}` }],
          [{ text: '👤 Review account', callback_data: `lk_profile_${userId}` }, { text: '🚫 Ban account', callback_data: `a_ban_${userId}` }],
        ],
      },
    }
  ).catch(() => {});
}

// Called when a NEW user signed up under `referrerDoc` (after the referrer's counters were updated).
async function checkReferralVelocity(referrerDoc) {
  try {
    if (!referrerDoc || referrerDoc.accountLocked || referrerDoc.velocityFlaggedAt) return;
    const since = Date.now() - REFERRAL_WINDOW_MS;
    const recent = (referrerDoc.recentReferralSignups || []).filter((x) => new Date(x).getTime() >= since).length;
    if (recent < REFERRAL_THRESHOLD) return;
    const usersCol = await getCollection('users');
    // atomic guard: only the first signup that crosses the line alerts
    const flagged = await usersCol.updateOne(
      { _id: referrerDoc._id, velocityFlaggedAt: { $exists: false } },
      { $set: { velocityFlaggedAt: new Date(), velocityFlaggedReason: 'referral_velocity' } }
    );
    if (flagged.modifiedCount > 0) {
      await notifyAdmin(
        `🚩 <b>Referral velocity alert (nothing blocked)</b>\n\n` +
          `Referrer <code>${referrerDoc.telegramId}</code> got <b>${REFERRAL_THRESHOLD}+</b> signups within <b>${REFERRAL_WINDOW_MS / 60000} minutes</b> — real promotion rarely moves this fast.\n\n` +
          `Check their referrals, then Lock if it looks fake or ignore if it is a real promotion.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔒 Lock', callback_data: `lk_lock_${referrerDoc.telegramId}` }, { text: '👤 Profile', callback_data: `lk_profile_${referrerDoc.telegramId}` }],
              [{ text: '🚫 Ban', callback_data: `a_ban_${referrerDoc.telegramId}` }],
            ],
          },
        }
      ).catch(() => {});
    }
  } catch (e) { console.error('checkReferralVelocity failed:', e); }
}

module.exports = { recordSignupAndCheck, alertIpBurst, checkReferralVelocity, IP_THRESHOLD, IP_HOUR_THRESHOLD, REFERRAL_THRESHOLD };
