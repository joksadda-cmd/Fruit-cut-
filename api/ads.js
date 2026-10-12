// api/ads.js
// POST /api/ads
// Matches your EXISTING frontend fetch URL — no URL change needed.
//
// Two call shapes:
//   { action: 'request_session', network: 'adsgram'|'adsgramDaily'|'gigapub'|'monetag' }
//     -> { success: true, sessionId }
//
//   { action: 'adsgram'|'adsgramDaily'|'gigapub'|'monetag', sessionId }
//     -> { success: true, user: { fruitCoin: <newFruitCoinValue> } }   (claims the reward)
//
// telegramId is NEVER trusted from the request body — always taken from
// the verified Telegram initData header.

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { createAdSession, claimAdSession, countClaimedToday, revertAdSession, getAdSession } = require('../lib/adSession');
const { createChallenge, verifyChallenge } = require('../lib/adPuzzle');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { recordAdClaimAndCheck } = require('../lib/botGuard');
const { touch: touchGame, getState: getGameState, consumeClaim, refundClaim } = require('../lib/gamePlay');
const { creditAdReward } = require('../lib/adReward');
const { getSettings } = require('../lib/settings');

const VALID_NETWORKS = ['adsgram', 'adsgramDaily', 'gigapub', 'monetag', 'gameAd'];
// Adsgram rewards are only paid AFTER the user solves a server-issued image captcha.
const PUZZLE_NETWORKS = ['adsgram', 'adsgramDaily'];
const GAME_PROVIDERS = ['gigapub', 'adsgram'];
const GIGAPUB_MIN_WATCH_MS = 5000;

