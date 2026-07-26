// api/ads.js
// POST /api/ads
// Matches your EXISTING frontend fetch URL — no URL change needed.
//
// Two call shapes:
//   { action: 'request_session', network: 'adsgram'|'adsgramDaily'|'gigapub'|'monetag' }
//     -> { success: true, sessionId }
//
//   { action: 'adsgram'|'adsgramDaily'|'gigapub'|'monetag', sessionId }
//     -> { success: true, user: { coins: <newGoldValue> } }   (claims the reward)
//
// telegramId is NEVER trusted from the request body — always taken from
// the verified Telegram initData header.

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { createAdSession, claimAdSession, countClaimedToday } = require('../lib/adSession');
const { creditGoldForAd } = require('../lib/adReward');
const { getSettings } = require('../lib/settings');

const VALID_NETWORKS = ['adsgram', 'adsgramDaily', 'gigapub', 'monetag'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const initData = req.headers['x-telegram-init-data'] || '';
  const verify = verifyTelegramInitData(initData, process.env.BOT_TOKEN);
  if (!verify.valid) {
    return res.status(401).json({ success: false, message: 'invalid_auth' });
  }
  const telegramId = verify.user.id;

  const { action, network, sessionId } = req.body || {};

  try {
    // ── STEP 1: issue a session right before the ad plays ──────────
    if (action === 'request_session') {
      if (!VALID_NETWORKS.includes(network)) {
        return res.status(400).json({ success: false, message: 'unknown network' });
      }

      const settings = await getSettings();
      const dailyLimit = (settings.adDailyLimits && settings.adDailyLimits[network]) || 999;
      const claimedToday = await countClaimedToday(telegramId, network);
      if (claimedToday >= dailyLimit) {
        return res.status(200).json({ success: false, message: 'daily_limit_reached' });
      }

      const newSessionId = await createAdSession(telegramId, network);
      return res.status(200).json({ success: true, sessionId: newSessionId });
    }

    // ── STEP 2: claim reward after the ad finished ──────────────────
    if (VALID_NETWORKS.includes(action)) {
      if (!sessionId) {
        return res.status(400).json({ success: false, message: 'missing sessionId' });
      }

      const claim = await claimAdSession(telegramId, sessionId, action);
      if (!claim.ok) {
        return res.status(200).json({ success: false, message: claim.reason });
      }

      const settings = await getSettings();
      const amount = (settings.adRewardGold && settings.adRewardGold[action]) || 100;
      const result = await creditGoldForAd(telegramId, amount, action, `session_${sessionId}`);

      if (!result.success) {
        return res.status(200).json({ success: false, message: result.reason || 'credit_failed' });
      }

      // Matches apiCall()'s auto-merge: it does Object.assign(window.G, result.user)
      return res.status(200).json({ success: true, user: { coins: result.newGold } });
    }

    return res.status(400).json({ success: false, message: 'unknown action' });
  } catch (err) {
    console.error('ads endpoint error:', err);
    return res.status(500).json({ success: false, message: 'server error' });
  }
};
