// api/withdraw.js
// POST /api/withdraw   — routed by body.action
//
//   { action: 'status' }  (or no action, no amount)
//     -> { success:true, status:{ level, limits:{ requests, used, remaining, maxFc, minFc,
//                                  dayUsed, dayLimit, nextAt }, lifetimeTasks, tasksNeeded,
//                                  channelsJoined, walletAddress, walletLocked, feePercent } }
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
const { rateGuard } = require('../lib/rateLimit');
const { getCollection, findUserByTelegramId, idVariants } = require('../lib/db');
const { getLevelForXp } = require('../lib/levelSystem');
const { checkChannelMembership } = require('../lib/joinGate');
const { getSettings } = require('../lib/settings');
const { alertWithdrawal } = require('../lib/withdrawAlert');
const { createAdSession, claimAdSession } = require('../lib/adSession');
const { withdrawRisk } = require('../lib/guardian');
const { WITHDRAW_AD_NETWORK, WITHDRAW_AD_SESSION_MAX_AGE_MS, TRANSACTION_TYPES, WITHDRAW_RULES } = require('../lib/constants');

const FC_TO_USDT_RATE = 0.00002; // 50,000 FC = $1 USDT — matches existing frontend WITHDRAW_RATES

function levelOf(user) {
  // Matches the level number already shown everywhere else in the app
  // (api/init.js, api/auth.js both call getLevelProgress(user.xp||0)),
  // so "Level 3" here is the exact same Level 3 the player sees on screen.
  return getLevelForXp(user.xp || 0);
}

const NOT_COUNTED = WITHDRAW_RULES.NOT_COUNTED;

function tierFor(level) {
  const T = WITHDRAW_RULES.TIERS;
  return T[level] || T.default;
}

// Withdrawals of this user that still use up a slot (rejected / refunded ones do not), oldest first.
async function openWithdrawals(user, extra) {
  const col = await getCollection('withdrawals');
  return col
    .find({ telegramId: { $in: idVariants(user.telegramId) }, status: { $nin: NOT_COUNTED }, ...(extra || {}) })
    .project({ _id: 1, createdAt: 1 })
    .sort({ createdAt: 1, _id: 1 })
    .toArray();
}

// Limits for this user right now: this level's quota + the 1-per-24h rule.
async function limitsFor(user, settings, level) {
  const tier = tierFor(level);
  const atLevel = await openWithdrawals(user, { level });
  const lastDay = await openWithdrawals(user, { createdAt: { $gte: new Date(Date.now() - WITHDRAW_RULES.DAY_MS) } });
  const maxFc = Math.min(tier.maxFc, settings.withdrawMaxFc ?? 100000);
  const minFc = Math.min(tier.minFc ?? settings.withdrawMinFc ?? 2500, maxFc);
  const dayFull = lastDay.length >= WITHDRAW_RULES.PER_DAY;
  return {
    tier, minFc, maxFc, atLevel, lastDay,
    public: {
      requests: tier.requests,
      used: atLevel.length,
      remaining: Math.max(0, tier.requests - atLevel.length),
      maxFc,
      minFc,
      dayLimit: WITHDRAW_RULES.PER_DAY,
      dayUsed: lastDay.length,
      nextAt: dayFull ? new Date(new Date(lastDay[0].createdAt).getTime() + WITHDRAW_RULES.DAY_MS).toISOString() : null,
    },
  };
}

