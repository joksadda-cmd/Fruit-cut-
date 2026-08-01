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
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { getSettings } = require('../lib/settings');
const { TRANSACTION_TYPES } = require('../lib/constants');
const { createAdSession, claimAdSession } = require('../lib/adSession');
const { redeemPromoCode } = require('../lib/promo');

const MIN_GOLD_PER_CONVERT = 20000;
const MAX_GOLD_PER_CONVERT = 2000000;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const initData = req.headers['x-telegram-init-data'] || '';
    const body = req.body || {};
    const botToken = process.env.BOT_TOKEN;

    const verify = verifyTelegramInitData(initData, botToken);
    if (!verify.valid) {
      return res.status(401).json({ success: false, message: 'Auth failed' });
    }
    const telegramId = verify.user.id;
    const action = body.action;

    // ── Promo Step 1: issue an ad-watch session ──────────────────────
    // Uses its own 'promo' network key in lib/adSession.js so it never
    // touches the Ads tab's daily per-network claim limits.
    if (action === 'request_promo_ad_session') {
      const sessionId = await createAdSession(telegramId, 'promo');
      return res.status(200).json({ success: true, sessionId });
    }

    // ── Promo Step 2: verify the ad was actually watched, then redeem ──
    if (action === 'redeem_promo') {
      const { code, sessionId } = body;
      if (!sessionId) {
        return res.status(200).json({ success: false, error: 'watch_ad_first' });
      }
      const claim = await claimAdSession(telegramId, sessionId, 'promo');
      if (!claim.ok) {
        return res.status(200).json({ success: false, error: 'watch_ad_first' });
      }

      const result = await redeemPromoCode(telegramId, code);
      if (!result.ok) {
        return res.status(200).json({ success: false, error: result.reason });
      }

      const usersCol = await getCollection('users');
      const updatedUser = await usersCol.findOneAndUpdate(
        { telegramId },
        { $inc: { fruitCoin: result.rewardFc }, $set: { lastActive: new Date() } },
        { returnDocument: 'after' }
      );
      if (!updatedUser) {
        return res.status(404).json({ success: false, error: 'user_not_found' });
      }

      const txCol = await getCollection('transactions');
      await txCol.insertOne({
        telegramId,
        type: TRANSACTION_TYPES.PROMO_REWARD,
        amount: result.rewardFc,
        balanceAfter: updatedUser.fruitCoin,
        meta: { code: result.code },
        createdAt: new Date(),
      });

      return res.status(200).json({
        success: true,
        rewardFc: result.rewardFc,
        user: { fruitCoin: updatedUser.fruitCoin },
      });
    }

    // ── Default action: Gold -> Fruit Coin conversion (unchanged) ──────
    const { goldAmount } = body;

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
    const user = await findUserByTelegramId(usersCol, telegramId);

    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (user.banned) return res.status(403).json({ success: false, message: 'Account suspended' });
    if (user.gold < gold) return res.status(400).json({ success: false, message: 'Not enough Gold' });

    // Server-side calculation — floor to avoid fractional FC.
    const fcGained = Math.floor((gold * rate.fcAmount) / rate.goldAmount);
    if (fcGained <= 0) {
      return res.status(400).json({ success: false, message: 'Amount too small to convert' });
    }

    // NOTE: MongoDB driver v6+ returns the matched document directly from
    // findOneAndUpdate (not wrapped in { value: doc } like older versions).
    const updatedUser = await usersCol.findOneAndUpdate(
      { _id: user._id, gold: { $gte: gold } }, // re-check balance atomically to avoid race conditions
      { $inc: { gold: -gold, fruitCoin: fcGained }, $set: { lastActive: new Date() } },
      { returnDocument: 'after' }
    );

    if (!updatedUser) {
      return res.status(400).json({ success: false, message: 'Not enough Gold (balance changed)' });
    }

    const txCol = await getCollection('transactions');
    await txCol.insertOne({
      telegramId,
      type: TRANSACTION_TYPES.GOLD_TO_FC_CONVERT,
      amount: fcGained,
      balanceAfter: updatedUser.fruitCoin,
      meta: { goldSpent: gold },
      createdAt: new Date(),
    });

    return res.status(200).json({
      success: true,
      user: {
        telegramId: updatedUser.telegramId,
        gold: updatedUser.gold,
        fruitCoin: updatedUser.fruitCoin,
      },
    });
  } catch (err) {
    console.error('convert error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
