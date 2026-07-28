// api/withdraw.js
// User submits a withdrawal request. Balance is deducted immediately
// (atomically, so a devtools-edited amount can never overdraw the real
// balance) and a 'pending' request is created for the admin to review.
//
// USDT only — both methods pay out in USDT, just to a different wallet
// (Binance UID vs a TonKeeper address paid in USDT-on-TON). Rates here
// match WITHDRAW_RATES in index.html exactly — if you change one, change both.

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection, findUserByTelegramId } = require('../lib/db');

const RATES = {
  binance: { rate: 0.001, unit: 'USDT', decimals: 4 },
  tonkeeper: { rate: 0.001, unit: 'USDT', decimals: 4 },
};

const MIN_FRUIT_COIN = 100;
const MIN_REFERRALS = 2;
const MIN_TASKS = 5;

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
      return res.status(400).json({ success: false, error: `Minimum withdrawal is ${MIN_FRUIT_COIN} Fruit Coin` });
    }

    const usersCol = await getCollection('users');
    const user = await findUserByTelegramId(usersCol, telegramId);
    if (!user) return res.status(404).json({ success: false, error: 'user_not_found' });
    if (user.banned) return res.status(403).json({ success: false, error: 'Account suspended' });

    if ((user.referralCount || 0) < MIN_REFERRALS) {
      return res.status(400).json({ success: false, error: `Need at least ${MIN_REFERRALS} referrals first` });
    }
    if ((user.completedTasks || []).length < MIN_TASKS) {
      return res.status(400).json({ success: false, error: `Need to complete ${MIN_TASKS} tasks first` });
    }

    // Atomic deduct: only matches/succeeds if the real DB balance is
    // actually >= amt at the moment of update. (Driver v6+ returns the
    // document directly from findOneAndUpdate, not wrapped in { value }.)
    const deducted = await usersCol.findOneAndUpdate(
      { _id: user._id, fruitCoin: { $gte: amt } },
      { $inc: { fruitCoin: -amt }, $set: { lastActive: new Date() } },
      { returnDocument: 'after' }
    );
    if (!deducted) {
      return res.status(400).json({ success: false, error: 'Not enough Fruit Coin' });
    }

    const r = RATES[method];
    const convertedAmount = Number((amt * r.rate).toFixed(r.decimals));
    const trimmedAddress = address.trim();

    const withdrawalsCol = await getCollection('withdrawals');
    const insertResult = await withdrawalsCol.insertOne({
      telegramId: user.telegramId,
      username: user.username,
      method,
      address: trimmedAddress,
      amount: amt, // Fruit Coin amount deducted
      convertedAmount,
      unit: r.unit,
      status: 'pending',
      createdAt: new Date(),
    });

    const txCol = await getCollection('transactions');
    await txCol.insertOne({
      telegramId: user.telegramId,
      type: 'withdrawal',
      amount: -amt,
      balanceAfter: deducted.fruitCoin,
      meta: { withdrawalId: insertResult.insertedId, method, address: trimmedAddress },
      createdAt: new Date(),
    });

    return res.status(200).json({ success: true, withdrawalId: insertResult.insertedId });
  } catch (err) {
    console.error('withdraw error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};
