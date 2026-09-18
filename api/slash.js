// api/slash.js
// POST /api/slash
// Fruit Cut Slash Game API Endpoint
// Cooldown: 1 hour between games.
// Reward: 15 to 40 FC randomly (server-validated).

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { TRANSACTION_TYPES } = require('../lib/constants');
const { pickSlashReward, SLASH_COOLDOWN_MS } = require('../lib/slashGame');
const { getLevelForSlices, getLevelProgress, LEVELS } = require('../lib/levelSystem');
const { checkReferralStep3, checkReferralStep4, MAX_TOKENS } = require('../lib/referral');

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

    const now = new Date();
    const lastSlashTime = user.lastSlashAt ? new Date(user.lastSlashAt).getTime() : 0;
    const elapsed = now.getTime() - lastSlashTime;
    const onCooldown = elapsed < SLASH_COOLDOWN_MS;
    const nextAvailableAt = new Date(lastSlashTime + SLASH_COOLDOWN_MS);
    const remainingMs = Math.max(0, SLASH_COOLDOWN_MS - elapsed);

    const action = req.body && req.body.action ? req.body.action : 'status';
    const currentSlices = user.totalSlices || 0;
    const currentProgress = getLevelProgress(currentSlices);

    // ── Status Action ──────────────────────────────────────────────
    if (action === 'status') {
      return res.status(200).json({
        success: true,
        onCooldown,
        remainingMs,
        nextAvailableAt,
        fruitCoin: user.fruitCoin || 0,
        totalSlices: currentSlices,
        level: currentProgress.level,
        levelProgress: currentProgress,
      });
    }

    // ── Claim / Slash Action ───────────────────────────────────────
    if (action === 'claim') {
      if (onCooldown) {
        return res.status(200).json({
          success: false,
          error: 'on_cooldown',
          message: 'Fruit slice is on cooldown. Come back in 1 hour!',
          nextAvailableAt,
          remainingMs,
        });
      }

      // 1. Calculate slice reward: 15 - 40 FC (weighted)
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
      const cutoff = new Date(now.getTime() - SLASH_COOLDOWN_MS);

      // 3. Atomically ensure user hasn't claimed within 1 hour
      const updatedUser = await usersCol.findOneAndUpdate(
        {
          _id: user._id,
          $or: [
            { lastSlashAt: { $exists: false } },
            { lastSlashAt: null },
            { lastSlashAt: { $lt: cutoff } },
          ],
        },
        {
          $inc: {
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
          error: 'on_cooldown',
          message: 'Already slashed this hour! Try again later.',
          nextAvailableAt: new Date(now.getTime() + SLASH_COOLDOWN_MS),
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
        nextAvailableAt: new Date(now.getTime() + SLASH_COOLDOWN_MS),
        user: {
          fruitCoin: updatedUser.fruitCoin,
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
