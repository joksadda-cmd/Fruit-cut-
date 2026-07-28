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
const { computeRegen, MAX_TOKENS } = require('../lib/tokens');

const MINI_APP_URL = 'https://t.me/Fruit_cut_bot/PlayTo_Earn'; // update if your bot/app short-name differs

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, status: 'error', message: 'Method not allowed' });
  }

  try {
    const initData = req.headers['x-telegram-init-data'] || '';
    const { deviceId, referredBy } = req.body || {};
    const botToken = process.env.BOT_TOKEN;

    const verify = verifyTelegramInitData(initData, botToken);
    if (!verify.valid) {
      return res.status(401).json({ success: false, status: 'invalid_auth', reason: verify.reason });
    }

    const telegramId = verify.user.id;
    const username = verify.user.username || verify.user.first_name || 'Player';

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
        gold: 0,
        fruitCoin: 0,
        gameTokens: 3,       // starting tokens (matches frontend's default "3/10" display)
        lastTokenRegenAt: new Date(),
        lotteryTokens: 0,
        completedTasks: [],
        totalAdsWatched: 0,
        validReferralGiven: false,
        highScore: 0,
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

      // ── Instant referral reward (server-side only, never trust client) ──
      // Only fires once, right here at registration time, and only if the
      // referrer is a real, non-banned, different user.
      if (referredBy && String(referredBy) !== String(telegramId)) {
        const referrer = await findUserByTelegramId(usersCol, referredBy);
        if (referrer && !referrer.banned) {
          const updated = await usersCol.findOneAndUpdate(
            { _id: referrer._id },
            [
              {
                $set: {
                  // Referral bonus is the ONE way tokens can exceed the
                  // normal 10 cap (per spec) — natural 4h regen elsewhere
                  // caps at 10, this doesn't.
                  gameTokens: { $add: [{ $ifNull: ['$gameTokens', 3] }, 1] },
                  lotteryTokens: { $add: [{ $ifNull: ['$lotteryTokens', 0] }, 1] },
                  referralCount: { $add: [{ $ifNull: ['$referralCount', 0] }, 1] },
                  lastActive: new Date(),
                },
              },
            ],
            { returnDocument: 'after' }
          );

          const txCol = await getCollection('transactions');
          await txCol.insertOne({
            telegramId: referrer.telegramId,
            type: TRANSACTION_TYPES.REFERRAL_REWARD,
            amount: 0, // no gold/FC in the instant reward — just tokens (logged in meta)
            balanceAfter: updated ? updated.gold : referrer.gold,
            meta: { gameTokens: 1, lotteryTokens: 1, referredTelegramId: telegramId },
            createdAt: new Date(),
          });

          // Notification text matches the existing "Refer Reward Received!" format
          const joinedWho = username && username !== 'Player' ? `@${username}` : 'Someone';
          sendTelegramMessage(
            referrer.telegramId,
            `🎉 <b>Refer Reward Received!</b>\n\n` +
              `${joinedWho} joined using your invite link!\n\n` +
              `🎮 +1 Game Token added!\n` +
              `🎰 +1 Lottery Token added!\n\n` +
              `Keep inviting friends to earn more! 🚀`,
            {
              reply_markup: {
                inline_keyboard: [[{ text: '🎮 Open Game & Collect Reward', url: MINI_APP_URL }]],
              },
            }
          ).catch((e) => console.error('referral notify failed:', e));
        }
      }
    } else {
      const regen = computeRegen(user.gameTokens ?? 3, user.lastTokenRegenAt);
      const updateFields = { lastActive: new Date(), username };
      if (regen.changed) {
        updateFields.gameTokens = regen.gameTokens;
        updateFields.lastTokenRegenAt = regen.lastTokenRegenAt;
        user.gameTokens = regen.gameTokens;
        user.lastTokenRegenAt = regen.lastTokenRegenAt;
      }
      await usersCol.updateOne({ _id: user._id }, { $set: updateFields });
    }

    const finalRegen = computeRegen(user.gameTokens ?? 3, user.lastTokenRegenAt || new Date());

    return res.status(200).json({
      success: true,
      status: 'ok',
      user: {
        telegramId: user.telegramId,
        username: user.username,
        gold: user.gold,
        fruitCoin: user.fruitCoin,
        gameTokens: user.gameTokens ?? 3,
        maxTokens: MAX_TOKENS,
        nextTokenAt: finalRegen.nextTokenAt,
        lotteryTokens: user.lotteryTokens ?? 0,
        completedTasks: user.completedTasks ?? [],
        highScore: user.highScore,
        referralCount: user.referralCount,
      },
    });
  } catch (err) {
    console.error('auth error:', err);
    return res.status(500).json({ success: false, status: 'error', message: 'Server error' });
  }
};
