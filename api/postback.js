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
//   https://<your-domain>/api/postback?network=gigapub&uid={user_id}&event=ad_shown&token=<GIGAPUB_POSTBACK_TOKEN>

const { getCollection, findUserByTelegramId } = require('../lib/db');
const { getSettings } = require('../lib/settings');
const { maybeTriggerValidReferral, checkReferralStep4 } = require('../lib/referral');
const { planXp } = require('../lib/xp');
const { track: trackWd } = require('../lib/wdProfile');
const { markGameGigapubPostback, recordAdsgramConfirm } = require('../lib/adSession');

// Shared secret agreed with GigaPub support — anyone hitting this URL
// without the right token is ignored. If you ever need to rotate it,
// update it both here AND in GigaPub's dashboard/support ticket.
// The GigaPub secret lives ONLY in the Vercel env var GIGAPUB_POSTBACK_TOKEN (never in code). If it is missing, every
// GigaPub postback is refused (fail closed) — nobody can be paid until it is set.
const crypto = require('crypto');
const { checkAndIncrementDailyLimit } = require('../lib/dailyLimit');
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const DEDUPE_WINDOW_MS = 60 * 1000; // ignore an identical repeat within 60s (network retries)

module.exports = async (req, res) => {
  const ok = () => res.status(200).send('OK'); // GigaPub always gets 200

  try {
    const { network, uid, event, token } = req.query || {};

    // ── Adsgram "Reward URL": Adsgram's server confirms the user really got the reward ──
    // URL set in the Adsgram dashboard:  /api/postback?network=adsgram|adsgramDaily|adsgramTask&token=SECRET&uid=[userId]
    if (network === 'adsgram' || network === 'adsgramDaily' || network === 'adsgramTask') {
      const secret = String(process.env.ADSGRAM_REWARD_TOKEN || '').trim();
      const given = String(Array.isArray(token) ? token[0] : token || '').trim();
      const q = req.query || {};
      const rawUid = String(q.uid || q.userid || q.userId || q.user_id || '').trim();
      const tokenOk = !!secret && given === secret;
      const uidOk = /^\d{3,15}$/.test(rawUid);
      let recorded = false;
      if (tokenOk && uidOk) recorded = await recordAdsgramConfirm(rawUid, network);
      // One diagnostic line per Adsgram callback (never prints the secret) -> Vercel > Logs, search "adsgram-postback"
      console.log(`adsgram-postback network=${network} tokenOk=${tokenOk} (given length ${given.length}, expected ${secret.length}) uid="${rawUid.slice(0, 20)}" uidOk=${uidOk} recorded=${recorded}`);
      return ok();
    }

    const gpToken = String(process.env.GIGAPUB_POSTBACK_TOKEN || '').trim();
    if (!gpToken) {
      console.error('[guardian] GIGAPUB_POSTBACK_TOKEN is not set — GigaPub postback refused.');
      return ok();
    }
    const givenTok = String(Array.isArray(token) ? token[0] : token || '');
    if (!safeEqual(givenTok, gpToken)) {
      console.warn('postback: invalid token');
      return ok();
    }
    if (network !== 'gigapub' || !uid || !/^\d{3,15}$/.test(String(uid))) {
      console.warn('postback: unexpected network/uid', req.query);
      return ok();
    }

    const telegramId = String(uid);
    const usersCol = await getCollection('users');
    const user = await findUserByTelegramId(usersCol, telegramId);
    if (!user || user.banned || user.accountLocked) return ok(); // banned / locked accounts earn nothing

    // In-game claim: if this view belongs to a pending in-game GigaPub claim, just confirm it
    // for that claim (api/ads.js pays it, spending 3 min of play time) — do NOT also pay here.
    if (await markGameGigapubPostback(telegramId)) return ok();

    const eventsCol = await getCollection('postbackEvents');

    // 1) Atomic "one reward per 60s" gate. The old check (read, then write AFTER paying) could be beaten by sending
    //    many identical requests at the same moment — every one of them passed before the first was recorded.
    //    Here the unique _id makes the database itself reject every request but one.
    try {
      const gate = await getCollection('postbackGate');
      await gate.findOneAndUpdate(
        { _id: `gp_${telegramId}`, lastAt: { $lt: new Date(Date.now() - DEDUPE_WINDOW_MS) } },
        { $set: { lastAt: new Date(), expireAt: new Date(Date.now() + 24 * 3600 * 1000) } },
        { upsert: true }
      );
    } catch (e) {
      return ok(); // duplicate key = a reward was already given in the last 60s
    }

    // 2) Atomic daily cap (same counter style as every other reward) — reserve the slot BEFORE paying.
    const settings = await getSettings();
    const maxPerDay = (settings.adDailyLimits && settings.adDailyLimits.gigapub) || 20;
    const cap = await checkAndIncrementDailyLimit(telegramId, 'gigapub_postback', maxPerDay);
    if (!cap.allowed) return ok();
    await eventsCol.insertOne({ telegramId, network, event, receivedAt: new Date() });

    const rewardFc = (settings.adRewardFc && settings.adRewardFc.gigapub) || 20;

    // GigaPub (Ads section) = 2 XP (lib/xp.js), plus the normal bonus if that XP levels the user up.
    const plan = planXp(user, 'gigapub');
    const inc = { fruitCoin: rewardFc + plan.levelReward, totalAdsWatched: 1 };
    const set = { lastActive: new Date() };
    if (plan.xpGain > 0) { inc.xp = plan.xpGain; if (plan.isLevelUp) set.level = plan.newLevel; }
    const updatedUser = await usersCol.findOneAndUpdate(
      { _id: user._id },
      { $inc: inc, $set: set },
      { returnDocument: 'after' }
    );
    if (updatedUser && plan.isLevelUp && plan.newLevel >= 3) checkReferralStep4(updatedUser, plan.newLevel).catch(() => {});
    if (updatedUser) maybeTriggerValidReferral(updatedUser);
    if (updatedUser) await trackWd(telegramId, 'ad', rewardFc, 'gigapub'); // withdraw details (lib/wdProfile.js)

    const txCol = await getCollection('transactions');
    await txCol.insertOne({
      telegramId,
      type: 'ad_reward',
      amount: rewardFc,
      currency: 'FC',
      balanceAfter: updatedUser ? updatedUser.fruitCoin : undefined,
      meta: { network: 'gigapub', event, source: 's2s_postback' },
      createdAt: new Date(),
    });

    return ok();
  } catch (err) {
    console.error('postback error:', err);
    return res.status(200).send('OK'); // still 200 — this is logged, not surfaced
  }
};