// Pays the reward (idempotent per session). For the in-game claim it also spends
// 3 minutes of server-measured play time, and gives it back if the credit fails.
async function payReward(telegramId, source, amount, sessionId) {
  const settings = await getSettings();
  const dailyLimitMax = (settings.adDailyLimits && settings.adDailyLimits[source]) || 999;
  if (source === 'gameAd') {
    const spent = await consumeClaim(telegramId);
    if (!spent) return { success: false, reason: 'play_more' };
  }
  const result = await creditAdReward(telegramId, amount, source, `session_${sessionId}`, dailyLimitMax);
  if (!result.success && source === 'gameAd') await refundClaim(telegramId);
  return result;
}

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

  const { action, network, sessionId, provider, gameId, puzzleToken, answer } = req.body || {};

  try {
    // LOCKUP ('bot_pattern' only): a script-locked account earns no more ad / game rewards.
    // Other lock reasons only block withdrawals and referral rewards.
    if (action && action !== 'game_start' && action !== 'game_ping') {
      const usersCol = await getCollection('users');
      const me = await findUserByTelegramId(usersCol, telegramId);
      if (me && me.accountLocked && me.accountLockedReason === 'bot_pattern') {
        return res.status(200).json({ success: false, message: 'account_locked' });
      }
    }

    // ── In-game play heartbeat (server measures real play time) ──────
    if (action === 'game_start' || action === 'game_ping') {
      const st = await touchGame(telegramId, gameId, action === 'game_start');
      const settings = await getSettings();
      const claimedToday = await countClaimedToday(telegramId, 'gameAd');
      return res.status(200).json({
        success: true,
        playMs: st.playMs,
        claimMs: st.claimMs,
        claimable: st.claimable,
        claimsToday: claimedToday,
        claimsMax: (settings.adDailyLimits && settings.adDailyLimits.gameAd) || 50,
        rewardFc: (settings.adRewardFc && settings.adRewardFc.gameAd) || 10,
      });
    }

    // ── Captcha answer -> reward ─────────────────────────────────────
    if (action === 'puzzle_verify') {
      const v = await verifyChallenge(telegramId, puzzleToken, answer);
      if (!v.ok) {
        return res.status(200).json({ success: false, message: v.error, final: !!v.final, image: v.image, triesLeft: v.triesLeft });
      }
      const ch = v.challenge;
      const result = await payReward(telegramId, ch.source, ch.amount, ch.sessionId);
      if (!result.success) {
        const isDailyLimit = result.reason === 'daily_limit_reached';
        console.warn(`[ads] puzzle credit failed: telegramId=${telegramId} source=${ch.source} reason=${result.reason}`);
        return res.status(200).json({ success: false, message: result.duplicate ? 'already_used' : (result.reason || 'credit_failed'), final: true, retryable: false });
      }
      return res.status(200).json({ success: true, rewardFc: ch.amount, user: { fruitCoin: result.newFruitCoin, gems: result.newFruitCoin } });
    }

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

      let extra = {};
      if (network === 'gameAd') {
        if (!GAME_PROVIDERS.includes(provider)) return res.status(400).json({ success: false, message: 'unknown provider' });
        const gs = await getGameState(telegramId);
        if (!gs.claimable) return res.status(200).json({ success: false, message: 'play_more' });
        extra = { provider };
      }
      const newSessionId = await createAdSession(telegramId, network, extra);
      return res.status(200).json({ success: true, sessionId: newSessionId });
    }

    // ── STEP 2: claim reward after the ad finished ──────────────────
    if (VALID_NETWORKS.includes(action)) {
      if (!sessionId) {
        return res.status(400).json({ success: false, message: 'missing sessionId' });
      }

      // In-game GigaPub claim: GigaPub's own server must have confirmed the view
      // (S2S postback marks the session) and at least 5s must have passed.
      let gameProvider = null;
      if (action === 'gameAd') {
        const sess = await getAdSession(sessionId);
        gameProvider = sess && sess.provider;
        if (gameProvider === 'gigapub' && sess.status === 'pending') {
          if (Date.now() - new Date(sess.createdAt).getTime() < GIGAPUB_MIN_WATCH_MS) {
            return res.status(200).json({ success: false, message: 'too_fast', retryable: true });
          }
          if (!sess.postbackSeen) {
            return res.status(200).json({ success: false, message: 'waiting_postback', retryable: true });
          }
        }
      }

      const claim = await claimAdSession(telegramId, sessionId, action);
      if (!claim.ok) {
        console.warn(`[ads] claim failed: telegramId=${telegramId} network=${action} sessionId=${sessionId} reason=${claim.reason}`);
        return res.status(200).json({ success: false, message: claim.reason });
      }

      // Script detection (lib/botGuard.js): record this claim; if the timing pattern is clearly
      // a script the account gets locked and THIS claim is rejected.
      {
        const usersCol = await getCollection('users');
        const me = await findUserByTelegramId(usersCol, telegramId);
        const sess = await getAdSession(sessionId);
        if (me && sess && (await recordAdClaimAndCheck(me, { createdAt: sess.createdAt, network: action }))) {
          return res.status(200).json({ success: false, message: 'account_locked' });
        }
      }

      const settings = await getSettings();
      const amount = (settings.adRewardFc && settings.adRewardFc[action]) || (action === 'gameAd' ? 10 : 20);

      // Adsgram (Ads section + in-game Adsgram claim): NO reward yet — the user must
      // first solve a server-issued captcha (see lib/adPuzzle.js).
      if (PUZZLE_NETWORKS.includes(action) || (action === 'gameAd' && gameProvider === 'adsgram')) {
        const challenge = await createChallenge({ telegramId, sessionId, source: action, amount });
        return res.status(200).json({ success: true, needPuzzle: true, ...challenge, rewardFc: amount });
      }

      // CRITICAL FIX: atomic limit enforcement (payReward also handles play-time for gameAd)
      const result = await payReward(telegramId, action, amount, sessionId);

      if (!result.success) {
        console.warn(`[ads] credit failed: telegramId=${telegramId} network=${action} sessionId=${sessionId} reason=${result.reason}`);

        const isDailyLimit = result.reason === 'daily_limit_reached';
        if (!result.duplicate && !isDailyLimit && result.reason !== 'play_more') {
          await revertAdSession(sessionId, telegramId);
        }

        return res.status(200).json({
          success: false,
          message: result.duplicate ? 'already_used' : (result.reason || 'credit_failed'),
          retryable: !result.duplicate && !isDailyLimit,
        });
      }

      // apiCall() auto-updates on-screen balance
      return res.status(200).json({
        success: true,
        rewardFc: amount, // the SERVER decides the reward; the client only displays this
        user: {
          fruitCoin: result.newFruitCoin,
          gems: result.newFruitCoin,
        },
      });
    }

    return res.status(400).json({ success: false, message: 'unknown action' });
  } catch (err) {
    console.error('ads endpoint error:', err);
    return res.status(500).json({ success: false, message: 'server error' });
  }
};
