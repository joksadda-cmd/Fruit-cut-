// api/withdraw.js
// POST /api/withdraw
// Two call shapes:
//   { action: 'history' }                -> return caller's withdrawal history
//   { method, address, amount, adsSessionId } -> submit a withdrawal request
//
// New rules (v2):
//   - User must be Level 3+ to withdraw
//   - Minimum 5 tasks completed
//   - Must watch one Adsgram ad before withdrawing (adsSessionId verified server-side)
//   - Maximum 100,000 FC per withdrawal
//   - Wallet address is PERMANENT — first address saves to user profile,
//     all subsequent withdrawals MUST use the same address
//   - Once per UTC day
//   - 5% fee on every withdrawal
//   - Wrong address refund: admin can refund with 10% penalty via bot

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { checkChannelMembership } = require('../lib/joinGate');

// 50,000 Fruit Coin = $1 USDT  ->  1 FC = $0.00002
const RATES = {
  tonkeeper: { rate: 0.00002, unit: 'USDT', decimals: 4 },
};

const MIN_FRUIT_COIN = 2500;    // 2,500 FC = $0.05 minimum withdrawal
const MAX_FRUIT_COIN = 100000;  // 100,000 FC maximum withdrawal
const MIN_TASKS      = 5;
const MIN_LEVEL      = 3;       // Level 3 required to unlock withdraw
const FEE_RATE       = 0.05;    // 5% fee

