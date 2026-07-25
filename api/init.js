// api/init.js  (replaces the old Firebase /api/init route — keep same
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
const { getCollection } = require('../lib/db');

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

    let user = await usersCol.findOne({ telegramId });

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

      if (deviceOwner && deviceOwner.telegramId !== telegramId) {
        const owner = await usersCol.findOne({ telegramId: deviceOwner.telegramId });
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
    } else {
      await usersCol.updateOne(
        { telegramId },
        { $set: { lastActive: new Date(), username } }
      );
    }

    return res.status(200).json({
      success: true,
      status: 'ok',
      user: {
        telegramId: user.telegramId,
        username: user.username,
        coins: user.gold,        // frontend reads window.G.coins — DB field stays "gold" internally
        fruitCoin: user.fruitCoin,
        highScore: user.highScore,
        referralCount: user.referralCount,
      },
    });
  } catch (err) {
    console.error('auth error:', err);
    return res.status(500).json({ success: false, status: 'error', message: 'Server error' });
  }
};
