// api/slash.js
// POST /api/slash
// Fruit Cut Slash Game API Endpoint
// Cooldown: 30 minutes between games.
// Reward: 15 to 60 FC randomly (server-validated).
// Caps: 48 claims / UTC day, 366 claims / week (see lib/slashGame.js).

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { TRANSACTION_TYPES } = require('../lib/constants');
const { pickSlashReward, SLASH_COOLDOWN_MS, SLASH_MAX_PER_DAY, SLASH_MAX_PER_WEEK } = require('../lib/slashGame');
const { checkAndIncrementDailyLimit, checkAndIncrementWeeklyLimit } = require('../lib/dailyLimit');
const { getLevelForXp, getLevelProgress, LEVELS } = require('../lib/levelSystem');
const { checkReferralStep3, checkReferralStep4, checkReferralWeeklyValid } = require('../lib/referral');
const { recordSlashWin } = require('../lib/leaderboard');

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
    const onCooldown = lastSlashTime > 0 && elapsed < SLASH_COOLDOWN_MS;
    const nextAvailableAt = new Date(lastSlashTime + SLASH_COOLDOWN_MS);
    const remainingMs = Math.max(0, SLASH_COOLDOWN_MS - elapsed);

    const action = req.body && req.body.action ? req.body.action : 'status';
    const currentXp = user.xp || 0;
    const currentProgress = getLevelProgress(currentXp);

    // ── Status Action ──────────────────────────────────────────────
    if (action === 'status') {
      return res.status(200).json({
        success: true,
        onCooldown,
        remainingMs,
        nextAvailableAt,
        fruitCoin: user.fruitCoin || 0,
        totalSlices: user.totalSlices || 0,
        xp: currentXp,
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
          message: 'Fruit slice is on cooldown. Come back in 30 minutes!',
          nextAvailableAt,
          remainingMs,
        });
      }

      // Daily / weekly ceilings (see lib/slashGame.js for why 48/366).
      const dailyCheck = await checkAndIncrementDailyLimit(telegramId, 'slash_claim', SLASH_MAX_PER_DAY);
      if (!dailyCheck.allowed) {
        return res.status(200).json({
          success: false,
          error: 'daily_limit_reached',
          message: `Daily slash limit reached (${SLASH_MAX_PER_DAY}/day). Come back tomorrow!`,
        });
      }
      const weeklyCheck = await checkAndIncrementWeeklyLimit(telegramId, 'slash_claim', SLASH_MAX_PER_WEEK);
      if (!weeklyCheck.allowed) {
        return res.status(200).json({
          success: false,
          error: 'weekly_limit_reached',
          message: `Weekly slash limit reached (${SLASH_MAX_PER_WEEK}/week). Come back next week!`,
        });
      }

      // 1. Calculate slice reward: 15 - 60 FC (weighted)
      const baseReward = pickSlashReward();

      // 2. Calculate XP & Level progression (+1 XP per slash)
      const oldXp = user.xp || 0;
      const newXp = oldXp + 1;
      const oldLevel = getLevelForXp(oldXp);
      const newLevel = getLevelForXp(newXp);

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

      // 3. Atomically ensure user hasn't claimed within the cooldown window
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
            xp: 1,
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
          message: 'Already slashed recently! Try again in a bit.',
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
          totalSlices: updatedUser.totalSlices,
          xp: updatedUser.xp,
        },
        createdAt: now,
      });

      // 5. Feed this week's leaderboard tally (weekly Top Slasher competition)
      recordSlashWin(user.telegramId, user.username).catch(() => {});

      // 5b. Log for the admin dashboard's rolling 7-day slash count (auto-purged via TTL)
      getCollection('slashLog')
        .then((col) => col.insertOne({ telegramId: user.telegramId, createdAt: now }))
        .catch(() => {});

      // 6. Trigger referral milestones asynchronously
      checkReferralStep3(updatedUser).catch(() => {});
      // Also check: does this claim make the referral "valid" for this
      // week's Top Referrer leaderboard? (5 slash claims — separate,
      // lower bar than Step 3's 10-claim/120 FC milestone above.)
      checkReferralWeeklyValid(updatedUser).catch(() => {});
      if (newLevel >= 3) {
        checkReferralStep4(updatedUser, newLevel).catch(() => {});
      }

      const updatedProgress = getLevelProgress(updatedUser.xp || newXp);

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
          totalSlices: updatedUser.totalSlices,
          lastSlashAt: updatedUser.lastSlashAt,
          xp: updatedUser.xp,
        },
      });
    }

    return res.status(400).json({ success: false, error: 'invalid_action' });
  } catch (err) {
    console.error('api/slash error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};
