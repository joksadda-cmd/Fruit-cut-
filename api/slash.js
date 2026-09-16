// api/slash.js
// POST /api/slash  { action: 'status' | 'claim' | 'leaderboard' }
// GET  /api/slash?cron=weekly&secret=...   (Vercel Cron only — see vercel.json)
//
// This is the "One Slash" mini-game's real backend (previously referenced
// in index.html but never implemented — see lib/slashGame.js). It also
// doubles as the weekly "Top Slasher" leaderboard endpoint and the weekly
// cron entrypoint, to stay within Vercel Hobby's 12-Serverless-Function cap.
//
// GOLD REMOVED (2026-09): the slash-game reward used to be tracked in
// plain USD (user.slashEarningsUsd) waiting for "the new currency system."
// This IS that new system — the USD reward now converts straight to Fruit
// Coin using settings.fcToUsdt, same rate withdrawals use (25,000 FC = $1).

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { getSettings } = require('../lib/settings');
const { TRANSACTION_TYPES, LEADERBOARD_RANK_WEIGHTS } = require('../lib/constants');
const { SLASH_COOLDOWN_MS, pickSlashReward } = require('../lib/slashGame');
const { maybeTriggerValidReferral, distributeWeeklyReferralRewards } = require('../lib/referral');
const {
  getWeekKey,
  recordSlashWin,
  getWeeklyWins,
  getTopSlashers,
  getUserRank,
  distributeWeeklyPrizes,
} = require('../lib/leaderboard');

function usdToFc(usd, settings) {
  const rate = settings.fcToUsdt || { fcAmount: 25000, usdtAmount: 1 };
  return Math.round((usd * rate.fcAmount) / rate.usdtAmount);
}

async function handleStatus(req, res, user) {
  const now = Date.now();
  const last = user.lastSlashAt ? new Date(user.lastSlashAt).getTime() : 0;
  const nextAvailableAt = last ? new Date(last + SLASH_COOLDOWN_MS) : null;
  const onCooldown = !!(nextAvailableAt && nextAvailableAt.getTime() > now);

  const weekKey = getWeekKey();
  const [weeklyWins, rank] = await Promise.all([
    getWeeklyWins(user.telegramId, weekKey),
    getUserRank(user.telegramId, weekKey),
  ]);
  const settings = await getSettings();

  return res.status(200).json({
    success: true,
    onCooldown,
    nextAvailableAt,
    weeklyWins,
    rank,
    minSlashWinsForWeeklyReferral: (settings.weeklyReferral && settings.weeklyReferral.minSlashWinsRequired) || 150,
  });
}

async function handleClaim(req, res, user) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - SLASH_COOLDOWN_MS);
  const usersCol = await getCollection('users');

  // Server-decided reward — never trust anything from the client here.
  const usdReward = pickSlashReward();
  const settings = await getSettings();
  const fcReward = usdToFc(usdReward, settings);

  // Atomic: only succeeds if lastSlashAt is missing/null or older than the
  // cooldown cutoff — so a double-tap/replay can't double-claim.
  const updated = await usersCol.findOneAndUpdate(
    {
      _id: user._id,
      $or: [{ lastSlashAt: { $exists: false } }, { lastSlashAt: null }, { lastSlashAt: { $lt: cutoff } }],
    },
    [
      {
        $set: {
          lastSlashAt: now,
          fruitCoin: { $add: [{ $ifNull: ['$fruitCoin', 0] }, fcReward] },
          slashEarningsUsd: { $add: [{ $ifNull: ['$slashEarningsUsd', 0] }, usdReward] },
          totalSlashWins: { $add: [{ $ifNull: ['$totalSlashWins', 0] }, 1] },
          totalGamesPlayed: { $add: [{ $ifNull: ['$totalGamesPlayed', 0] }, 1] },
        },
      },
    ],
    { returnDocument: 'after' }
  );

  if (!updated) {
    const fresh = await usersCol.findOne({ _id: user._id });
    const nextAvailableAt = fresh && fresh.lastSlashAt ? new Date(new Date(fresh.lastSlashAt).getTime() + SLASH_COOLDOWN_MS) : now;
    return res.status(200).json({ success: false, error: 'on_cooldown', nextAvailableAt });
  }

  const weekKey = await recordSlashWin(user.telegramId, user.username);

  const txCol = await getCollection('transactions');
  await txCol.insertOne({
    telegramId: user.telegramId,
    type: TRANSACTION_TYPES.SLASH_REWARD,
    amount: fcReward,
    balanceAfter: updated.fruitCoin,
    meta: { usdReward, weekKey },
    createdAt: now,
  });

  maybeTriggerValidReferral(updated); // fire-and-forget

  return res.status(200).json({
    success: true,
    fcReward,
    usdReward,
    nextAvailableAt: new Date(now.getTime() + SLASH_COOLDOWN_MS),
    user: { fruitCoin: updated.fruitCoin },
  });
}

