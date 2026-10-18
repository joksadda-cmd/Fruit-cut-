// api/slash.js
// POST /api/slash
// Fruit Cut Slash Game API Endpoint
// Cooldown: 30 minutes between games.
// Reward: 25 to 50 FC randomly (server-validated).
// Caps: 48 claims / UTC day, 366 claims / week (see lib/slashGame.js).
// Anti-bot (2026-10-18): repeated refused tries -> 2-min pause -> lock; same-time multi-account clusters; wider
// exact-interval check; play-time metronome — all in lib/slashGuard.js.
//
// BUG FOUND WHILE ANSWERING "any more bugs like the last one?": this file
// was running an OLDER version with no session gate at all. The newer,
// intended version (start -> single-use session -> claim, plus a
// bot-precision-streak flag) existed only inside the old api/verify_task.js
// mix-up — it got saved to the wrong file at some point, and was lost
// entirely when that file was rewritten for the real task feature. Net
// effect in production: the frontend dutifully called action:'start' and
// sent sessionId with every claim, but this file ignored both — 'start'
// 400'd (silently swallowed client-side) and 'claim' never checked the
// session, so ANY script could claim every 30 minutes with zero session
// requirement. lib/slashSession.js (the session module) and notifyAdmin's
// precision-streak alert existed in the codebase this whole time but were
// never actually called from anywhere. Restored below.
//
// Anti-automation: claiming requires a short-lived session opened via
// action:'start' first (see lib/slashSession.js) — a script that just
// replays action:'claim' in a loop every 30 minutes, without ever calling
// 'start' moments before, is rejected outright. On top of that, a rolling
// "precision streak" flags (never auto-bans) any account whose claims land
// suspiciously close to the exact cooldown boundary many times in a row —
// real players drift by minutes; a scheduler doesn't.

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { rateGuard } = require('../lib/rateLimit');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { TRANSACTION_TYPES } = require('../lib/constants');
const { pickSlashReward, SLASH_COOLDOWN_MS, SLASH_MAX_PER_DAY, SLASH_MAX_PER_WEEK } = require('../lib/slashGame');
const { createSlashSession, claimSlashSession } = require('../lib/slashSession');
const { checkAndIncrementDailyLimit, checkAndIncrementWeeklyLimit } = require('../lib/dailyLimit');
const { getLevelForXp, getLevelProgress, LEVELS } = require('../lib/levelSystem');

// XP granted per successful slash claim (was 1, now 5).
const SLASH_XP_REWARD = 5;
const { checkReferralStep3, checkReferralStep4, checkReferralWeeklyValid } = require('../lib/referral');
const { recordSlashWin } = require('../lib/leaderboard');
const { notifyAdmin } = require('../lib/notify');
const { lockUser, isBotLocked } = require('../lib/lockup');
const { track: trackWd } = require('../lib/wdProfile');
const slashGuard = require('../lib/slashGuard');

