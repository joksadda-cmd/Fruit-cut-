// api/postback.js
// Server-to-server (S2S) reward postback receiver — currently wired for
// GigaPub. GigaPub's OWN ad server calls this URL directly once an ad has
// genuinely been shown (not the user's browser) — this is the strongest
// possible verification, since nothing on the user's device can fake a
// call that never goes through their device at all.
//
// GigaPub's support confirmed they'll send a GET request here and expect
// a 200 response no matter what — so this ALWAYS returns 200 and logs
// problems server-side instead of surfacing them back to GigaPub.
//
// URL registered with GigaPub support (appid 6350):
//   https://fruit-cut-eight.vercel.app/api/postback?network=gigapub&uid={user_id}&event=ad_shown&token=fc_pb_8x9k2m4n7q

const { getCollection, findUserByTelegramId } = require('../lib/db');
const { getSettings } = require('../lib/settings');
const { maybeTriggerValidReferral } = require('../lib/referral');

// Shared secret agreed with GigaPub support — anyone hitting this URL
// without the right token is ignored. If you ever need to rotate it,
// update it both here AND in GigaPub's dashboard/support ticket.
const POSTBACK_TOKEN = 'fc_pb_8x9k2m4n7q';
const DEDUPE_WINDOW_MS = 60 * 1000; // ignore an identical repeat within 60s (network retries)

module.exports = async (req, res) => {
  const ok = () => res.status(200).send('OK'); // GigaPub always gets 200

  try {
    const { network, uid, event, token } = req.query || {};

    if (token !== POSTBACK_TOKEN) {
      console.warn('postback: invalid token', req.query);
      return ok();
    }
    if (network !== 'gigapub' || !uid) {
      console.warn('postback: unexpected network/uid', req.query);
      return ok();
    }

    const telegramId = String(uid);
    const usersCol = await getCollection('users');
    const user = await findUserByTelegramId(usersCol, telegramId);
    if (!user || user.banned) return ok();

    const eventsCol = await getCollection('postbackEvents');

    // Dedupe — ignore an identical postback fired again within the window
    // (guards against GigaPub retrying the same notification).
    const recentDupe = await eventsCol.findOne({
      telegramId,
      network,
      event,
      receivedAt: { $gte: new Date(Date.now() - DEDUPE_WINDOW_MS) },
    });
    if (recentDupe) return ok();

    // Same daily cap as everything else (default 20/day for gigapub)
    const settings = await getSettings();
    const maxPerDay = (settings.adDailyLimits && settings.adDailyLimits.gigapub) || 20;
    const todayStr = new Date().toISOString().slice(0, 10);
    const startOfDay = new Date(todayStr + 'T00:00:00.000Z');
    const countToday = await eventsCol.countDocuments({
      telegramId,
      network,
      event,
      receivedAt: { $gte: startOfDay },
    });
    if (countToday >= maxPerDay) return ok();

    const rewardGold = (settings.adRewardGold && settings.adRewardGold.gigapub) || 120;

    const updatedUser = await usersCol.findOneAndUpdate(
      { _id: user._id },
      { $inc: { gold: rewardGold, totalAdsWatched: 1 }, $set: { lastActive: new Date() } },
      { returnDocument: 'after' }
    );
    if (updatedUser) maybeTriggerValidReferral(updatedUser);

    await eventsCol.insertOne({ telegramId, network, event, receivedAt: new Date() });

    const txCol = await getCollection('transactions');
    await txCol.insertOne({
      telegramId,
      type: 'ad_reward',
      amount: rewardGold,
      balanceAfter: updatedUser ? updatedUser.gold : undefined,
      meta: { network: 'gigapub', event, source: 's2s_postback' },
      createdAt: new Date(),
    });

    return ok();
  } catch (err) {
    console.error('postback error:', err);
    return res.status(200).send('OK'); // still 200 — this is logged, not surfaced
  }
};
