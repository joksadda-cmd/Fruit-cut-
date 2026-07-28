// lib/settings.js
// Dynamic economy settings stored in MongoDB (`settings` collection, single
// document with _id: 'economy'). Admin bot (Phase 6) will update these
// values at runtime — no code redeploy needed when market rates change.

const { getCollection } = require('./db');

const DEFAULT_SETTINGS = {
  _id: 'economy',

  // Gold -> Fruit Coin conversion rate
  // 1,000,000 Gold = 50,000 FC  →  20 Gold = 1 FC
  goldToFc: {
    goldAmount: 1000000,
    fcAmount: 50000,
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

  // Gold reward per confirmed ad view. Keys match the action names already
  // used in your frontend (window.watchAdsgramAd -> 'adsgram', etc.)
  adRewardGold: {
    adsgram: 300,
    adsgramDaily: 200,
    monetag: 200,
    gigapub: 200,
  },

  // Daily cap per source — enforced server-side.
  adDailyLimits: {
    adsgram: 5,
    adsgramDaily: 5,
    monetag: 10,
    gigapub: 10,
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

  // adRewardGold / adDailyLimits have no admin-bot editor yet, so they're
  // effectively code-controlled — always sync them to DEFAULT_SETTINGS
  // above so changing a number here and redeploying takes effect right
  // away, without needing direct database access to update the old
  // already-seeded document.
  const needsSync =
    JSON.stringify(settings.adRewardGold) !== JSON.stringify(DEFAULT_SETTINGS.adRewardGold) ||
    JSON.stringify(settings.adDailyLimits) !== JSON.stringify(DEFAULT_SETTINGS.adDailyLimits);

  if (needsSync) {
    await col.updateOne(
      { _id: 'economy' },
      {
        $set: {
          adRewardGold: DEFAULT_SETTINGS.adRewardGold,
          adDailyLimits: DEFAULT_SETTINGS.adDailyLimits,
          updatedAt: new Date(),
        },
      }
    );
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
