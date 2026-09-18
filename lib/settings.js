// lib/settings.js
// Dynamic economy settings stored in MongoDB (`settings` collection, single
// document with _id: 'economy'). Admin bot (Phase 6) will update these
// values at runtime — no code redeploy needed when market rates change.

const { getCollection } = require('./db');

const DEFAULT_SETTINGS = {
  _id: 'economy',

  // Gold -> Fruit Coin conversion rate
  // 100,000 Gold = 10,000 FC  →  10 Gold = 1 FC
  goldToFc: {
    goldAmount: 100000,
    fcAmount: 10000,
  },

  // Withdrawal fee (percentage cut from whatever the user requests to withdraw)
  withdrawalFeePercent: 10,

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

  // Fruit Coin reward per confirmed ad view (user spec: 25, 20, 15, 10 FC)
  adRewardFc: {
    adsgram: 25,       // Adsgram Special: 25 FC
    adsgramDaily: 20,  // Adsgram Daily: 20 FC
    gigapub: 15,       // GigaPub: 15 FC
    monetag: 10,       // Monetag: 10 FC
  },
  // Backward compatibility alias
  adRewardGold: {
    adsgram: 25,
    adsgramDaily: 20,
    gigapub: 15,
    monetag: 10,
  },

  // Daily cap per source — enforced server-side (user spec: 10, 10, 20, 20)
  adDailyLimits: {
    adsgram: 10,       // 10 ads/day
    adsgramDaily: 10,  // 10 ads/day
    gigapub: 20,       // 20 ads/day
    monetag: 20,       // 20 ads/day
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

  // adRewardFc / adDailyLimits sync to DEFAULT_SETTINGS
  const needsSync =
    JSON.stringify(settings.adRewardFc) !== JSON.stringify(DEFAULT_SETTINGS.adRewardFc) ||
    JSON.stringify(settings.adRewardGold) !== JSON.stringify(DEFAULT_SETTINGS.adRewardGold) ||
    JSON.stringify(settings.adDailyLimits) !== JSON.stringify(DEFAULT_SETTINGS.adDailyLimits);

  if (needsSync) {
    await col.updateOne(
      { _id: 'economy' },
      {
        $set: {
          adRewardFc: DEFAULT_SETTINGS.adRewardFc,
          adRewardGold: DEFAULT_SETTINGS.adRewardGold,
          adDailyLimits: DEFAULT_SETTINGS.adDailyLimits,
          updatedAt: new Date(),
        },
      }
    );
    settings.adRewardFc = DEFAULT_SETTINGS.adRewardFc;
    settings.adRewardGold = DEFAULT_SETTINGS.adRewardGold;
    settings.adDailyLimits = DEFAULT_SETTINGS.adDailyLimits;
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
