// api/cron_notify.js
// GET /api/cron_notify
// Runs every 8–12 hours (set in cron-job.org) and broadcasts ONE rotating notification to every
// non-banned user — a different message each run, cycling through
// MESSAGES below in order and wrapping back to the start.
//
// Same reason this is a cron endpoint at all (not a Vercel `crons` entry,
// not a setInterval somewhere) as api/cron_weekly_leaderboard.js: Vercel
// serverless functions don't stay running/"awake" between requests, so
// there's nothing to run a timer inside — an external scheduler has to
// hit this URL on a schedule instead.
//
// Not wired to vercel.json `crons` — this project uses an external
// scheduler (e.g. cron-job.org) for all cron endpoints. Point it at this
// URL every 12 hours, with header:
//   Authorization: Bearer <CRON_SECRET>
// (same CRON_SECRET already used for cron_weekly_leaderboard.js.)
//
// Rotation state (which message goes out next) is persisted in the
// `cronState` collection so it survives across serverless invocations —
// each run atomically advances a counter and picks MESSAGES[counter % length].
//
// To add/remove/edit messages: just edit the MESSAGES array below. Order
// matters (that's the rotation order) but the count doesn't need to be a
// multiple of anything — rotation wraps automatically.

const { getCollection } = require('../lib/db');
const { broadcastToAllUsers } = require('../lib/notify');
const { scanDeposits } = require('../lib/sponsor');
const { alertPendingWithdrawals } = require('../lib/withdrawAlert');

// Same values api/bot.js hardcodes for its own "Open App" buttons — if you
// ever rename the bot or the Mini App short name, update BOTH files.
const BOT_USERNAME = 'Fruit_cut_bot';
const MINI_APP_SHORTNAME = 'PlayTo_Earn';
const MINI_APP_URL = `https://t.me/${BOT_USERNAME}/${MINI_APP_SHORTNAME}`;
const OPEN_APP_BUTTON = { reply_markup: { inline_keyboard: [[{ text: '🎮 Open Fruit Cut', url: MINI_APP_URL }]] } };

const MESSAGES = [
  {
    key: 'refer_contest',
    text:
      `👥 <b>Win the Weekly Referral Contest!</b>\n\n` +
      `Invite your friends to Fruit Cut Slice and climb this week's Top Referrer leaderboard.\n\n` +
      `🏆 Top 20 referrers split a 100,000 🍎 prize pool (about $2) — 1st place wins 20,000 🍎! Just 15 referrals to qualify.`,
  },
  {
    key: 'slash_contest',
    text:
      `🔪 <b>Slash Unlimited & Become This Week's Champion!</b>\n\n` +
      `Every slash win counts toward the Top Slasher leaderboard — the more you slash, the higher you climb.\n\n` +
      `🏆 Top 20 slashers split a 30,000 🍎 prize pool!`,
  },
  {
    key: 'daily_reminder',
    text:
      `⏰ <b>Don't Miss Today's Rewards!</b>\n\n` +
      `Your Treasure Box and daily tasks are waiting — come collect your Fruit Coin before it slips away.\n\n` +
      `🍎 A few minutes a day adds up fast!`,
  },
];

module.exports = async (req, res) => {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const secret = process.env.CRON_SECRET;
  const auth = req.headers['authorization'] || '';
  const isAuthorized = isVercelCron || !secret || auth === `Bearer ${secret}`;

  if (!isAuthorized) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }

  // AUTO TON-DEPOSIT CHECK (Sponsor & Post Task) — merged here to stay under Vercel Hobby's 12-function limit.
  // cron-job.org URL: /api/cron_notify?job=ton_deposits  (every 1 minute, same Authorization header)
  if (req.query && req.query.job === 'ton_deposits') {
    try {
      const result = await scanDeposits({ force: true });
      // Same 1-minute job also re-sends any withdrawal alert that did not reach the admin the first time.
      let withdrawAlerts = null;
      try { withdrawAlerts = await alertPendingWithdrawals(); } catch (e) { console.error('withdraw alert retry error:', e); }
      return res.status(200).json({ success: result.ok !== false, ...result, withdrawAlerts });
    } catch (err) {
      console.error('cron ton_deposits error:', err);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }

  try {
    const stateCol = await getCollection('cronState');

    // Safety: if the scheduler fires twice by mistake (or every few minutes), do NOT spam users.
    // Minimum gap between two broadcasts = 5 hours (the schedule is every 8–12 hours). ?force=1 skips this.
    const MIN_GAP_MS = 5 * 60 * 60 * 1000;
    const prev = await stateCol.findOne({ _id: 'notify_rotation' });
    const forced = req.query && (req.query.force === '1' || req.query.force === 'true');
    if (!forced && prev && prev.lastRunAt && Date.now() - new Date(prev.lastRunAt).getTime() < MIN_GAP_MS) {
      return res.status(200).json({ success: true, skipped: true, reason: 'too_soon', lastRunAt: prev.lastRunAt });
    }

    const state = await stateCol.findOneAndUpdate(
      { _id: 'notify_rotation' },
      { $inc: { index: 1 }, $set: { lastRunAt: new Date() } },
      { upsert: true, returnDocument: 'after' }
    );

    const idx = ((state.index - 1) % MESSAGES.length + MESSAGES.length) % MESSAGES.length;
    const message = MESSAGES[idx];

    const result = await broadcastToAllUsers(message.text, OPEN_APP_BUTTON);

    return res.status(200).json({
      success: true,
      messageKey: message.key,
      rotationIndex: idx,
      ...result,
    });
  } catch (err) {
    console.error('cron_notify error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};
