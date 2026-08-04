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
const { createAdSession, claimAdSession, countClaimedToday, revertAdSession } = require('../lib/adSession');
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
        console.warn(`[ads] claim failed: telegramId=${telegramId} network=${action} sessionId=${sessionId} reason=${claim.reason}`);
        return res.status(200).json({ success: false, message: claim.reason });
      }

      const settings = await getSettings();
      const amount = (settings.adRewardGold && settings.adRewardGold[action]) || 100;

      // CRITICAL FIX: the daily cap used to only be checked back in
      // request_session, based on a count of already-CLAIMED sessions.
      // Nothing stopped a script from pre-creating hundreds of PENDING
      // sessions first (countClaimedToday was still 0, so that check kept
      // passing) and then claiming them all back-to-back — this credit
      // step never rechecked the cap at all. Passing dailyLimitMax here
      // makes creditGoldForAd enforce it atomically at the only point
      // that actually matters: the moment gold is paid out.
      const dailyLimitMax = (settings.adDailyLimits && settings.adDailyLimits[action]) || 999;
      const result = await creditGoldForAd(telegramId, amount, action, `session_${sessionId}`, dailyLimitMax);

      if (!result.success) {
        console.warn(`[ads] credit failed: telegramId=${telegramId} network=${action} sessionId=${sessionId} reason=${result.reason}`);

        // A duplicate/idempotency hit means gold was already credited by an
        // earlier request for this exact session — never reopen that one,
        // it's not a real failure. A daily-limit hit means the cap is
        // genuinely reached for today — reopening it would just let the
        // same session get retried tomorrow for free, so don't. Everything
        // else (e.g. user_not_found, a transient DB error) means no reward
        // was actually given for an ad that really played, so give the
        // session a second chance instead of silently burning the user's
        // daily slot.
        const isDailyLimit = result.reason === 'daily_limit_reached';
        if (!result.duplicate && !isDailyLimit) {
          await revertAdSession(sessionId, telegramId);
        }

        return res.status(200).json({
          success: false,
          message: result.duplicate ? 'already_used' : (result.reason || 'credit_failed'),
          retryable: !result.duplicate && !isDailyLimit,
        });
      }

      // apiCall() on the frontend reads result.user.gold (same field name
      // used by api/auth.js) to auto-update the on-screen balance.
      return res.status(200).json({ success: true, user: { gold: result.newGold } });
    }

    return res.status(400).json({ success: false, message: 'unknown action' });
  } catch (err) {
    console.error('ads endpoint error:', err);
    return res.status(500).json({ success: false, message: 'server error' });
  }
};
