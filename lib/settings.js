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

  // Gold reward per confirmed ad view. AdsGram has 2 separate blocks
  // (special + daily) with different payouts, matching your existing
  // frontend reward amounts.
  adRewardGold: {
    adsgramSpecial: 250,
    adsgramDaily: 120,
    monetag: 120,
    gigapub: 120,
  },

  updatedAt: new Date(),
};

// Fetches economy settings, seeding defaults on first run if missing.
async function getSettings() {
  const col = await getCollection('settings');
  let settings = await col.findOne({ _id: 'economy' });

  if (!settings) {
    await col.insertOne(DEFAULT_SETTINGS);
    settings = DEFAULT_SETTINGS;
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
