// api/auth.js  (replaces the old Firebase /api/init route — keep same
// fetch URL '/api/init' in your frontend, OR rename to '/api/auth', your
// choice — just make sure frontend and this file's route match)
//
// Two call shapes (merged from the old separate api/checkJoin.js — Vercel
// Hobby caps a project at 12 Serverless Functions, see api/verify_task.js's
// header comment for the same reasoning):
//   { action: 'check_join' }                        -> channel-join status check
//   { action: 'accept_terms' }                       -> mark terms accepted
//   { action: 'referral_captcha_start' }             -> issue a new captcha challenge
//   { action: 'referral_captcha_verify', tappedSequence } -> verify a solve attempt
//   { deviceId, referredBy, photoUrl } (default)     -> register/sync user
//
// Reads initData from the 'x-telegram-init-data' HEADER — matches your
// existing frontend pattern (apiCall() and initApp() already send this).
//
// Body: { deviceId: string, referredBy: string|null }
//   (telegramId/username are NEVER trusted from the client — they come
//    only from the server-verified initData)
//
// Response shapes:
//   { success: true, user: {...}, status: 'ok' }
//   { success: false, status: 'blocked_device', ownerInfo: { username, telegramId } }
//   { success: false, status: 'blocked_banned' }
//   { success: false, status: 'invalid_auth' }

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { rateGuard } = require('../lib/rateLimit');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { sendTelegramMessage } = require('../lib/notify');
const { DEVICE_MULTI_ACCOUNT_BAN_THRESHOLD, INTERSTITIAL_ADS } = require('../lib/constants');
const { getLevelProgress } = require('../lib/levelSystem');
const { checkChannelMembership } = require('../lib/joinGate');
const { checkReferralStep1, startReferralCaptcha, verifyReferralCaptcha, grantWeeklyReferralValidity } = require('../lib/referral');
const { handleOnboardingAction, onboardingState } = require('../lib/onboarding');
const { recordSignupAndCheck, alertIpBurst, checkReferralVelocity } = require('../lib/velocity');
const { checkSignupBurst } = require('../lib/signupBursts');
const { isBannedInRegistry, registerBan } = require('../lib/lockup');

const MINI_APP_URL = 'https://t.me/Fruit_cut_bot/PlayTo_Earn'; // update if your bot/app short-name differs

// The device-fingerprint check below only ever ran when the client sent a
// non-empty `deviceId` — a script that simply left it out of the request
// body skipped the whole "one device, one account" system for free. The
// real frontend's getDeviceId() always returns SOME string (falls back to
// 'dev_unknown' even if every fingerprint source throws), so this fallback
// only ever engages for requests that were hand-crafted without it.
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function handleAcceptTerms(req, res, telegramId) {
  const usersCol = await getCollection('users');
  await usersCol.updateOne({ telegramId }, { $set: { termsAcceptedAt: new Date() } });
  return res.status(200).json({ success: true });
}

// ── Referral verification captcha (see lib/referral.js for full design
// rationale) — two thin action handlers, the actual logic lives there so
// it stays with the referral feature it serves. ──
async function handleReferCaptchaStart(req, res, telegramId) {
  const result = await startReferralCaptcha(telegramId);
  return res.status(200).json(result);
}
async function handleReferCaptchaVerify(req, res, telegramId) {
  const { tappedSequence } = req.body || {};
  const result = await verifyReferralCaptcha(telegramId, tappedSequence);
  return res.status(200).json(result);
}