async function handleLeaderboard(req, res, user) {
  const settings = await getSettings();
  const topN = (settings.leaderboard && settings.leaderboard.topN) || 10;
  const weekKey = getWeekKey();

  const [top, myRank, myWins] = await Promise.all([
    getTopSlashers(weekKey, topN),
    getUserRank(user.telegramId, weekKey),
    getWeeklyWins(user.telegramId, weekKey),
  ]);

  return res.status(200).json({
    success: true,
    weekKey,
    prizePoolFc: (settings.leaderboard && settings.leaderboard.weeklyPrizePoolFc) || 10000,
    rankWeights: LEADERBOARD_RANK_WEIGHTS,
    top: top.map((t, i) => ({ rank: i + 1, telegramId: t.telegramId, username: t.username, wins: t.wins })),
    me: { rank: myRank, wins: myWins },
  });
}

// ── Weekly cron: distribute leaderboard prizes + weekly referral rewards
// for the week that JUST ended. Vercel Cron hits this via GET with a
// shared secret — see vercel.json's crons entry and CRON_SECRET env var.
async function handleCron(req, res) {
  // Vercel Cron automatically sends `Authorization: Bearer <CRON_SECRET>`
  // when a CRON_SECRET env var is set on the project — this is Vercel's
  // documented pattern for verifying a request really came from its own
  // scheduler and not a random public GET to this URL.
  const authHeader = req.headers['authorization'] || '';
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }

  // The cron is scheduled for Monday just after 00:00 UTC, so "the week
  // that just ended" is the week containing a few minutes ago.
  const justEnded = new Date(Date.now() - 5 * 60 * 1000);
  const weekKey = getWeekKey(justEnded);

  const settings = await getSettings();
  const prizePoolFc = (settings.leaderboard && settings.leaderboard.weeklyPrizePoolFc) || 10000;
  const topN = (settings.leaderboard && settings.leaderboard.topN) || 10;
  const minSlashWinsRequired = (settings.weeklyReferral && settings.weeklyReferral.minSlashWinsRequired) || 150;
  const bonusFcPerReferral = (settings.weeklyReferral && settings.weeklyReferral.bonusFcPerReferral) || 100;

  const leaderboardResult = await distributeWeeklyPrizes(weekKey, prizePoolFc, topN);
  const referralResult = await distributeWeeklyReferralRewards(weekKey, minSlashWinsRequired, bonusFcPerReferral);

  return res.status(200).json({
    success: true,
    weekKey,
    leaderboard: leaderboardResult,
    weeklyReferral: referralResult,
  });
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    try {
      return await handleCron(req, res);
    } catch (err) {
      console.error('slash cron error:', err);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }

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
    if (!user) return res.status(404).json({ success: false, error: 'user_not_found' });
    if (user.banned) return res.status(403).json({ success: false, error: 'Account suspended' });

    const action = req.body && req.body.action;
    if (action === 'status') return await handleStatus(req, res, user);
    if (action === 'claim') return await handleClaim(req, res, user);
    if (action === 'leaderboard') return await handleLeaderboard(req, res, user);
    return res.status(400).json({ success: false, error: 'invalid_action' });
  } catch (err) {
    console.error('slash endpoint error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};
