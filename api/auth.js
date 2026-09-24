// api/auth.js  (replaces the old Firebase /api/init route — keep same
// fetch URL '/api/init' in your frontend, OR rename to '/api/auth', your
// choice — just make sure frontend and this file's route match)
//
// Two call shapes (merged from the old separate api/checkJoin.js — Vercel
// Hobby caps a project at 12 Serverless Functions, see api/verify_task.js's
// header comment for the same reasoning):
//   { action: 'check_join' }                        -> channel-join status check
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
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { sendTelegramMessage } = require('../lib/notify');
const { DEVICE_MULTI_ACCOUNT_BAN_THRESHOLD } = require('../lib/constants');
const { getLevelProgress } = require('../lib/levelSystem');
const { checkChannelMembership } = require('../lib/joinGate');
const { checkReferralStep1 } = require('../lib/referral');

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
    {
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
          await usersCol.updateOne({ _id: owner._id }, { $set: { banned: true, bannedReason: 'multi_account_device' } });
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
            telegramId: deviceOwner.telegramId,
          },
        });
      }

      if (!deviceOwner) {
        await devicesCol.insertOne({ deviceId: fingerprint, telegramId, firstSeenAt: new Date() });
      }
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
        joinedAt: new Date(),
        lastActive: new Date(),
      };
      await usersCol.insertOne(newUser);
      user = newUser;

      // ── Instant referral link association (server-side only) ─────────
      if (referredBy && String(referredBy) !== String(telegramId)) {
        const referrer = await findUserByTelegramId(usersCol, referredBy);
        if (referrer && !referrer.banned) {
          await usersCol.updateOne(
            { _id: referrer._id },
            {
              $inc: { referralCount: 1 },
              $set: { lastActive: new Date() },
            }
          );
          // NOTE: this new referral does NOT yet count toward the weekly
          // "Top Referrer" leaderboard — that only happens once the friend
          // has played REFERRAL_WEEKLY_VALID_SLASH_COUNT slash games (see
          // checkReferralWeeklyValid in lib/referral.js, called from
          // api/slash.js). Crediting it here at signup would let anyone
          // farm the weekly FC pool with disposable accounts.

          const joinedWho = username && username !== 'Player' ? `@${username}` : 'Your friend';
          sendTelegramMessage(
            referrer.telegramId,
            `🎉 <b>New Friend Joined!</b>\n\n` +
              `${joinedWho} just joined using your invite link!\n\n` +
              `You will earn <b>+30 FC</b> when they verify channel membership! 🍎\n\n` +
              `Keep inviting friends to earn up to 430 FC per friend! 🚀`,
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
      },
      pendingGift: pendingGift
        ? { id: pendingGift._id, amount: pendingGift.amount, reason: pendingGift.reason }
        : null,
    });
  } catch (err) {
    console.error('auth error:', err);
    return res.status(500).json({ success: false, status: 'error', message: 'Server error' });
  }
};
