// api/cron_notify.js
// GET /api/cron_notify
// Runs every 12 hours and broadcasts ONE rotating notification to every
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
      `🏆 Top referrers split a 50,000 🍎 prize pool — earn up to $1+ just from referrals!`,
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

  try {
    const stateCol = await getCollection('cronState');
    const state = await stateCol.findOneAndUpdate(
      { _id: 'notify_rotation' },
      { $inc: { index: 1 } },
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
