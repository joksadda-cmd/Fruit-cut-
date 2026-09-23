// api/convert.js
// POST /api/convert
// Body: { action: 'redeem_promo', code: string }
// Header: x-telegram-init-data (verified, same pattern as api/auth.js)
//
// This file used to also do a Gold -> Fruit Coin conversion (the app's old
// second currency, "Gold", has been removed entirely — Fruit Coin is now
// the only currency). Promo code redemption is the only thing left here.
// It stays in this file (instead of its own api/promo.js) because Vercel's
// Hobby plan caps a project at 12 Serverless Functions — see api/verify_task.js
// and api/auth.js's header comments for the same reasoning.

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection, idVariants } = require('../lib/db');
const { TRANSACTION_TYPES } = require('../lib/constants');
const { redeemPromoCode, revertPromoRedeem } = require('../lib/promo');

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

    if (action !== 'redeem_promo') {
      return res.status(400).json({ success: false, message: 'unknown action' });
    }

    // ── Promo: validate the code + credit the reward FIRST. An ad only
    // plays AFTER a successful redeem (pure revenue, not a gate) — an
    // invalid/expired/already-used code is rejected immediately with no
    // ad shown at all. The frontend plays the ad itself once it sees
    // success:true; this endpoint doesn't need to know about ads at all.
    const { code } = body;

    const result = await redeemPromoCode(telegramId, code);
    if (!result.ok) {
      return res.status(200).json({ success: false, error: result.reason });
    }

    // IMPORTANT: telegramId can be stored as either a string or a number
    // depending on how the user doc was created — always match both forms
    // via idVariants(), same as every other endpoint in this project.
    // A plain { telegramId } query here previously caused the credit to
    // silently fail as "not found" AFTER the code was already marked
    // used, permanently locking users out of a code they never got paid
    // for. Fixed, plus a rollback below as a second safety net.
    const usersCol = await getCollection('users');
    const updatedUser = await usersCol.findOneAndUpdate(
      { telegramId: { $in: idVariants(telegramId) } },
      {
        $inc: { fruitCoin: result.rewardFc || 0 },
        $set: { lastActive: new Date() },
      },
      { returnDocument: 'after' }
    );

    if (!updatedUser) {
      // Credit failed after the code was already marked used — undo that
      // so the user can retry instead of being stuck on "already_redeemed".
      await revertPromoRedeem(code, telegramId);
      return res.status(404).json({ success: false, error: 'user_not_found' });
    }

    const txCol = await getCollection('transactions');
    await txCol.insertOne({
      telegramId,
      type: TRANSACTION_TYPES.PROMO_REWARD,
      amount: result.rewardFc || 0,
      balanceAfter: updatedUser.fruitCoin,
      meta: { code: result.code },
      createdAt: new Date(),
    });

    return res.status(200).json({
      success: true,
      rewardFc: result.rewardFc || 0,
      user: { fruitCoin: updatedUser.fruitCoin },
    });
  } catch (err) {
    console.error('convert error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
