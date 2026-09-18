// api/slash.js
// POST /api/slash
// Fruit Cut Slash Game API Endpoint
// Handles status query and slice reward claim with atomic MongoDB updates.

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { TRANSACTION_TYPES } = require('../lib/constants');
const { applyRegen, MAX_TOKENS } = require('../lib/tokens');
const { pickSlashReward } = require('../lib/slashGame');
const { getLevelForSlices, getLevelProgress, LEVELS } = require('../lib/levelSystem');

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
    const usersCol = await getCollection('users');
    const user = await findUserByTelegramId(usersCol, telegramId);

    if (!user) {
      return res.status(404).json({ success: false, error: 'user_not_found' });
    }
    if (user.banned) {
      return res.status(403).json({ success: false, error: 'Account suspended' });
    }

    // Apply any pending token regen
    const regen = await applyRegen(usersCol, user);
    user.gameTokens = regen.gameTokens;

    const action = req.body && req.body.action ? req.body.action : 'status';

    const currentSlices = user.totalSlices || 0;
    const currentProgress = getLevelProgress(currentSlices);

    // ── Status Action ──────────────────────────────────────────────
    if (action === 'status') {
      return res.status(200).json({
        success: true,
        tokens: user.gameTokens ?? 3,
        maxTokens: MAX_TOKENS,
        nextTokenAt: regen.nextTokenAt,
        fruitCoin: user.fruitCoin || 0,
        totalSlices: currentSlices,
        level: currentProgress.level,
        levelProgress: currentProgress,
      });
    }

    // ── Claim / Slash Action ───────────────────────────────────────
    if (action === 'claim') {
      if ((user.gameTokens || 0) < 1) {
        return res.status(200).json({
          success: false,
          error: 'no_tokens',
          message: 'No game tokens left! Claim Free Box, buy in Shop, or watch Ads.',
        });
      }

      // 1. Calculate slice reward: 10 - 200 FC (weighted)
      const baseReward = pickSlashReward();

      // 2. Calculate level progression
      const oldSlices = user.totalSlices || 0;
      const newSlices = oldSlices + 1;
      const oldLevel = getLevelForSlices(oldSlices);
      const newLevel = getLevelForSlices(newSlices);

      let levelReward = 0;
      let isLevelUp = false;

      if (newLevel > oldLevel) {
        isLevelUp = true;
        const targetLevelConfig = LEVELS.find((l) => l.level === newLevel);
        if (targetLevelConfig) {
          levelReward = targetLevelConfig.rewardFc || 0;
        }
      }

      const totalReward = baseReward + levelReward;
      const now = new Date();

      // 3. Deduct token and add rewards atomically
      const updatedUser = await usersCol.findOneAndUpdate(
        {
          _id: user._id,
          gameTokens: { $gte: 1 },
        },
        {
          $inc: {
            gameTokens: -1,
            fruitCoin: totalReward,
            totalSlices: 1,
          },
          $set: {
            level: newLevel,
            lastSlashAt: now,
            lastActive: now,
          },
        },
        { returnDocument: 'after' }
      );

      if (!updatedUser) {
        return res.status(200).json({
          success: false,
          error: 'no_tokens',
          message: 'Not enough tokens to slice!',
        });
      }

      // 4. Record transaction log
      const txCol = await getCollection('transactions');
      await txCol.insertOne({
        telegramId: user.telegramId,
        type: TRANSACTION_TYPES.SLASH_REWARD,
        amount: totalReward,
        balanceAfter: updatedUser.fruitCoin,
        meta: {
          baseReward,
          levelReward,
          isLevelUp,
          level: newLevel,
          totalSlices: newSlices,
        },
        createdAt: now,
      });

      const updatedProgress = getLevelProgress(updatedUser.totalSlices || newSlices);

      return res.status(200).json({
        success: true,
        reward: baseReward,
        levelReward,
        isLevelUp,
        newLevel,
        totalSlices: updatedUser.totalSlices,
        user: {
          fruitCoin: updatedUser.fruitCoin,
          tokens: updatedUser.gameTokens,
          level: updatedProgress.level,
          levelProgress: updatedProgress,
        },
      });
    }

    return res.status(400).json({ success: false, error: 'invalid_action' });
  } catch (err) {
    console.error('api/slash error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};
