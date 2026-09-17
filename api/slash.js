// api/slash.js
// POST /api/slash  { action: 'status' | 'gate_session' | 'claim' | 'leaderboard' }
// GET  /api/slash?cron=weekly&secret=...   (Vercel Cron only — see vercel.json)
//
// This is the "One Slash" mini-game's real backend (previously referenced
// in index.html but never implemented — see lib/slashGame.js). It also
// doubles as the weekly "Top Slasher" leaderboard endpoint and the weekly
// cron entrypoint, to stay within Vercel Hobby's 12-Serverless-Function cap.
//
// Ad-gated claim: before the reward can be claimed, the player must watch
// one ad (GigaPub or Adsgram, chosen client-side) — action 'gate_session'
// issues a single-use 'slashGate' ad session (see lib/adSession.js, 10s
// server-enforced minimum watch time), and 'claim' requires that session's
// id and rejects the claim if it wasn't genuinely watched.
//
// Reward credits Fruit Coin directly (see lib/slashGame.js's REWARD_TABLE).

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { getSettings } = require('../lib/settings');
const { TRANSACTION_TYPES, LEADERBOARD_RANK_WEIGHTS } = require('../lib/constants');
const { SLASH_COOLDOWN_MS, pickSlashReward } = require('../lib/slashGame');
const { createAdSession, claimAdSession } = require('../lib/adSession');
const { maybeTriggerValidReferral, distributeWeeklyReferralRewards } = require('../lib/referral');
const {
  getWeekKey,
  recordSlashWin,
  getWeeklyWins,
  getTopSlashers,
  getUserRank,
  distributeWeeklyPrizes,
} = require('../lib/leaderboard');

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

// Issues a single-use gate-ad session. Frontend calls this right after the
// fruit is destroyed, shows one ad (GigaPub or Adsgram — its choice), then
// calls 'claim' with the returned sessionId.
async function handleGateSession(req, res, user) {
  const sessionId = await createAdSession(user.telegramId, 'slashGate');
  return res.status(200).json({ success: true, sessionId });
}

async function handleClaim(req, res, user) {
  const { sessionId } = req.body || {};
  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'missing_ad_session' });
  }

  // Must have genuinely watched the gate ad (server-enforced 10s minimum,
  // single-use session tied to this user) before any reward is credited.
  const gate = await claimAdSession(user.telegramId, sessionId, 'slashGate');
  if (!gate.ok) {
    return res.status(200).json({ success: false, error: 'ad_not_verified', reason: gate.reason });
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - SLASH_COOLDOWN_MS);
  const usersCol = await getCollection('users');

  // Server-decided reward — never trust anything from the client here.
  const fcReward = pickSlashReward();

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
    meta: { weekKey },
    createdAt: now,
  });

  maybeTriggerValidReferral(updated); // fire-and-forget

  return res.status(200).json({
    success: true,
    fcReward,
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
    if (action === 'gate_session') return await handleGateSession(req, res, user);
    if (action === 'claim') return await handleClaim(req, res, user);
    if (action === 'leaderboard') return await handleLeaderboard(req, res, user);
    return res.status(400).json({ success: false, error: 'invalid_action' });
  } catch (err) {
    console.error('slash endpoint error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};
