// api/convert.js
// POST /api/convert
// Header: x-telegram-init-data (verified, same pattern as api/auth.js)
//
// GOLD REMOVED (2026-09): this endpoint used to also handle Gold -> Fruit
// Coin conversion (the default/no-action branch). That branch is gone —
// there is no Gold anymore, so there's nothing to convert. The endpoint
// name is kept (frontend already calls '/api/convert') but it now only
// handles promo code redemption.

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

    // ── Promo: validate the code + credit the reward FIRST. An ad only
    // plays AFTER a successful redeem (pure revenue, not a gate) — an
    // invalid/expired/already-used code is rejected immediately with no
    // ad shown at all. The frontend plays the ad itself once it sees
    // success:true; this endpoint doesn't need to know about ads at all.
    if (action === 'redeem_promo') {
      const { code } = body;

      const result = await redeemPromoCode(telegramId, code);
      if (!result.ok) {
        return res.status(200).json({ success: false, error: result.reason });
      }

      // GOLD REMOVED: promo codes could carry a separate Gold reward
      // (result.rewardGold) alongside an FC reward — both now simply land
      // in Fruit Coin.
      const totalFc = (result.rewardFc || 0) + (result.rewardGold || 0);

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
          $inc: { fruitCoin: totalFc },
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
        amount: totalFc,
        balanceAfter: updatedUser.fruitCoin,
        meta: { code: result.code },
        createdAt: new Date(),
      });

      return res.status(200).json({
        success: true,
        rewardFc: totalFc,
        user: { fruitCoin: updatedUser.fruitCoin },
      });
    }

    // No other actions exist anymore now that Gold->FC conversion is gone.
    return res.status(400).json({ success: false, message: 'unknown_action' });
  } catch (err) {
    console.error('convert error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
