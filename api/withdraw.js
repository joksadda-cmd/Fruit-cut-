// api/withdraw.js
// POST /api/withdraw   — routed by body.action
//
//   { action: 'status' }  (or no action, no amount)
//     -> { success:true, status:{ level, levelNeeded, lifetimeTasks, tasksNeeded,
//                                  channelsJoined, walletAddress, walletLocked,
//                                  minFc, maxFc, feePercent, adVerified } }
//
//   { action: 'ad_session' }
//     -> { success:true, sessionId }
//     Creates a one-time Adsgram ad-gate session. Frontend must then play the
//     ad (showAdsgramSpecialAd()) and claim it before submitting a request.
//
//   { action: 'ad_claim', sessionId }
//     -> { success:true }  once the ad genuinely finished (mirrors api/ads.js's
//        claimAdSession, but on the separate 'withdrawGate' network so this
//        ad does NOT also pay out an ad reward — it's a gate, not a reward).
//
//   { action: 'history' }
//     -> { success:true, history: [ {amount, convertedAmount, unit, method,
//                                     address, status, createdAt} ] }
//
//   { action: 'request', amount, address, adSessionId }  (default action)
//     -> { success:true, convertedAmount, unit }
//     Creates a 'withdrawals' doc with status 'pending' — same shape the
//     admin bot (api/bot.js, a_withdrawals / a_wd_ok_ / a_wd_wra_ handlers)
//     already expects and fully implements (approve / reject / wrong-address
//     10% penalty refund). That admin side was already correct; only this
//     user-facing creation endpoint was missing.
//
// telegramId is NEVER trusted from the client — always taken from the
// server-verified Telegram initData header, same as every other endpoint.

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { getLevelForXp } = require('../lib/levelSystem');
const { checkChannelMembership } = require('../lib/joinGate');
const { getSettings } = require('../lib/settings');
const { createAdSession, claimAdSession } = require('../lib/adSession');
const { WITHDRAW_AD_NETWORK, WITHDRAW_AD_SESSION_MAX_AGE_MS, TRANSACTION_TYPES } = require('../lib/constants');

const FC_TO_USDT_RATE = 0.00002; // 50,000 FC = $1 USDT — matches existing frontend WITHDRAW_RATES

function levelOf(user) {
  // Matches the level number already shown everywhere else in the app
  // (api/init.js, api/auth.js both call getLevelProgress(user.xp||0)),
  // so "Level 3" here is the exact same Level 3 the player sees on screen.
  return getLevelForXp(user.xp || 0);
}

