// api/init.js
// Lightweight periodic-sync endpoint — the frontend polls this every so
// often (see index.html) just to refresh balances on screen.
//
// Registration/device-check already happens once via api/auth.js when the
// app first loads. This used to be a FULL COPY of that same registration
// logic, running again on every sync tick — two independent code paths
// writing to the same users/devices collections is exactly the kind of
// thing that causes race conditions. Now this is purely read-only.
// (The old game-token/energy system that used to live here was removed —
// it never actually gated any gameplay action, just displayed a number
// nothing consumed.)

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { getLevelProgress } = require('../lib/levelSystem');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, status: 'error', message: 'Method not allowed' });
  }

  try {
    const initData = req.headers['x-telegram-init-data'] || '';
    const botToken = process.env.BOT_TOKEN;

    const verify = verifyTelegramInitData(initData, botToken);
    if (!verify.valid) {
      return res.status(401).json({ success: false, status: 'invalid_auth', reason: verify.reason });
    }

    const telegramId = verify.user.id;
    const usersCol = await getCollection('users');
    const user = await findUserByTelegramId(usersCol, telegramId);

    if (!user) {
      // Shouldn't normally happen (api/auth.js registers on app load first),
      // but fail soft rather than 500 — frontend just skips this sync tick.
      return res.status(200).json({ success: false, status: 'not_registered' });
    }

    if (user.banned) {
      return res.status(200).json({ success: false, status: 'blocked_banned' });
    }

    // Pending gift (created via the admin bot's "Send Gift" flow) — the
    // frontend shows an animated gift-box popup if this is non-null.
    // Claiming happens through the separate /api/gift_claim endpoint so
    // the credit only ever happens once, even if init polls again before
    // the popup is dismissed.
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
        fruitCoin: user.fruitCoin,
        xp: user.xp || 0,
        photoUrl: user.photoUrl || null,
        referralCount: user.referralCount,
        referralFruitCoinEarned: user.referralFruitCoinEarned ?? 0,
        lastDailyGiftAt: user.lastDailyGiftAt ?? null,
        lastSlashAt: user.lastSlashAt ?? null,
        level: levelProg.level,
        levelProgress: levelProg,
        totalSlices: user.totalSlices || 0,
      },
      pendingGift: pendingGift
        ? { id: pendingGift._id, amount: pendingGift.amount, reason: pendingGift.reason }
        : null,
    });
  } catch (err) {
    console.error('init sync error:', err);
    return res.status(500).json({ success: false, status: 'error', message: 'Server error' });
  }
};
