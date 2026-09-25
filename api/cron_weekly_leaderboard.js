// api/cron_weekly_leaderboard.js
// GET /api/cron_weekly_leaderboard
// Runs Monday 00:05 UTC (any time in that hour is fine) and:
//   1. Pays out BOTH weekly competitions for the week that just ended:
//      - "Top Slasher" — lib/leaderboard.js (30,000 FC pool, top 20)
//      - "Top Referrer" — lib/referralLeaderboard.js (50,000 FC pool, top 15)
//   2. Broadcasts the top-3 winners of each to EVERY user (not just the
//      winners, who already get an individual DM from step 1).
//   3. Broadcasts a separate "new week has started" announcement.
// Combined into one cron job on purpose — simpler to deploy/maintain, and
// both fire off the same weekly boundary.
// Idempotent (see each module's `distributed` marker) — a retried or
// duplicate hit pays out and broadcasts at most once per week.
//
// Not wired to vercel.json `crons` — this project intentionally uses an
// external scheduler (e.g. cron-job.org) instead. Point it at this URL,
// once a week, with header:
//   Authorization: Bearer <CRON_SECRET>
// (CRON_SECRET must be set in the Vercel project's environment variables —
// without it, this endpoint has no auth check at all, so set one).

const { getWeekKey, distributeWeeklyPrizes } = require('../lib/leaderboard');
const { distributeWeeklyReferralPrizes } = require('../lib/referralLeaderboard');
const { broadcastToAllUsers } = require('../lib/notify');
const { getCollection } = require('../lib/db');

function medal(rank) {
  return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
}

function formatWinnersLine(entry) {
  const name = entry.username && entry.username !== 'Player' ? `@${entry.username}` : 'A player';
  return `${medal(entry.rank)} ${name} — 🍎 ${entry.prize.toLocaleString()} FC`;
}

module.exports = async (req, res) => {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const secret = process.env.CRON_SECRET;
  const auth = req.headers['authorization'] || '';
  const isAuthorized = isVercelCron || !secret || auth === `Bearer ${secret}`;

  if (!isAuthorized) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }

  try {
    // One-time manual escape hatch: ?resetWeek=YYYY-MM-DD clears that week's
    // "already distributed" marker in BOTH collections before doing anything
    // else — for undoing an accidental early/duplicate distribution (e.g. a
    // test run, or a misconfigured schedule that fired mid-week) so the real
    // payout can happen cleanly once the week actually ends. Still requires
    // the same CRON_SECRET auth as everything else here.
    const resetWeek = req.query && req.query.resetWeek;
    if (resetWeek) {
      const slashCol = await getCollection('leaderboard');
      const referCol = await getCollection('referralLeaderboard');
      await Promise.all([
        slashCol.deleteOne({ _id: `marker_${resetWeek}` }),
        referCol.deleteOne({ _id: `marker_${resetWeek}` }),
      ]);
      return res.status(200).json({ success: true, resetWeek, message: 'Marker cleared — this week can be distributed again.' });
    }

    // Cron fires just after the new week starts, so "yesterday" still falls
    // in the week that just ended — pay that one out.
    const endedWeekKey = getWeekKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const [slashResult, referralResult] = await Promise.all([
      distributeWeeklyPrizes(endedWeekKey),
      distributeWeeklyReferralPrizes(endedWeekKey),
    ]);

    let winnerBroadcast = null;
    let startBroadcast = null;

    // Only broadcast once, on the run that actually distributed the prizes
    // (a retried/duplicate hit sees alreadyDistributed:true and skips this,
    // so users never get the same "winners" message twice).
    const freshlyDistributed = !slashResult.alreadyDistributed || !referralResult.alreadyDistributed;

    if (freshlyDistributed) {
      const topSlashers = (slashResult.paid || []).slice(0, 3);
      const topReferrers = (referralResult.paid || []).slice(0, 3);

      let text = `🏆 <b>Last Week's Contest Results!</b>\n\n`;
      text += `🔪 <b>Top Slashers</b>\n`;
      text += topSlashers.length ? topSlashers.map(formatWinnersLine).join('\n') : 'No qualifying entries this week.';
      text += `\n\n👥 <b>Top Referrers</b>\n`;
      text += topReferrers.length ? topReferrers.map(formatWinnersLine).join('\n') : 'No qualifying entries this week.';
      text += `\n\nCongrats to the winners! 🎉`;

      winnerBroadcast = await broadcastToAllUsers(text);

      const startText =
        `🎮 <b>A New Weekly Contest Has Started!</b>\n\n` +
        `🔪 Slash fruit to climb the Top Slasher board\n` +
        `👥 Refer friends to climb the Top Referrer board\n\n` +
        `Both reset now — good luck this week! 🚀`;
      startBroadcast = await broadcastToAllUsers(startText);
    }

    return res.status(200).json({
      success: true,
      weekKey: endedWeekKey,
      slash: slashResult,
      referral: referralResult,
      winnerBroadcast,
      startBroadcast,
    });
  } catch (err) {
    console.error('cron_weekly_leaderboard error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};
