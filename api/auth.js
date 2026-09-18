// api/auth.js  (replaces the old Firebase /api/init route — keep same
// fetch URL '/api/init' in your frontend, OR rename to '/api/auth', your
// choice — just make sure frontend and this file's route match)
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
const { TRANSACTION_TYPES } = require('../lib/constants');
const { computeRegen, applyRegen, MAX_TOKENS } = require('../lib/tokens');
const { getLevelProgress } = require('../lib/levelSystem');

const MINI_APP_URL = 'https://t.me/Fruit_cut_bot/PlayTo_Earn'; // update if your bot/app short-name differs

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, status: 'error', message: 'Method not allowed' });
  }

  try {
    const initData = req.headers['x-telegram-init-data'] || '';
    const { deviceId, referredBy: rawReferredBy, photoUrl: clientPhotoUrl } = req.body || {};
    const botToken = process.env.BOT_TOKEN;

    // referredBy validation
    const referredBy = typeof rawReferredBy === 'string' && /^\d+$/.test(rawReferredBy) ? rawReferredBy : null;

    const verify = verifyTelegramInitData(initData, botToken);
    if (!verify.valid) {
      return res.status(401).json({ success: false, status: 'invalid_auth', reason: verify.reason });
    }

    const telegramId = verify.user.id;
    const username = verify.user.username || verify.user.first_name || 'Player';
    const photoUrl = verify.user.photo_url || clientPhotoUrl || null;

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
    if (deviceId) {
      const deviceOwner = await devicesCol.findOne({ deviceId });

      // String(...) both sides — deviceOwner.telegramId may have been
      // written by older code as a Number; strict !== was wrongly
      // blocking the device's TRUE owner because "123" !== 123.
      if (deviceOwner && String(deviceOwner.telegramId) !== telegramId) {
        const owner = await findUserByTelegramId(usersCol, deviceOwner.telegramId);
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
        await devicesCol.insertOne({ deviceId, telegramId, firstSeenAt: new Date() });
      }
    }

    // ── Silent auto-register / update (no signup form) ─────────
    if (!user) {
      const newUser = {
        telegramId,
        username,
        photoUrl,
        gold: 0,
        fruitCoin: 0,
        gameTokens: 3,       // starting tokens (matches frontend's default "3/10" display)
        lastTokenRegenAt: new Date(),
        lastFreeBoxAt: null,
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
        referredBy: referredBy || null,
        referralCount: 0,
        tonWallet: null,
        banned: false,
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
      // Atomic (compare-and-swap) regen — see lib/tokens.js for why this
      // replaced the old read → compute → blind-$set pattern that could
      // double-apply a tick jump when this endpoint and api/init.js's
      // periodic sync raced each other.
      const regen = await applyRegen(usersCol, user);
      user.gameTokens = regen.gameTokens;
      user.lastTokenRegenAt = regen.lastTokenRegenAt;
      await usersCol.updateOne(
        { _id: user._id },
        {
          $set: {
            lastActive: new Date(),
            username,
            ...(photoUrl ? { photoUrl } : {}),
          },
        }
      );
    }

    const finalRegen = computeRegen(user.gameTokens ?? 3, user.lastTokenRegenAt || new Date());

    const giftsCol = await getCollection('gifts');
    const pendingGift = await giftsCol.findOne(
      { telegramId: user.telegramId, status: 'pending' },
      { sort: { createdAt: 1 } }
    );

    const levelProg = getLevelProgress(user.totalSlices || 0);

    return res.status(200).json({
      success: true,
      status: 'ok',
      user: {
        telegramId: user.telegramId,
        username: user.username,
        photoUrl: user.photoUrl || photoUrl || null,
        gold: user.gold,
        fruitCoin: user.fruitCoin,
        gameTokens: user.gameTokens ?? 3,
        maxTokens: MAX_TOKENS,
        nextTokenAt: finalRegen.nextTokenAt,
        lastFreeBoxAt: user.lastFreeBoxAt ?? null,
        lastDailyGiftAt: user.lastDailyGiftAt ?? null,
        lastSlashAt: user.lastSlashAt ?? null,
        completedTasks: user.completedTasks ?? [],
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
