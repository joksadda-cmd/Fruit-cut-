// api/convert.js
// POST /api/convert
// Body: { goldAmount: number }
// Header: x-telegram-init-data (verified, same pattern as api/auth.js)
//
// Converts Gold -> Fruit Coin using the rate stored in settings.goldToFc
// (currently 1,000,000 Gold = 50,000 FC, i.e. 20 Gold = 1 FC).
// The server recalculates the FC amount itself — it never trusts an FC
// amount sent from the client.

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection } = require('../lib/db');
const { getSettings } = require('../lib/settings');
const { TRANSACTION_TYPES } = require('../lib/constants');

const MIN_GOLD_PER_CONVERT = 20000;
const MAX_GOLD_PER_CONVERT = 2000000;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const initData = req.headers['x-telegram-init-data'] || '';
    const { goldAmount } = req.body || {};
    const botToken = process.env.BOT_TOKEN;

    const verify = verifyTelegramInitData(initData, botToken);
    if (!verify.valid) {
      return res.status(401).json({ success: false, message: 'Auth failed' });
    }
    const telegramId = verify.user.id;

    const gold = parseInt(goldAmount, 10);
    if (!gold || gold < MIN_GOLD_PER_CONVERT) {
      return res.status(400).json({ success: false, message: `Minimum ${MIN_GOLD_PER_CONVERT.toLocaleString()} Gold` });
    }
    if (gold > MAX_GOLD_PER_CONVERT) {
      return res.status(400).json({ success: false, message: `Maximum ${MAX_GOLD_PER_CONVERT.toLocaleString()} Gold per conversion` });
    }

    const settings = await getSettings();
    const rate = settings.goldToFc || { goldAmount: 1000000, fcAmount: 50000 };

    const usersCol = await getCollection('users');
    const user = await usersCol.findOne({ telegramId });

    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (user.banned) return res.status(403).json({ success: false, message: 'Account suspended' });
    if (user.gold < gold) return res.status(400).json({ success: false, message: 'Not enough Gold' });

    // Server-side calculation — floor to avoid fractional FC.
    const fcGained = Math.floor((gold * rate.fcAmount) / rate.goldAmount);
    if (fcGained <= 0) {
      return res.status(400).json({ success: false, message: 'Amount too small to convert' });
    }

    const updateResult = await usersCol.findOneAndUpdate(
      { telegramId, gold: { $gte: gold } }, // re-check balance atomically to avoid race conditions
      { $inc: { gold: -gold, fruitCoin: fcGained }, $set: { lastActive: new Date() } },
      { returnDocument: 'after' }
    );

    if (!updateResult.value) {
      return res.status(400).json({ success: false, message: 'Not enough Gold (balance changed)' });
    }

    const txCol = await getCollection('transactions');
    await txCol.insertOne({
      telegramId,
      type: TRANSACTION_TYPES.GOLD_TO_FC_CONVERT,
      amount: fcGained,
      balanceAfter: updateResult.value.fruitCoin,
      meta: { goldSpent: gold },
      createdAt: new Date(),
    });

    return res.status(200).json({
      success: true,
      user: {
        telegramId: updateResult.value.telegramId,
        gold: updateResult.value.gold,
        fruitCoin: updateResult.value.fruitCoin,
      },
    });
  } catch (err) {
    console.error('convert error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
