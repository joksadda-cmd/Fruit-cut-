// api/postback.js
// GET /api/postback?network=adsgram|monetag|gigapub&...
//
// ONE file handles ALL ad-network postbacks (keeps us under Vercel's
// 12-function free-tier limit — we'll need the remaining slots for
// game-reward, referral, withdrawal, shop, admin routes later).
//
// Each network is configured in ITS OWN dashboard to hit this same URL
// with a different `network=` value + its own macros.

const { getSettings } = require('../lib/settings');
const { creditGoldForAd } = require('../lib/adReward');

// Shared secret WE choose and append manually to the Reward URL when
// configuring each network's dashboard (e.g. ...&token=abc123xyz).
// Set this in Vercel env vars as POSTBACK_SECRET.
const POSTBACK_SECRET = process.env.POSTBACK_SECRET;

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  const { network } = req.query;
  if (!network) return res.status(400).send('missing network param');

  let settings;
  try {
    settings = await getSettings();
  } catch (e) {
    console.error('settings load failed', e);
    return res.status(500).send('settings error');
  }

  try {
    // ══════════════════════════════════════════════════════════════
    // ADSGRAM — you have 2 blocks (special + daily), each needs its
    // OWN Reward URL set in the AdsGram dashboard (partner.adsgram.ai
    // → your Ad unit → Reward URL field):
    //
    //   Special block (id 28066):
    //   https://YOURDOMAIN.com/api/postback?network=adsgram&type=special&userid=[userId]&token=YOUR_SECRET
    //
    //   Daily block (id int-28067):
    //   https://YOURDOMAIN.com/api/postback?network=adsgram&type=daily&userid=[userId]&token=YOUR_SECRET
    //
    // AdsGram replaces [userId] with the Telegram ID automatically.
    // ══════════════════════════════════════════════════════════════
    if (network === 'adsgram') {
      const { userid, token, type } = req.query;

      if (POSTBACK_SECRET && token !== POSTBACK_SECRET) {
        return res.status(403).send('invalid token');
      }
      if (!userid) return res.status(400).send('missing userid');

      const telegramId = parseInt(userid, 10);
      const isSpecial = type === 'special';
      const amount = isSpecial
        ? (settings.adRewardGold && settings.adRewardGold.adsgramSpecial) || 250
        : (settings.adRewardGold && settings.adRewardGold.adsgramDaily) || 120;
      const source = isSpecial ? 'adsgram_special' : 'adsgram_daily';

      // AdsGram sends no unique per-event ID, so we dedupe using a
      // 5-second bucket per user+type — blocks rapid-fire duplicate hits
      // while still allowing legitimate repeat ad views minutes apart.
      const bucket = Math.floor(Date.now() / 5000);
      const eventKey = `${source}_${telegramId}_${bucket}`;

      const result = await creditGoldForAd(telegramId, amount, source, eventKey);
      if (result.duplicate) return res.status(200).send('duplicate ignored');
      if (!result.success) return res.status(200).send('not credited: ' + result.reason);

      return res.status(200).send('OK');
    }

    // ══════════════════════════════════════════════════════════════
    // MONETAG
    // Dashboard postback URL, set to:
    //   https://YOURDOMAIN.com/api/postback?network=monetag&ymid={ymid}&event={event_type}&value={reward_event_type}&telegram_id={telegram_id}&token=YOUR_SECRET
    // IMPORTANT: frontend must pass a UNIQUE ymid per ad view when calling
    // the Monetag SDK (e.g. `telegramId + '_' + Date.now()`), or duplicate
    // detection won't work correctly.
    // ══════════════════════════════════════════════════════════════
    if (network === 'monetag') {
      const { ymid, value, telegram_id, token } = req.query;

      if (POSTBACK_SECRET && token !== POSTBACK_SECRET) {
        return res.status(403).send('invalid token');
      }
      // Only credit confirmed, monetized events — not every impression ping.
      if (value !== 'valued') return res.status(200).send('ignored (not valued)');
      if (!telegram_id) return res.status(400).send('missing telegram_id');
      if (!ymid) return res.status(400).send('missing ymid');

      const telegramId = parseInt(telegram_id, 10);
      const amount = (settings.adRewardGold && settings.adRewardGold.monetag) || 500;
      const eventKey = `monetag_${ymid}`;

      const result = await creditGoldForAd(telegramId, amount, 'monetag', eventKey);
      if (result.duplicate) return res.status(200).send('duplicate ignored');
      if (!result.success) return res.status(200).send('not credited: ' + result.reason);

      return res.status(200).send('OK');
    }

    // ══════════════════════════════════════════════════════════════
    // GIGAPUB — placeholder until Rashu confirms exact dashboard macros
    // ══════════════════════════════════════════════════════════════
    if (network === 'gigapub') {
      return res.status(501).send('gigapub postback not configured yet');
    }

    return res.status(400).send('unknown network');
  } catch (err) {
    console.error('postback error:', err);
    return res.status(500).send('server error');
  }
};
