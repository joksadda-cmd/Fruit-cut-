// api/lottery.js
// POST /api/lottery
// Body: { useToken: boolean }
//   useToken: true  -> spends 1 lotteryTokens
//   useToken: false -> uses today's free spin (1 per UTC day)
//
// This endpoint DID NOT EXIST before — the frontend was picking the prize
// itself (client-side Math.random over the prize table) and then just
// telling the server "I won prizeType X, prizeVal Y", with no matching
// route to even receive that. Two problems, both fixed here:
//   1. Missing route -> every spin silently failed ("Server Error").
//   2. Client-decided prize -> a devtools/termux user could have claimed
//      any prize they wanted once this route existed. The prize is now
//      picked here, server-side, from lib/lottery.js — winning odds are
//      never sent to the client at all.

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { TRANSACTION_TYPES } = require('../lib/constants');
const { pickPrize } = require('../lib/lottery');
const { MAX_TOKENS } = require('../lib/tokens');

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

    const { useToken } = req.body || {};

    const usersCol = await getCollection('users');
    const user = await findUserByTelegramId(usersCol, telegramId);
    if (!user) return res.status(404).json({ success: false, error: 'user_not_found' });
    if (user.banned) return res.status(403).json({ success: false, error: 'Account suspended' });

    // ── STEP 1: atomically claim the spin itself ─────────────────────
    let claimedUser;
    if (useToken) {
      claimedUser = await usersCol.findOneAndUpdate(
        { _id: user._id, lotteryTokens: { $gte: 1 } },
        { $inc: { lotteryTokens: -1 } },
        { returnDocument: 'after' }
      );
      if (!claimedUser) {
        return res.status(400).json({ success: false, error: 'no_lottery_tokens' });
      }
    } else {
      // Free spin — resets every UTC midnight (compare-and-swap so two
      // concurrent requests can't both slip through the same day).
      const startOfTodayUTC = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
      claimedUser = await usersCol.findOneAndUpdate(
        {
          _id: user._id,
          $or: [{ lastFreeLotteryAt: { $exists: false } }, { lastFreeLotteryAt: null }, { lastFreeLotteryAt: { $lt: startOfTodayUTC } }],
        },
        { $set: { lastFreeLotteryAt: new Date() } },
        { returnDocument: 'after' }
      );
      if (!claimedUser) {
        return res.status(400).json({ success: false, error: 'free_spin_already_used' });
      }
    }

    // ── STEP 2: pick the prize (server-only — see lib/lottery.js) ────
    const prize = pickPrize();

    // ── STEP 3: apply the reward ──────────────────────────────────────
    let updatedUser;
    if (prize.type === 'coin') {
      updatedUser = await usersCol.findOneAndUpdate(
        { _id: user._id },
        { $inc: { gold: prize.val } },
        { returnDocument: 'after' }
      );
    } else if (prize.type === 'fc') {
      updatedUser = await usersCol.findOneAndUpdate(
        { _id: user._id },
        { $inc: { fruitCoin: prize.val } },
        { returnDocument: 'after' }
      );
    } else if (prize.type === 'lottoken') {
      updatedUser = await usersCol.findOneAndUpdate(
        { _id: user._id },
        { $inc: { lotteryTokens: prize.val } },
        { returnDocument: 'after' }
      );
    } else if (prize.type === 'token') {
      // Game Tokens still cap at MAX_TOKENS from a lottery win (same rule
      // as regen in lib/tokens.js — only a referral bonus can push above
      // the cap). Needs an aggregation-pipeline update to clamp atomically.
      updatedUser = await usersCol.findOneAndUpdate(
        { _id: user._id },
        [{ $set: { gameTokens: { $min: [{ $add: [{ $ifNull: ['$gameTokens', 3] }, prize.val] }, MAX_TOKENS] } } }],
        { returnDocument: 'after' }
      );
    }

    if (!updatedUser) updatedUser = claimedUser; // shouldn't happen, safety net

    const txCol = await getCollection('transactions');
    await txCol.insertOne({
      telegramId: user.telegramId,
      type: TRANSACTION_TYPES.LOTTERY_REWARD,
      amount: prize.val,
      balanceAfter: updatedUser.gold,
      meta: { prizeId: prize.id, prizeType: prize.type, usedToken: !!useToken },
      createdAt: new Date(),
    });

    return res.status(200).json({
      success: true,
      prize: { id: prize.id, type: prize.type, val: prize.val, label: prize.label, icon: prize.icon },
      user: {
        gold: updatedUser.gold,
        fruitCoin: updatedUser.fruitCoin,
        gameTokens: updatedUser.gameTokens,
        lotteryTokens: updatedUser.lotteryTokens,
      },
    });
  } catch (err) {
    console.error('lottery error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};
