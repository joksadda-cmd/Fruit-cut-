// api/cron_weekly_leaderboard.js
// GET /api/cron_weekly_leaderboard
// Triggered by vercel.json `crons` — runs Monday 00:05 UTC (Vercel Hobby
// only guarantees "sometime within that hour", not the exact minute — see
// https://vercel.com/docs/cron-jobs/usage-and-pricing) — and pays out BOTH
// weekly competitions for the week that just ended:
//   1. "Top Slasher" — lib/leaderboard.js (30,000 FC pool, top 20)
//   2. "Top Referrer" — lib/referralLeaderboard.js (25,000 FC pool, top 10)
// Combined into one cron job on purpose — simpler to deploy/maintain, and
// both fire off the same weekly boundary. (Vercel Hobby actually allows up
// to 100 cron jobs and any cadence of once/day or slower, so a weekly
// schedule like this one is fine even split across two jobs — this is just
// the simpler choice, not a plan limitation.)
// Idempotent (see each module's `distributed` marker), so a retried or
// duplicate cron hit is harmless.
//
// Manual testing: GET this URL yourself with header
//   Authorization: Bearer <CRON_SECRET>
// (only enforced if CRON_SECRET is set in the environment — Vercel's own
// cron trigger is trusted automatically via the x-vercel-cron header).

const { getWeekKey, distributeWeeklyPrizes } = require('../lib/leaderboard');
const { distributeWeeklyReferralPrizes } = require('../lib/referralLeaderboard');

module.exports = async (req, res) => {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const secret = process.env.CRON_SECRET;
  const auth = req.headers['authorization'] || '';
  const isAuthorized = isVercelCron || !secret || auth === `Bearer ${secret}`;

  if (!isAuthorized) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }

  try {
    // Cron fires just after the new week starts, so "yesterday" still falls
    // in the week that just ended — pay that one out.
    const endedWeekKey = getWeekKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const [slashResult, referralResult] = await Promise.all([
      distributeWeeklyPrizes(endedWeekKey),
      distributeWeeklyReferralPrizes(endedWeekKey),
    ]);
    return res.status(200).json({
      success: true,
      weekKey: endedWeekKey,
      slash: slashResult,
      referral: referralResult,
    });
  } catch (err) {
    console.error('cron_weekly_leaderboard error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};
