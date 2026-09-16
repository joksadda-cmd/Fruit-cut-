// lib/settings.js
// Dynamic economy settings stored in MongoDB (`settings` collection, single
// document with _id: 'economy'). Admin bot (Phase 6) will update these
// values at runtime — no code redeploy needed when market rates change.
//
// GOLD REMOVED (2026-09): there is no more Gold currency and no more
// Gold->FC conversion step. Fruit Coin (FC) is the only in-app currency —
// every reward source below credits FC directly. FC's only conversion is
// straight to USDT at withdrawal time, via `fcToUsdt` below.

const { getCollection } = require('./db');

const DEFAULT_SETTINGS = {
  _id: 'economy',

  // Fruit Coin -> USDT rate for withdrawals.
  // 25,000 FC = 1 USDT
  fcToUsdt: {
    fcAmount: 25000,
    usdtAmount: 1,
  },

  // Withdrawal fee (percentage cut from the user's requested withdraw amount)
  withdrawalFeePercent: 15,

  // Minimum withdrawal amount, in the DESTINATION currency's own unit.
  // Admin manually verifies live market rate at approval time since all
  // withdrawals are manual-approved anyway.
  withdrawMinimums: {
    dogs:    { amount: 1000, unit: 'DOGS' },
    hmstr:   { amount: 500,  unit: 'HMSTR' },
    notcoin: { amount: 200,  unit: 'NOT' },
    ton:     { amount: 0.05, unit: 'TON' },
    usdt:    { amount: 0.05, unit: 'USDT' },
    gram:    { amount: 0.05, unit: 'TON-equivalent' },
  },

  // All withdrawals go out via TonKeeper on TON network — single address
  network: 'TON',

  // Fruit Coin reward per confirmed ad view (paid directly now — no more
  // Gold middle step). Keys match the action names already used in your
  // frontend (window.watchAdsgramAd -> 'adsgram', etc.)
  // NOTE: these are the SAME numbers the old Gold rewards used — only the
  // currency they land in changed. Re-tune via the admin bot if the new
  // 25,000 FC = 1 USDT rate makes them too generous/stingy.
  adRewardFc: {
    adsgram: 500,
    adsgramDaily: 200,
    monetag: 300,
    gigapub: 300,
  },

  // Daily cap per source — enforced server-side.
  adDailyLimits: {
    adsgram: 5,
    adsgramDaily: 5,
    monetag: 10,
    gigapub: 10,
  },

  // ── Weekly "Top Slasher" leaderboard ─────────────────────────────
  // Ranked by number of Slash-the-Fruit wins in the current week.
  // Total prize pool is split across the top 10 by rank (see
  // LEADERBOARD_RANK_WEIGHTS in lib/constants.js).
  leaderboard: {
    topN: 10,
    weeklyPrizePoolFc: 10000,
  },

  // ── Weekly referral reward ───────────────────────────────────────
  // A referrer only qualifies for that week's referral reward if they've
  // personally played (won) at least this many Slash-the-Fruit rounds
  // during the week. Reward is paid per valid referral they have.
  // NOTE: bonusFcPerReferral has no explicit spec from Rashu yet — this is
  // a placeholder default, tune it via the admin bot.
  weeklyReferral: {
    minSlashWinsRequired: 150,
    bonusFcPerReferral: 100,
  },

  updatedAt: new Date(),
};

// Fetches economy settings, seeding defaults on first run if missing.
async function getSettings() {
  const col = await getCollection('settings');
  let settings = await col.findOne({ _id: 'economy' });

  if (!settings) {
    await col.insertOne(DEFAULT_SETTINGS);
    return DEFAULT_SETTINGS;
  }

  // adRewardFc / adDailyLimits / leaderboard / weeklyReferral have no
  // admin-bot editor yet, so they're effectively code-controlled — always
  // sync them to DEFAULT_SETTINGS above so changing a number here and
  // redeploying takes effect right away, without needing direct database
  // access to update the old already-seeded document.
  const needsSync =
    JSON.stringify(settings.adRewardFc) !== JSON.stringify(DEFAULT_SETTINGS.adRewardFc) ||
    JSON.stringify(settings.adDailyLimits) !== JSON.stringify(DEFAULT_SETTINGS.adDailyLimits) ||
    JSON.stringify(settings.leaderboard) !== JSON.stringify(DEFAULT_SETTINGS.leaderboard) ||
    JSON.stringify(settings.weeklyReferral) !== JSON.stringify(DEFAULT_SETTINGS.weeklyReferral) ||
    JSON.stringify(settings.fcToUsdt) !== JSON.stringify(DEFAULT_SETTINGS.fcToUsdt) ||
    settings.withdrawalFeePercent !== DEFAULT_SETTINGS.withdrawalFeePercent ||
    settings.goldToFc !== undefined; // old field left over from the Gold system

  if (needsSync) {
    await col.updateOne(
      { _id: 'economy' },
      {
        $set: {
          adRewardFc: DEFAULT_SETTINGS.adRewardFc,
          adDailyLimits: DEFAULT_SETTINGS.adDailyLimits,
          leaderboard: DEFAULT_SETTINGS.leaderboard,
          weeklyReferral: DEFAULT_SETTINGS.weeklyReferral,
          fcToUsdt: DEFAULT_SETTINGS.fcToUsdt,
          withdrawalFeePercent: DEFAULT_SETTINGS.withdrawalFeePercent,
          updatedAt: new Date(),
        },
        $unset: { goldToFc: '', adRewardGold: '' },
      }
    );
    settings = {
      ...settings,
      adRewardFc: DEFAULT_SETTINGS.adRewardFc,
      adDailyLimits: DEFAULT_SETTINGS.adDailyLimits,
      leaderboard: DEFAULT_SETTINGS.leaderboard,
      weeklyReferral: DEFAULT_SETTINGS.weeklyReferral,
      fcToUsdt: DEFAULT_SETTINGS.fcToUsdt,
      withdrawalFeePercent: DEFAULT_SETTINGS.withdrawalFeePercent,
    };
    delete settings.goldToFc;
    delete settings.adRewardGold;
  }

  return settings;
}

// Used later by the admin bot to update individual fields, e.g.
// updateSettings({ 'withdrawMinimums.dogs.amount': 1200 })
async function updateSettings(partialUpdate) {
  const col = await getCollection('settings');
  await col.updateOne(
    { _id: 'economy' },
    { $set: { ...partialUpdate, updatedAt: new Date() } },
    { upsert: true }
  );
  return getSettings();
}

module.exports = { getSettings, updateSettings, DEFAULT_SETTINGS };