async function handleHistory(req, res, telegramId) {
  const col     = await getCollection('withdrawals');
  const history = await col.find({ telegramId }).sort({ createdAt: -1 }).limit(30).toArray();

  let totalPendingFc   = 0;
  let totalPendingUsdt = 0;
  let totalApprovedFc  = 0;
  let totalApprovedUsdt = 0;

  const formatted = history.map((w) => {
    const amt       = w.amount || 0;
    const converted = w.convertedAmount || Number((amt * 0.95 * 0.00002).toFixed(4));

    if (w.status === 'pending') {
      totalPendingFc   += amt;
      totalPendingUsdt += converted;
    } else if (w.status === 'approved') {
      totalApprovedFc   += amt;
      totalApprovedUsdt += converted;
    }

    return {
      method:          w.method || 'tonkeeper',
      amount:          amt,
      netFruitCoin:    w.netFruitCoin || Math.round(amt * 0.95),
      convertedAmount: converted,
      address:         w.address || '',
      status:          w.status || 'pending',
      createdAt:       w.createdAt,
    };
  });

  // Also return the user's saved permanent withdraw address
  const usersCol = await getCollection('users');
  const user     = await findUserByTelegramId(usersCol, telegramId);
  const savedAddress = user ? (user.withdrawAddress || null) : null;

  return res.status(200).json({
    success: true,
    totalPendingFc,
    totalPendingUsdt:  Number(totalPendingUsdt.toFixed(4)),
    totalApprovedFc,
    totalApprovedUsdt: Number(totalApprovedUsdt.toFixed(4)),
    savedAddress,
    history: formatted,
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const initData = req.headers['x-telegram-init-data'] || '';
    const verify   = verifyTelegramInitData(initData, process.env.BOT_TOKEN);
    if (!verify.valid) {
      return res.status(401).json({ success: false, error: 'invalid_auth' });
    }
    const telegramId = verify.user.id;

    if (req.body && req.body.action === 'history') {
      return await handleHistory(req, res, telegramId);
    }

    const { method, address, amount, adsSessionId } = req.body || {};
    const amt = Number(amount);

    // ── Basic validation ──────────────────────────────────────────
    if (method !== 'tonkeeper') {
      return res.status(400).json({ success: false, error: 'Only TonKeeper address (USDT on TON) is supported.' });
    }
    if (!address || typeof address !== 'string' || address.trim().length < 4) {
      return res.status(400).json({ success: false, error: 'Invalid wallet address.' });
    }
    if (!Number.isFinite(amt) || amt < MIN_FRUIT_COIN) {
      return res.status(400).json({ success: false, error: `Minimum withdrawal is ${MIN_FRUIT_COIN.toLocaleString()} Fruit Coin.` });
    }
    if (amt > MAX_FRUIT_COIN) {
      return res.status(400).json({ success: false, error: `Maximum withdrawal is ${MAX_FRUIT_COIN.toLocaleString()} Fruit Coin per request.` });
    }

    // ── Ads session verification (must watch ad before withdrawing) ──
    if (!adsSessionId) {
      return res.status(400).json({ success: false, error: 'You must watch an ad before withdrawing.' });
    }
    // Verify the ad session was legitimately claimed
    const { claimAdSession } = require('../lib/adSession');
    const adsClaim = await claimAdSession(telegramId, adsSessionId, 'adsgram');
    if (!adsClaim.ok) {
      return res.status(400).json({ success: false, error: 'Ad not verified. Please watch the ad and try again.' });
    }

    // ── User validation ───────────────────────────────────────────
    const usersCol = await getCollection('users');
    const user     = await findUserByTelegramId(usersCol, telegramId);
    if (!user)       return res.status(404).json({ success: false, error: 'user_not_found' });
    if (user.banned) return res.status(403).json({ success: false, error: 'Account suspended.' });

    // ── Level 3 check ─────────────────────────────────────────────
    const userLevel = user.level || 1;
    if (userLevel < MIN_LEVEL) {
      return res.status(400).json({
        success: false,
        error: `Withdraw is locked. You need to reach Level ${MIN_LEVEL} first! (Current: Level ${userLevel})`,
      });
    }

    // ── Task completion check ─────────────────────────────────────
    if ((user.completedTasks || []).length < MIN_TASKS) {
      return res.status(400).json({ success: false, error: `Complete ${MIN_TASKS} tasks first to unlock withdrawals.` });
    }

    // ── Channel membership check ──────────────────────────────────
    const channels = await checkChannelMembership(telegramId);
    const required = channels.filter((c) => c.key === 'channel' || c.key === 'community');
    const notJoined = required.filter((c) => !c.joined);
    if (notJoined.length) {
      return res.status(400).json({
        success: false,
        error: `Please join our ${notJoined.map((c) => c.label).join(' & ')} first.`,
      });
    }

    // ── Permanent address check ───────────────────────────────────
    const trimmedAddress = address.trim();
    if (user.withdrawAddress) {
      // User already has a saved address — must match exactly
      if (user.withdrawAddress !== trimmedAddress) {
        return res.status(400).json({
          success: false,
          error: `You can only use your registered wallet address: ${user.withdrawAddress.slice(0, 6)}...${user.withdrawAddress.slice(-4)}. Contact admin if you entered a wrong address.`,
        });
      }
    }

    // ── Fee calculation ───────────────────────────────────────────
    const feeFruitCoin  = Math.round(amt * FEE_RATE);
    const netFruitCoin  = amt - feeFruitCoin;
    const r             = RATES[method];
    const convertedAmount = Number((netFruitCoin * r.rate).toFixed(r.decimals));

    // ── Atomic: balance check + daily limit + deduct + save address ──
    const startOfTodayUTC = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
    const now = new Date();

    // Build the $set update — save address permanently on first withdrawal
    const updateSet = { lastActive: now, lastWithdrawAt: now };
    if (!user.withdrawAddress) {
      updateSet.withdrawAddress = trimmedAddress;
    }

    const deducted = await usersCol.findOneAndUpdate(
      {
        _id: user._id,
        fruitCoin: { $gte: amt },
        $or: [
          { lastWithdrawAt: { $exists: false } },
          { lastWithdrawAt: null },
          { lastWithdrawAt: { $lt: startOfTodayUTC } },
        ],
      },
      { $inc: { fruitCoin: -amt }, $set: updateSet },
      { returnDocument: 'after' }
    );

    if (!deducted) {
      const fresh = await usersCol.findOne({ _id: user._id });
      if (fresh && fresh.fruitCoin < amt) {
        return res.status(400).json({ success: false, error: 'Not enough Fruit Coin.' });
      }
      return res.status(400).json({ success: false, error: 'You can only withdraw once per day. Try again tomorrow.' });
    }

    // ── Create withdrawal record ──────────────────────────────────
    const withdrawalsCol = await getCollection('withdrawals');
    const insertResult   = await withdrawalsCol.insertOne({
      telegramId:      user.telegramId,
      username:        user.username,
      method,
      address:         trimmedAddress,
      amount:          amt,
      feeFruitCoin,
      netFruitCoin,
      convertedAmount,
      unit:            r.unit,
      status:          'pending',
      createdAt:       now,
    });

    // ── Transaction log ───────────────────────────────────────────
    const txCol = await getCollection('transactions');
    await txCol.insertOne({
      telegramId:  user.telegramId,
      type:        'withdrawal',
      amount:      -amt,
      balanceAfter: deducted.fruitCoin,
      meta:        { withdrawalId: insertResult.insertedId, method, address: trimmedAddress, feeFruitCoin, netFruitCoin },
      createdAt:   now,
    });

    // ── Admin push notification ───────────────────────────────────
    const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID || process.env.ADMIN_ID;
    if (ADMIN_ID && process.env.BOT_TOKEN) {
      try {
        await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            chat_id: ADMIN_ID,
            text:
              `🔔 <b>New Withdrawal Request</b>\n\n` +
              `👤 @${user.username || 'unknown'} (ID: <code>${user.telegramId}</code>)\n` +
              `🏅 Level: <b>${userLevel}</b>\n` +
              `💰 ${amt.toLocaleString()} FC → <b>${convertedAmount} ${r.unit}</b> (after 5% fee)\n` +
              `📍 TonKeeper: <code>${trimmedAddress}</code>`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Approve',           callback_data: `a_wd_ok_${insertResult.insertedId}` },
                { text: '❌ Reject',            callback_data: `a_wd_no_${insertResult.insertedId}` },
                { text: '⚠️ Wrong Addr Refund', callback_data: `a_wd_wra_${insertResult.insertedId}` },
              ]],
            },
          }),
        });
      } catch (e) {
        console.error('admin withdraw notify failed:', e);
      }
    }

    return res.status(200).json({
      success:        true,
      withdrawalId:   insertResult.insertedId,
      feeFruitCoin,
      netFruitCoin,
      convertedAmount,
      unit:           r.unit,
      savedAddress:   trimmedAddress,
    });
  } catch (err) {
    console.error('withdraw error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};
