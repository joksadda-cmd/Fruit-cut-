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
const { rateGuard } = require('../lib/rateLimit');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { getLevelProgress } = require('../lib/levelSystem');
const { getAdCountsToday } = require('../lib/adSession');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, status: 'error', message: 'Method not allowed' });
  }

  try {
    const initData = req.headers['x-telegram-init-data'] || '';
    const botToken = process.env.BOT_TOKEN;

    const verify = verifyTelegramInitData(initData, botToken);
    if (await rateGuard(req, res, verify, 'init')) return; // flood protection (lib/rateLimit.js)
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

    // ── All Games section (list + play counter). Kept in this file because the
    // Vercel Hobby plan allows max 12 serverless functions. ──────────────────
    const body = req.body || {};
    if (body.action === 'list_games') {
      const gamesCol = await getCollection('games');
      // FAST PATH: small pages (12), only the 4 fields the app shows, no countDocuments
      // (we ask for one extra row to know if there is a next page), served by the
      // games {isActive, createdAt} index created in lib/db.js.
      const page = Math.max(0, parseInt(body.page, 10) || 0);
      const limit = Math.min(24, Math.max(1, parseInt(body.limit, 10) || 12));
      const rows = await gamesCol
        .find({ isActive: { $ne: false } }, { projection: { title: 1, thumbnail: 1, gameUrl: 1, category: 1 } })
        .sort({ createdAt: -1 })
        .skip(page * limit)
        .limit(limit + 1)
        .toArray();
      const hasMore = rows.length > limit;
      return res.status(200).json({
        success: true,
        page,
        hasMore,
        total: page === 0 && rows.length === 0 ? 0 : undefined,
        games: rows.slice(0, limit).map((g) => ({ id: String(g._id), title: g.title, thumbnail: g.thumbnail || '', gameUrl: g.gameUrl, category: g.category || '' })),
      });
    }
    if (body.action === 'game_played') {
      try {
        const { ObjectId } = require('mongodb');
        const gamesCol = await getCollection('games');
        await gamesCol.updateOne({ _id: new ObjectId(String(body.gameId)) }, { $inc: { playCount: 1 } });
      } catch (e) { /* ignore bad ids */ }
      return res.status(200).json({ success: true });
    }

    // Pending gift (created via the admin bot's "Send Gift" flow) — the
    // frontend shows an animated gift-box popup if this is non-null.
    // Claiming happens through /api/game_claim (action: 'claim_gift') so
    // the credit only ever happens once, even if init polls again before
    // the popup is dismissed.
    const giftsCol = await getCollection('gifts');
    const pendingGift = await giftsCol.findOne(
      { telegramId: user.telegramId, status: 'pending' },
      { sort: { createdAt: 1 } }
    );

    const levelProg = getLevelProgress(user.xp || 0);
    const adCounts = await getAdCountsToday(telegramId).catch(() => null);

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
        ...(adCounts ? { adCounts } : {}),
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