async function buildStatus(user, settings) {
  const channels = await checkChannelMembership(user.telegramId);
  const allJoined = channels.every((c) => c.joined);
  const lifetimeTasks = (user.completedTasks || []).length;

  return {
    level: levelOf(user),
    levelNeeded: settings.withdrawMinLevel ?? 3,
    lifetimeTasks,
    tasksNeeded: settings.withdrawMinLifetimeTasks ?? 5,
    channelsJoined: allJoined,
    channels,
    walletAddress: user.withdrawWalletAddress || null,
    walletLocked: !!user.withdrawWalletAddress,
    minFc: settings.withdrawMinFc ?? 2500,
    maxFc: settings.withdrawMaxFc ?? 100000,
    feePercent: settings.withdrawalFeePercent ?? 10,
    balance: user.fruitCoin || 0,
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const initData = req.headers['x-telegram-init-data'] || '';
    const verify = verifyTelegramInitData(initData, process.env.BOT_TOKEN);
    if (!verify.valid) {
      return res.status(401).json({ success: false, message: 'invalid_auth' });
    }
    const telegramId = verify.user.id;

    const usersCol = await getCollection('users');
    const user = await findUserByTelegramId(usersCol, telegramId);
    if (!user) return res.status(404).json({ success: false, message: 'user_not_found' });
    if (user.banned) return res.status(403).json({ success: false, message: 'Account suspended' });

    const body = req.body || {};
    const action = body.action || (body.amount ? 'request' : 'status');
    const settings = await getSettings();

    // ── status ────────────────────────────────────────────────────
    if (action === 'status') {
      const status = await buildStatus(user, settings);
      return res.status(200).json({ success: true, status });
    }

    // ── ad gate: create session ─────────────────────────────────────
    if (action === 'ad_session') {
      const sessionId = await createAdSession(telegramId, WITHDRAW_AD_NETWORK);
      return res.status(200).json({ success: true, sessionId });
    }

    // ── ad gate: claim after the ad actually finished ────────────────
    if (action === 'ad_claim') {
      const { sessionId } = body;
      if (!sessionId) return res.status(400).json({ success: false, message: 'missing sessionId' });
      const claim = await claimAdSession(telegramId, sessionId, WITHDRAW_AD_NETWORK);
      if (!claim.ok) {
        return res.status(200).json({ success: false, message: claim.reason });
      }
      return res.status(200).json({ success: true });
    }

    // ── history ──────────────────────────────────────────────────────
    if (action === 'history') {
      const withdrawalsCol = await getCollection('withdrawals');
      const history = await withdrawalsCol
        .find({ telegramId })
        .sort({ createdAt: -1 })
        .limit(30)
        .toArray();
      return res.status(200).json({
        success: true,
        history: history.map((w) => ({
          amount: w.amount,
          convertedAmount: w.convertedAmount,
          unit: w.unit,
          method: w.method,
          address: w.address,
          status: w.status,
          createdAt: w.createdAt,
        })),
      });
    }

    // ── request: create a new withdrawal ──────────────────────────────
    if (action === 'request') {
      const amount = parseInt(body.amount, 10) || 0;
      const address = (body.address || '').trim();
      const adSessionId = body.adSessionId || '';

      const minFc = settings.withdrawMinFc ?? 2500;
      const maxFc = settings.withdrawMaxFc ?? 100000;
      const minLevel = settings.withdrawMinLevel ?? 3;
      const minTasks = settings.withdrawMinLifetimeTasks ?? 5;
      const feePercent = settings.withdrawalFeePercent ?? 10;

      if (!address) return res.status(200).json({ success: false, error: 'Enter your wallet address.' });
      if (!amount || amount < minFc) {
        return res.status(200).json({ success: false, error: `Minimum withdrawal is ${minFc.toLocaleString()} Fruit Coin.` });
      }
      if (amount > maxFc) {
        return res.status(200).json({ success: false, error: `Maximum withdrawal is ${maxFc.toLocaleString()} Fruit Coin per request.` });
      }
      if ((user.fruitCoin || 0) < amount) {
        return res.status(200).json({ success: false, error: 'Not enough Fruit Coin balance.' });
      }

      // Level gate
      const level = levelOf(user);
      if (level < minLevel) {
        return res.status(200).json({ success: false, error: `Reach Level ${minLevel} to unlock withdrawals (you're Level ${level}).` });
      }

      // Lifetime task gate
      const lifetimeTasks = (user.completedTasks || []).length;
      if (lifetimeTasks < minTasks) {
        return res.status(200).json({ success: false, error: `Complete ${minTasks} tasks first (${lifetimeTasks}/${minTasks}).` });
      }

      // Channel/community join gate (existing mechanism)
      const channels = await checkChannelMembership(telegramId);
      if (!channels.every((c) => c.joined)) {
        return res.status(200).json({ success: false, error: 'Join our Official Channel & Community first.' });
      }

      // Mandatory pre-withdraw ad watch — must be a freshly-claimed session
      // on the withdrawGate network, not older than WITHDRAW_AD_SESSION_MAX_AGE_MS,
      // and not already spent on an earlier withdrawal.
      if (!adSessionId) {
        return res.status(200).json({ success: false, error: 'Please watch the ad to continue.' });
      }
      const adSessionsCol = await getCollection('adSessions');
      const adSession = await adSessionsCol.findOne({ sessionId: adSessionId });
      if (
        !adSession ||
        adSession.telegramId !== telegramId ||
        adSession.network !== WITHDRAW_AD_NETWORK ||
        adSession.status !== 'claimed' ||
        adSession.consumedForWithdraw ||
        Date.now() - new Date(adSession.claimedAt).getTime() > WITHDRAW_AD_SESSION_MAX_AGE_MS
      ) {
        return res.status(200).json({ success: false, error: 'Ad verification expired — please watch the ad again.' });
      }

      // Permanent wallet address: first successful request locks it in.
      // After that, every request must use the SAME address (server-enforced —
      // the frontend also disables editing once set, but this is the real gate).
      if (user.withdrawWalletAddress && user.withdrawWalletAddress !== address) {
        return res.status(200).json({
          success: false,
          error: `Your withdraw address is locked to ${user.withdrawWalletAddress}. Contact support to change it.`,
        });
      }

      // Atomically consume the ad session first (closes the reuse window).
      const consumed = await adSessionsCol.updateOne(
        { sessionId: adSessionId, status: 'claimed', consumedForWithdraw: { $ne: true } },
        { $set: { consumedForWithdraw: true } }
      );
      if (consumed.modifiedCount === 0) {
        return res.status(200).json({ success: false, error: 'Ad verification already used — please watch again.' });
      }

      // Atomically deduct balance (re-check balance in the filter to close races).
      const updatedUser = await usersCol.findOneAndUpdate(
        { _id: user._id, fruitCoin: { $gte: amount } },
        {
          $inc: { fruitCoin: -amount },
          $set: {
            lastActive: new Date(),
            lastWithdrawRequestAt: new Date(),
            ...(user.withdrawWalletAddress ? {} : { withdrawWalletAddress: address }),
          },
        },
        { returnDocument: 'after' }
      );
      if (!updatedUser) {
        // Balance changed between the earlier check and now — refund the ad session so it isn't wasted.
        await adSessionsCol.updateOne({ sessionId: adSessionId }, { $set: { consumedForWithdraw: false } });
        return res.status(200).json({ success: false, error: 'Not enough Fruit Coin balance.' });
      }

      const feeFc = Math.round(amount * (feePercent / 100));
      const netFc = amount - feeFc;
      const convertedAmount = (netFc * FC_TO_USDT_RATE).toFixed(4);
      const unit = 'USDT';
      const method = 'tonkeeper';

      const withdrawalsCol = await getCollection('withdrawals');
      await withdrawalsCol.insertOne({
        telegramId,
        username: user.username || 'unknown',
        amount,
        feeFc,
        convertedAmount,
        unit,
        method,
        address,
        status: 'pending',
        createdAt: new Date(),
      });

      const txCol = await getCollection('transactions');
      await txCol.insertOne({
        telegramId,
        type: TRANSACTION_TYPES.WITHDRAWAL,
        amount: -amount,
        currency: 'FC',
        balanceAfter: updatedUser.fruitCoin,
        meta: { address, unit, convertedAmount },
        createdAt: new Date(),
      });

      return res.status(200).json({
        success: true,
        convertedAmount,
        unit,
        user: { fruitCoin: updatedUser.fruitCoin, gems: updatedUser.fruitCoin },
      });
    }

    return res.status(400).json({ success: false, message: 'unknown action' });
  } catch (err) {
    console.error('withdraw error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
