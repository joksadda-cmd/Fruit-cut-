// api/init.js
// Lightweight periodic-sync endpoint — the frontend polls this every so
// often (see index.html) just to refresh balances/tokens on screen.
//
// Registration/device-check already happens once via api/auth.js when the
// app first loads. This used to be a FULL COPY of that same registration
// logic, running again on every sync tick — two independent code paths
// writing to the same users/devices collections is exactly the kind of
// thing that causes race conditions. Now this is read-only (except for
// the token-regen tick, which is safe to run repeatedly).

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { applyRegen, MAX_TOKENS } = require('../lib/tokens');

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

    // Atomic (compare-and-swap) regen — see lib/tokens.js. This endpoint
    // polls frequently, so it's the most likely place to race api/auth.js
    // on a fresh app open; applyRegen makes that race harmless instead of
    // letting both sides double-apply a tick jump.
    const regen = await applyRegen(usersCol, user);
    user.gameTokens = regen.gameTokens;

    return res.status(200).json({
      success: true,
      status: 'ok',
      user: {
        coins: user.gold,               // frontend's window.G.coins field
        fruitCoin: user.fruitCoin,
        tokens: user.gameTokens ?? 3,   // frontend's window.G.tokens field
        maxTokens: MAX_TOKENS,
        nextTokenAt: regen.nextTokenAt,
        highScore: user.highScore,
        referralCount: user.referralCount,
      },
    });
  } catch (err) {
    console.error('init sync error:', err);
    return res.status(500).json({ success: false, status: 'error', message: 'Server error' });
  }
};