// How close to *exactly* SLASH_COOLDOWN_MS a claim has to land to count as "suspiciously precise".
// Real humans come back minutes late; a cron/Termux loop fires right on the mark — even with a little
// random delay it stays inside a minute. (Was 3 s; widened to 60 s on 2026-10-18 — see lib/slashGuard.js CFG.)
const PRECISION_TOLERANCE_MS = slashGuard.CFG.PRECISION_TOLERANCE_MS;
const PRECISION_STREAK_FLAG_AT = slashGuard.CFG.PRECISION_NOTIFY_AT; // admin alert at 3 in a row
const PRECISION_STREAK_LOCK_AT = slashGuard.CFG.PRECISION_LOCK_AT;   // account lock at 4 in a row

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const initData = req.headers['x-telegram-init-data'] || '';
    const verify = verifyTelegramInitData(initData, process.env.BOT_TOKEN);
    if (await rateGuard(req, res, verify, 'slash')) return; // flood protection (lib/rateLimit.js)
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
    // A script-locked account earns nothing more (same rule as ads, lib/guardian.js)
    if (isBotLocked(user) && (req.body && (req.body.action === 'start' || req.body.action === 'claim'))) {
      return res.status(200).json({ success: false, error: 'account_locked', message: '🔒 Your account is locked for review. Contact support.' });
    }

    // Short pause after repeated refused tries (lib/slashGuard.js). Still-hammering scripts escalate to a lock.
    if (req.body && (req.body.action === 'start' || req.body.action === 'claim')) {
      const waitMs = slashGuard.throttleRemainingMs(user);
      if (waitMs > 0) {
        const r = await slashGuard.recordRejectedAttempt(user, 'on_cooldown', req.body.action);
        if (r.locked) return res.status(200).json({ success: false, error: 'account_locked', message: '🔒 Your account is locked for review. Contact support.' });
        return res.status(200).json({
          success: false,
          error: 'too_fast',
          message: `⏳ Too many attempts. Please wait ${Math.ceil(waitMs / 1000)} seconds.`,
          retryAfterMs: waitMs,
        });
      }
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

    // ── Start Action ───────────────────────────────────────────────
    // Opened the arena — mint a short-lived, single-use session that the
    // eventual 'claim' call must present. Fails fast here if on cooldown
    // (or over the daily/weekly cap) instead of letting a script open a
    // session it can never legitimately use.
    if (action === 'start') {
      if (onCooldown) {
        // The real app checks the cooldown before opening the arena, so this is rare for people and constant for scripts.
        const r = await slashGuard.recordRejectedAttempt(user, 'on_cooldown', 'start');
        if (r.locked) return res.status(200).json({ success: false, error: 'account_locked', message: '🔒 Your account is locked for review. Contact support.' });
        return res.status(200).json({ success: false, error: 'on_cooldown', nextAvailableAt, remainingMs });
      }
      const sessionId = await createSlashSession(telegramId);
      return res.status(200).json({ success: true, sessionId });
    }

    // ── Claim / Slash Action ───────────────────────────────────────
    if (action === 'claim') {
      if (onCooldown) {
        const r = await slashGuard.recordRejectedAttempt(user, 'on_cooldown', 'claim');
        if (r.locked) return res.status(200).json({ success: false, error: 'account_locked', message: '🔒 Your account is locked for review. Contact support.' });
        return res.status(200).json({
          success: false,
          error: 'on_cooldown',
          message: 'Fruit slice is on cooldown. Come back in 30 minutes!',
          nextAvailableAt,
          remainingMs,
        });
      }

      const sessionCheck = await claimSlashSession(telegramId, req.body && req.body.sessionId);
      if (!sessionCheck.ok) {
        const r = await slashGuard.recordRejectedAttempt(user, sessionCheck.reason, 'claim');
        if (r.locked) return res.status(200).json({ success: false, error: 'account_locked', message: '🔒 Your account is locked for review. Contact support.' });
        return res.status(200).json({
          success: false,
          error: 'invalid_session',
          message: 'Please open the slice game and play a round before claiming.',
        });
      }

      // NOTE: sessionCheck already atomically marked the session 'claimed'
      // above — that's deliberate and happens BEFORE the daily/weekly caps
      // below so a session can't be claimed twice even if two requests
      // race here. If either cap rejects this claim, the session is spent
      // and the player simply needs to reopen the arena for a new one —
      // an acceptable trade-off since hitting the daily/weekly cap is rare
      // and reopening the arena is exactly what a script *can't* cheaply
      // fake its way around anyway.

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

      // 1. Calculate slice reward: 25 - 50 FC (weighted, rolled server-side only)
      const baseReward = pickSlashReward();

      // 2. Calculate XP & Level progression (+5 XP per slash)
      const oldXp = user.xp || 0;
      const newXp = oldXp + SLASH_XP_REWARD;
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

      // Anti-bot: is THIS claim landing suspiciously close to the exact
      // cooldown boundary (bot-scheduler behavior), continuing a streak of
      // the same from previous claims?
      const isPreciseTiming = lastSlashTime > 0 && Math.abs(elapsed - SLASH_COOLDOWN_MS) <= PRECISION_TOLERANCE_MS;
      const newStreak = isPreciseTiming ? (user.slashPreciseStreak || 0) + 1 : 0;

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
            xp: SLASH_XP_REWARD,
          },
          $set: {
            level: newLevel,
            lastSlashAt: now,
            lastActive: now,
            slashPreciseStreak: newStreak,
          },
          // last 6 start->claim times (ms): a script repeats the same number, a person never does
          $push: { slashPlay: { $each: [Math.round(sessionCheck.playMs || 0)], $slice: -slashGuard.CFG.PLAY_SAMPLES } },
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

      // Bot-precise timing streak. Admin is told at 3 in a row; at 4 in a row the account is locked
      // (soft lock: balance stays, one tap to unlock in the admin bot). Never an automatic ban.
      if (newStreak >= PRECISION_STREAK_LOCK_AT) {
        const locked = await lockUser(updatedUser, 'bot_pattern', { botFlaggedAt: new Date() }).catch(() => false);
        if (locked) {
          notifyAdmin(
            `🤖 <b>Slash script detected — account LOCKED</b>\n\n` +
              `User <code>${user.telegramId}</code> (@${user.username || 'unknown'}) claimed <b>${newStreak}</b> slash rewards in a row ` +
              `within ${PRECISION_TOLERANCE_MS / 1000}s of the exact 30-minute cooldown. A person is never that regular.\n\n` +
              `The account is 🔒 locked (no slash, ads, withdrawals). If it was a real player, unlock below.`,
            { reply_markup: slashGuard.userButtons(user.telegramId) }
          ).catch(() => {});
        }
      } else if (newStreak >= PRECISION_STREAK_FLAG_AT && newStreak % PRECISION_STREAK_FLAG_AT === 0) {
        notifyAdmin(
          `🤖 <b>Possible scripted slash activity</b>\n\n` +
            `User <code>${user.telegramId}</code> (@${user.username || 'unknown'}) has claimed ` +
            `<b>${newStreak}</b> slash rewards in a row within ${PRECISION_TOLERANCE_MS / 1000}s of the exact ` +
            `30-minute cooldown — one more and the account is locked automatically.`,
          { reply_markup: slashGuard.reviewButtons(user.telegramId) }
        ).catch(() => {});
      }

      // Withdraw details (lib/wdProfile.js)
      await trackWd(user.telegramId, 'slash', totalReward - (levelReward || 0));

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
      // Awaited (not fire-and-forget): serverless can freeze work that is still running after the response.
      // Capped at 1.5 s so detection can never make a real claim feel slow.
      try {
        await Promise.race([
          (async () => {
            const col = await getCollection('slashLog');
            await col.insertOne({ telegramId: user.telegramId, createdAt: now });
            await slashGuard.checkSyncGroup(updatedUser, now);   // same-time multi-account clusters
            await slashGuard.checkPlayTime(updatedUser);          // metronome play-time (alert only)
          })(),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
      } catch (e) { /* detection must never break a claim */ }

      // 6. Trigger referral milestones asynchronously
      checkReferralStep3(updatedUser).catch(() => {});
      // Also check: does this claim make the referral "valid" for this
      // week's Top Referrer leaderboard? (needs channel+payment-channel join + first
      // game claim — separate from Step 3's 10-claim/120 FC milestone above.)
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