async function buildStatus(user, settings) {
  const channels = await checkChannelMembership(user.telegramId);
  const allJoined = channels.every((c) => c.joined);
  const lifetimeTasks = (user.completedTasks || []).length;

  const level = levelOf(user);
  const lim = await limitsFor(user, settings, level);

  return {
    level,
    limits: lim.public,
    lifetimeTasks,
    tasksNeeded: settings.withdrawMinLifetimeTasks ?? 5,
    channelsJoined: allJoined,
    channels,
    walletAddress: user.withdrawWalletAddress || null,
    walletLocked: !!user.withdrawWalletAddress,
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
    if (await rateGuard(req, res, verify, 'withdraw')) return; // flood protection (lib/rateLimit.js)
    if (!verify.valid) {
      return res.status(401).json({ success: false, message: 'invalid_auth' });
    }
    const telegramId = verify.user.id;

    const usersCol = await getCollection('users');
    const user = await findUserByTelegramId(usersCol, telegramId);
    if (!user) return res.status(404).json({ success: false, message: 'user_not_found' });
    if (user.banned) return res.status(403).json({ success: false, message: 'Account suspended' });
    // LOCKUP: a locked account keeps its balance but cannot withdraw until the admin reviews it
    // (lib/lockup.js). Viewing status/history is still allowed.
    // Blocked at the first step (ad_session) so a locked user doesn't sit through an ad for nothing.
    if (user.accountLocked && (req.body && (['request', 'ad_session', 'ad_claim'].includes(req.body.action) || (!req.body.action && req.body.amount)))) {
      return res.status(403).json({
        success: false,
        locked: true,
        error: 'account_locked',
        message: '🔒 Your account is temporarily locked for review. Please contact support in our Official Community.',
      });
    }

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
        .limit(10)
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
          paidAt: w.paidAt || w.processedAt || null,
          // blockchain transaction id of the automatic payout (shown as a "View transaction" link)
          txHash: typeof w.payoutTxHash === 'string' && /^[A-Za-z0-9+/=_-]{20,100}$/.test(w.payoutTxHash) ? w.payoutTxHash : null,
        })),
      });
    }

    // ── request: create a new withdrawal ──────────────────────────────
    if (action === 'request') {
      const amount = parseInt(body.amount, 10) || 0;
      const address = (body.address || '').trim();
      const adSessionId = body.adSessionId || '';

      const minTasks = settings.withdrawMinLifetimeTasks ?? 5;
      const feePercent = settings.withdrawalFeePercent ?? 10;

      const level = levelOf(user);
      const lim = await limitsFor(user, settings, level);
      const { tier, minFc, maxFc } = lim;

      if (!address) return res.status(200).json({ success: false, error: 'Enter your wallet address.' });
      if (!amount || amount < minFc) {
        return res.status(200).json({ success: false, error: `Minimum withdrawal is ${minFc.toLocaleString()} Fruit Coin.` });
      }
      if (amount > maxFc) {
        return res.status(200).json({ success: false, error: `Level ${level} can withdraw up to ${maxFc.toLocaleString()} Fruit Coin per request.${level < 3 ? ' Level up for a bigger limit.' : ''}` });
      }
      if ((user.fruitCoin || 0) < amount) {
        return res.status(200).json({ success: false, error: 'Not enough Fruit Coin balance.' });
      }

      // Per-level quota: every level has its own number of withdrawals.
      if (lim.atLevel.length >= tier.requests) {
        return res.status(200).json({ success: false, error: `You used all ${tier.requests} withdrawal${tier.requests > 1 ? 's' : ''} of Level ${level}. Reach Level ${level + 1} to unlock ${tierFor(level + 1).requests} more.` });
      }

      // One withdrawal per account per 24 hours.
      if (lim.lastDay.length >= WITHDRAW_RULES.PER_DAY) {
        const nextAt = new Date(lim.lastDay[0].createdAt).getTime() + WITHDRAW_RULES.DAY_MS;
        const hrs = Math.max(1, Math.ceil((nextAt - Date.now()) / 3600000));
        return res.status(200).json({ success: false, error: `Only one withdrawal per day. Try again in about ${hrs} hour${hrs > 1 ? 's' : ''}.` });
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

      // GUARDIAN: account age, impossible earning speed, shared wallet (lib/guardian.js)
      const risk = await withdrawRisk(user, address);
      if (!risk.ok) return res.status(200).json({ success: false, error: risk.message, locked: risk.code === 'review' });

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
      const wdInsert = await withdrawalsCol.insertOne({
        telegramId,
        username: user.username || 'unknown',
        level, // level at request time — each level has its own withdrawal quota
        amount,
        feeFc,
        convertedAmount,
        unit,
        method,
        address,
        status: 'pending',
        createdAt: new Date(),
      });

      // Race guard: if two requests slipped in at the same moment, the later one(s) are undone.
      // Position is judged by order of creation, so exactly one of two simultaneous requests survives.
      const myId = String(wdInsert.insertedId);
      const posIn = (docs) => docs.findIndex((d) => String(d._id) === myId);
      const levelDocs = await openWithdrawals(user, { level });
      const dayDocs = await openWithdrawals(user, { createdAt: { $gte: new Date(Date.now() - WITHDRAW_RULES.DAY_MS) } });
      const overDay = posIn(dayDocs) >= WITHDRAW_RULES.PER_DAY;
      const overLevel = posIn(levelDocs) >= tier.requests;
      if (overDay || overLevel) {
        await withdrawalsCol.deleteOne({ _id: wdInsert.insertedId });
        await usersCol.updateOne({ _id: user._id }, { $inc: { fruitCoin: amount } });
        return res.status(200).json({ success: false, error: overDay ? 'Only one withdrawal per day.' : `Level ${level} withdrawal limit reached.` });
      }

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

      // Tell the admin right away (admin bot message with a button that opens the withdrawals list).
      // Awaited (with a short cap) so the serverless function is not frozen before Telegram gets the call.
      // If this fails, the 1-minute cron re-sends it (lib/withdrawAlert.js → alertPendingWithdrawals).
      await alertWithdrawal({
        _id: wdInsert.insertedId, telegramId, username: user.username || 'unknown',
        amount, feeFc, convertedAmount, unit, address,
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
