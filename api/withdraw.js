// api/withdraw.js
// User submits a withdrawal request. Balance is deducted immediately
// (atomically, so a devtools-edited amount can never overdraw the real
// balance) and a 'pending' request is created for the admin to review.
//
// USDT only — both methods pay out in USDT, just to a different wallet
// (Binance UID vs a TonKeeper address paid in USDT-on-TON). Rates here
// match WITHDRAW_RATES in index.html exactly — if you change one, change both.
//
// Requirements (per Rashu's spec): 5 tasks completed AND joined the
// official channel + community — no more referral requirement.
//
// Once per (UTC) day, and a 5% fee is taken out of every withdrawal.
// Both the daily-limit check AND the balance deduction happen in the
// SAME atomic findOneAndUpdate call below, so a double-tap/double-submit
// can never produce two withdrawals — the second request's filter simply
// won't match once the first has already set today's lastWithdrawAt.

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { checkChannelMembership } = require('../lib/joinGate');

// 10,000 Fruit Coin = $1 USDT  →  1 FC = $0.0001
const RATES = {
  binance: { rate: 0.0001, unit: 'USDT', decimals: 4 },
  tonkeeper: { rate: 0.0001, unit: 'USDT', decimals: 4 },
};

const MIN_FRUIT_COIN = 5000;
const MIN_TASKS = 5;
const FEE_RATE = 0.05; // 5%

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const initData = req.headers['x-telegram-init-data'] || '';
    const verify = verifyTelegramInitData(initData, process.env.BOT_TOKEN);
    if (!verify.valid) {
      return res.status(401).json({ success: false, error: 'invalid_auth' });
    }
    const telegramId = verify.user.id;

    const { method, address, amount } = req.body || {};
    const amt = Number(amount);

    if (!RATES[method]) {
      return res.status(400).json({ success: false, error: 'Invalid withdrawal method' });
    }
    if (!address || typeof address !== 'string' || address.trim().length < 4) {
      return res.status(400).json({ success: false, error: 'Invalid address' });
    }
    if (!Number.isFinite(amt) || amt < MIN_FRUIT_COIN) {
      return res.status(400).json({ success: false, error: `Minimum withdrawal is ${MIN_FRUIT_COIN.toLocaleString()} Fruit Coin` });
    }

    const usersCol = await getCollection('users');
    const user = await findUserByTelegramId(usersCol, telegramId);
    if (!user) return res.status(404).json({ success: false, error: 'user_not_found' });
    if (user.banned) return res.status(403).json({ success: false, error: 'Account suspended' });

    if ((user.completedTasks || []).length < MIN_TASKS) {
      return res.status(400).json({ success: false, error: `Need to complete ${MIN_TASKS} tasks first` });
    }

    const channels = await checkChannelMembership(telegramId);
    const required = channels.filter((c) => c.key === 'channel' || c.key === 'community');
    const notJoined = required.filter((c) => !c.joined);
    if (notJoined.length) {
      return res.status(400).json({
        success: false,
        error: `Please join our ${notJoined.map((c) => c.label).join(' & ')} first`,
      });
    }

    // 5% fee — the FULL requested amount leaves the user's Fruit Coin
    // balance, but only 95% of it is what actually gets converted/paid.
    const feeFruitCoin = Math.round(amt * FEE_RATE);
    const netFruitCoin = amt - feeFruitCoin;

    const r = RATES[method];
    const convertedAmount = Number((netFruitCoin * r.rate).toFixed(r.decimals));
    const trimmedAddress = address.trim();

    // ONE atomic operation does all three things that must not race each
    // other: (a) re-check real balance, (b) re-check "not already
    // withdrawn today", (c) deduct + stamp today's withdrawal — so a
    // double-click can only ever succeed once.
    const startOfTodayUTC = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
    const now = new Date();
    const deducted = await usersCol.findOneAndUpdate(
      {
        _id: user._id,
        fruitCoin: { $gte: amt },
        $or: [{ lastWithdrawAt: { $exists: false } }, { lastWithdrawAt: null }, { lastWithdrawAt: { $lt: startOfTodayUTC } }],
      },
      { $inc: { fruitCoin: -amt }, $set: { lastActive: now, lastWithdrawAt: now } },
      { returnDocument: 'after' }
    );
    if (!deducted) {
      // Figure out which of the two conditions actually failed, for a
      // clearer error message (re-read is fine here — cheap and this is
      // just for the message, not for anything security-relevant).
      const fresh = await usersCol.findOne({ _id: user._id });
      if (fresh && fresh.fruitCoin < amt) {
        return res.status(400).json({ success: false, error: 'Not enough Fruit Coin' });
      }
      return res.status(400).json({ success: false, error: 'You can only withdraw once per day. Try again tomorrow.' });
    }

    const withdrawalsCol = await getCollection('withdrawals');
    const insertResult = await withdrawalsCol.insertOne({
      telegramId: user.telegramId,
      username: user.username,
      method,
      address: trimmedAddress,
      amount: amt,           // Fruit Coin deducted from balance (gross)
      feeFruitCoin,           // 5% fee taken out
      netFruitCoin,           // what was actually converted
      convertedAmount,
      unit: r.unit,
      status: 'pending',
      createdAt: now,
    });

    const txCol = await getCollection('transactions');
    await txCol.insertOne({
      telegramId: user.telegramId,
      type: 'withdrawal',
      amount: -amt,
      balanceAfter: deducted.fruitCoin,
      meta: { withdrawalId: insertResult.insertedId, method, address: trimmedAddress, feeFruitCoin, netFruitCoin },
      createdAt: now,
    });

    // Push an immediate alert to the admin instead of relying on them to
    // manually open the bot and check the Withdrawals list. Uses the
    // SAME callback_data format (a_wd_ok_<id> / a_wd_no_<id>) that
    // api/bot.js's approve/reject handler already expects, so these
    // buttons work exactly like the ones in the polled list.
    // NOTE: this is awaited on purpose — Vercel can freeze a serverless
    // function's execution right after the response is sent, so a
    // fire-and-forget call here risks silently never actually going out.
    const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID || process.env.ADMIN_ID;
    if (ADMIN_ID && process.env.BOT_TOKEN) {
      try {
        await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: ADMIN_ID,
            text:
              `🔔 <b>New Withdrawal Request</b>\n\n` +
              `👤 @${user.username || 'unknown'} (ID: <code>${user.telegramId}</code>)\n` +
              `💰 ${amt.toLocaleString()} Fruit Coin → <b>${convertedAmount} ${r.unit}</b> (after 5% fee)\n` +
              `📍 ${method === 'binance' ? 'Binance UID' : 'TonKeeper'}: <code>${trimmedAddress}</code>`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Approve', callback_data: `a_wd_ok_${insertResult.insertedId}` },
                { text: '❌ Reject', callback_data: `a_wd_no_${insertResult.insertedId}` },
              ]],
            },
          }),
        });
      } catch (e) {
        // Never let a failed Telegram push break the withdrawal itself —
        // the request is already safely stored as 'pending' and will
        // still show up next time the admin opens the Withdrawals list.
        console.error('admin withdraw notify failed:', e);
      }
    } else {
      console.warn('withdraw: ADMIN_ID or BOT_TOKEN not set — admin push notification skipped');
    }

    return res.status(200).json({ success: true, withdrawalId: insertResult.insertedId, feeFruitCoin, netFruitCoin, convertedAmount, unit: r.unit });
  } catch (err) {
    console.error('withdraw error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};