async function handleCheckJoin(req, res, telegramId) {
  const channels = await checkChannelMembership(telegramId);
  const allJoined = channels.every((c) => c.joined);

  if (allJoined) {
    const usersCol = await getCollection('users');
    const user = await findUserByTelegramId(usersCol, telegramId);
    if (user && user.referredBy && !user.referStep1Given) {
      checkReferralStep1(user).catch(() => {});
    }
  }

  return res.status(200).json({ success: true, allJoined, channels });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, status: 'error', message: 'Method not allowed' });
  }

  try {
    const initData = req.headers['x-telegram-init-data'] || '';
    const { deviceId, referredBy: rawReferredBy, photoUrl: clientPhotoUrl, action } = req.body || {};
    const botToken = process.env.BOT_TOKEN;

    // referredBy validation
    const referredBy = typeof rawReferredBy === 'string' && /^\d+$/.test(rawReferredBy) ? rawReferredBy : null;

    const verify = verifyTelegramInitData(initData, botToken);
    if (await rateGuard(req, res, verify, 'auth')) return; // flood protection (lib/rateLimit.js)
    if (!verify.valid) {
      return res.status(401).json({ success: false, status: 'invalid_auth', reason: verify.reason });
    }

    const telegramId = verify.user.id;

    if (action === 'check_join') {
      return await handleCheckJoin(req, res, telegramId);
    }
    if (action === 'accept_terms') {
      return await handleAcceptTerms(req, res, telegramId);
    }
    if (typeof action === 'string' && action.startsWith('onboard_')) {
      const result = await handleOnboardingAction(action, telegramId, req.body || {}, {
        // After the final step: count this referral for the weekly contest right away.
        onReferralVerified: async (verifiedUser) => {
          await checkReferralStep1(verifiedUser).catch(() => {});
          const usersCol = await getCollection('users');
          const fresh = await findUserByTelegramId(usersCol, verifiedUser.telegramId);
          if (fresh) await grantWeeklyReferralValidity(fresh);
        },
      });
      return res.status(200).json(result);
    }
    if (action === 'referral_captcha_start') {
      return await handleReferCaptchaStart(req, res, telegramId);
    }
    if (action === 'referral_captcha_verify') {
      return await handleReferCaptchaVerify(req, res, telegramId);
    }

    const username = verify.user.username || verify.user.first_name || 'Player';
    const photoUrl = verify.user.photo_url || clientPhotoUrl || null;
    const clientIp = getClientIp(req);
    // A request that never sent a real deviceId (a hand-rolled script call,
    // not the actual mini-app) still gets checked against a fingerprint —
    // just an IP-based one instead of skipping the check entirely.
    const fingerprint = deviceId || `ip_${clientIp}`;

    const usersCol = await getCollection('users');
    const devicesCol = await getCollection('devices');

    let user = await findUserByTelegramId(usersCol, telegramId);

    // ── Ban check ────────────────────────────────────────────────
    if (user && user.banned) {
      return res.status(200).json({ success: false, status: 'blocked_banned' });
    }

    // ── Device conflict check ───────────────────────────────────
    // First telegramId ever seen on a deviceId "owns" that device.
    // A different telegramId showing up on the same deviceId gets
    // blocked and shown who currently owns it (matches Rashu's reference
    // screenshot from Mining Buddies).
    // Legacy clients (cached old index.html) still send the old weak 'dev_xxxx'
    // hash, which collides between unrelated phones — never block on it.
    const isLegacyFingerprint = typeof deviceId === 'string' && deviceId.startsWith('dev_');
    if (!isLegacyFingerprint) {
      const deviceOwner = await devicesCol.findOne({ deviceId: fingerprint });

      // String(...) both sides — deviceOwner.telegramId may have been
      // written by older code as a Number; strict !== was wrongly
      // blocking the device's TRUE owner because "123" !== 123.
      if (deviceOwner && String(deviceOwner.telegramId) !== telegramId) {
        const owner = await findUserByTelegramId(usersCol, deviceOwner.telegramId);

        // ── Multi-account enforcement, step 2: repeated attempts ban the
        // ORIGINAL owner, not just refuse the new attempt. $addToSet keeps
        // this to DISTINCT attempting telegramIds — one account retrying
        // this same second telegramId over and over doesn't count multiple
        // times, since that's a UI-refresh loop, not new farmed accounts. ──
        const updatedDevice = await devicesCol.findOneAndUpdate(
          { deviceId: fingerprint },
          { $addToSet: { blockedAttempts: telegramId }, $set: { lastBlockedAt: new Date() } },
          { returnDocument: 'after' }
        );
        const distinctAttempts = (updatedDevice && updatedDevice.blockedAttempts) ? updatedDevice.blockedAttempts.length : 0;

        if (owner && !owner.banned && distinctAttempts >= DEVICE_MULTI_ACCOUNT_BAN_THRESHOLD) {
          await usersCol.updateOne({ _id: owner._id }, { $set: { banned: true, bannedReason: 'multi_account_device', bannedAt: new Date() } });
          registerBan(owner.telegramId, 'multi_account_device').catch(() => {});
          sendTelegramMessage(
            owner.telegramId,
            `🚫 <b>Account Suspended</b>\n\n` +
              `Your account was suspended for violating the "one device, one account" rule — multiple different accounts were opened from your device.`
          ).catch(() => {});
          return res.status(200).json({ success: false, status: 'blocked_banned' });
        }

        return res.status(200).json({
          success: false,
          status: 'blocked_device',
          ownerInfo: {
            username: owner ? owner.username : 'Unknown',
            // masked: a blocked person doesn't need the owner's full Telegram ID
            telegramId: String(deviceOwner.telegramId).replace(/^(\d{3})\d+(\d{3})$/, '$1****$2'),
          },
        });
      }

      if (!deviceOwner) {
        await devicesCol.insertOne({ deviceId: fingerprint, telegramId, firstSeenAt: new Date(), lastSeenAt: new Date() });
      } else {
        // the real owner is still active -> keep this device record from being cleaned up (TTL)
        devicesCol.updateOne({ deviceId: fingerprint }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
      }
    }

    // ── Ban registry: a banned Telegram ID can never register again, even after the
    //    banned user document was auto-deleted by the TTL cleanup (lib/ttlIndexes.js).
    if (!user && (await isBannedInRegistry(telegramId))) {
      return res.status(200).json({ success: false, status: 'blocked_banned' });
    }

    // ── Silent auto-register / update (no signup form) ─────────
    if (!user) {
      const newUser = {
        telegramId,
        username,
        photoUrl,
        fruitCoin: 0,
        xp: 0,
        lastDailyGiftAt: null,
        lastSlashAt: null,
        slashEarningsUsd: 0,
        totalSlices: 0,
        level: 1,
        completedTasks: [],
        totalAdsWatched: 0,
        validReferralGiven: false,
        totalGamesPlayed: 0,
        deviceId: deviceId || null,
        signupIp: clientIp,
        referredBy: referredBy || null,
        referralCount: 0,
        tonWallet: null,
        banned: false,
        termsAcceptedAt: null,
        onboardedAt: null,       // null = must pass onboarding (puzzle > bot code > join > language > terms)
        onboardStep: 'puzzle',
        joinedAt: new Date(),
        lastActive: new Date(),
      };
      // VELOCITY: too many brand-new accounts from one IP (3 min / 1 h windows) => the new
      // account is born LOCKED (no withdraw, no referral rewards) and the admin is alerted.
      const vel = await recordSignupAndCheck(clientIp);
      if (vel.locked) {
        newUser.accountLocked = true;
        newUser.accountLockedAt = new Date();
        newUser.accountLockedReason = 'ip_signup_velocity';
        newUser.velocityFlaggedAt = new Date();
        newUser.velocityFlaggedReason = 'ip_signup_velocity';
      }
      await usersCol.insertOne(newUser);
      user = newUser;
      if (vel.locked) alertIpBurst({ ip: clientIp, count: vel.count, countHour: vel.countHour, userId: telegramId });
      // Many accounts of ANY kind within 5 minutes (not only one IP) -> one alert to the admin, max every 15 min.
      // Awaited with a short cap: serverless can freeze work that is still running after the response.
      await Promise.race([checkSignupBurst(), new Promise((r) => setTimeout(r, 1200))]);

      // ── Instant referral link association (server-side only) ─────────
      if (referredBy && String(referredBy) !== String(telegramId)) {
        const referrer = await findUserByTelegramId(usersCol, referredBy);
        if (referrer && !referrer.banned) {
          const referrerAfter = await usersCol.findOneAndUpdate(
            { _id: referrer._id },
            {
              $inc: { referralCount: 1 },
              $set: { lastActive: new Date() },
              // rolling list of signup times under this referrer — feeds the referral
              // velocity alert (lib/velocity.js)
              $push: { recentReferralSignups: { $each: [new Date()], $slice: -50 } },
            },
            { returnDocument: 'after' }
          );
          checkReferralVelocity(referrerAfter);
          // NOTE: this new referral does NOT yet count toward the weekly
          // "Top Referrer" leaderboard — that only happens once the friend
          // has joined the channel+payment-channel and played their first game (see
          // checkReferralWeeklyValid in lib/referral.js, called from
          // api/slash.js). Crediting it here at signup would let anyone
          // farm the weekly FC pool with disposable accounts.

          const joinedWho = username && username !== 'Player' ? `@${username}` : 'Your friend';
          sendTelegramMessage(
            referrer.telegramId,
            `🎉 <b>New Friend Joined!</b>\n\n` +
              `${joinedWho} just joined using your invite link!\n\n` +
              `You will earn <b>+50 FC</b> as soon as they finish account verification, plus more at every milestone! 🍎\n\n` +
              `Keep inviting friends — earn up to 600 FC per friend + 15% of their withdrawals! 🚀`,
            {
              reply_markup: {
                inline_keyboard: [[{ text: '🎮 Open Game', url: MINI_APP_URL }]],
              },
            }
          ).catch((e) => console.error('referral notify failed:', e));
        }
      }
    } else {
      await usersCol.updateOne(
        { _id: user._id },
        {
          $set: {
            lastActive: new Date(),
            username,
            lastIp: clientIp,
            ...(photoUrl ? { photoUrl } : {}),
            // keep the stored id on the new unique format (used by the referral
            // "same device" checks too — the old weak hash gave false matches)
            ...(typeof deviceId === 'string' && deviceId.startsWith('dv2_') ? { deviceId } : {}),
          },
        }
      );
    }

    const giftsCol = await getCollection('gifts');
    const pendingGift = await giftsCol.findOne(
      { telegramId: user.telegramId, status: 'pending' },
      { sort: { createdAt: 1 } }
    );

    const levelProg = getLevelProgress(user.xp || 0);

    // Only worth showing the captcha to a user who: was referred, hasn't
    // already passed it, and whose referral isn't already resolved one way
    // or the other (valid or permanently blocked) — no point prompting
    // someone whose referral already counts, or already never will.
    // UPDATED 2026-09-28: the tap-captcha + ad step is no longer part of the
    // referral flow (a referral now counts after channel+payment-channel join + first
    // game — see lib/referral.js). Kept false so the frontend never shows it.
    const referCaptchaNeeded = false;

    return res.status(200).json({
      success: true,
      status: 'ok',
      user: {
        telegramId: user.telegramId,
        username: user.username,
        photoUrl: user.photoUrl || photoUrl || null,
        fruitCoin: user.fruitCoin,
        xp: user.xp || 0,
        lastDailyGiftAt: user.lastDailyGiftAt ?? null,
        lastSlashAt: user.lastSlashAt ?? null,
        completedTasks: user.completedTasks ?? [],
        termsAccepted: !!user.termsAcceptedAt,
        referralCount: user.referralCount,
        referralFruitCoinEarned: user.referralFruitCoinEarned ?? 0,
        level: levelProg.level,
        levelProgress: levelProg,
        totalSlices: user.totalSlices || 0,
        referCaptchaNeeded,
        onboarding: onboardingState(user),
        accountLocked: !!user.accountLocked,
      },
      pendingGift: pendingGift
        ? { id: pendingGift._id, amount: pendingGift.amount, reason: pendingGift.reason, title: pendingGift.title || null, icon: pendingGift.icon || null }
        : null,
      ads: {
        interstitialBlockId: process.env.ADSGRAM_INTERSTITIAL_BLOCK_ID || 'int-28067',
        minLevel: INTERSTITIAL_ADS.MIN_LEVEL,
        gameEveryMs: INTERSTITIAL_ADS.GAME_EVERY_MS,
        resumeAfterMs: INTERSTITIAL_ADS.RESUME_AFTER_MS,
      },
    });
  } catch (err) {
    console.error('auth error:', err);
    return res.status(500).json({ success: false, status: 'error', message: 'Server error' });
  }
};
