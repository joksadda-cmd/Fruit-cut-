// lib/settings.js
// Dynamic economy settings stored in MongoDB (`settings` collection, single
// document with _id: 'economy'). Admin bot (Phase 6) will update these
// values at runtime — no code redeploy needed when market rates change.

const { getCollection } = require('./db');

const DEFAULT_SETTINGS = {
  _id: 'economy',

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

  // ── Withdraw unlock requirements (2026 update) ───────────────────
  withdrawMinLevel: 3,              // must be Level 3 (Juice Maker) or higher
  withdrawMinLifetimeTasks: 5,      // lifetime completed tasks, not daily
  withdrawMaxFc: 100000,            // hard cap per withdrawal request
  withdrawMinFc: 2500,              // matches existing frontend minimum
  withdrawWrongAddressPenaltyPercent: 10, // deducted from refund when admin marks "wrong address"

  // Referral withdraw commission: when a referred user's withdrawal is
  // approved, their referrer gets this % of the withdrawn FC amount —
  // see lib/referral.js's grantWithdrawCommission (fixed 2026-09-27; this
  // was previously called from api/bot.js on every withdrawal approval
  // but never actually implemented/exported, so every approval threw
  // before the admin's confirm message rendered and no commission was
  // ever paid).
  referralWithdrawCommissionPercent: 15, // UPDATED 2026-10-09 (was 10)

  // Fruit Coin reward per confirmed ad view — UPDATED 2026-10-09
  adRewardFc: {
    adsgram: 40,       // Adsgram Special: 40 FC (was 25)
    adsgramDaily: 20,  // Adsgram Daily: 20 FC (unchanged)
    gigapub: 20,       // GigaPub: 20 FC (was 15)
    monetag: 20,       // Monetag: 20 FC (was 10)
  },
  // Daily cap per source — enforced server-side
  adDailyLimits: {
    adsgram: 10,       // 10 ads/day
    adsgramDaily: 10,  // 10 ads/day
    gigapub: 20,       // 20 ads/day
    monetag: 5,        // 5 ads/day (was 20)
  },

  // Bump this when the numbers above change: getSettings() then applies the new
  // ad rewards / limits / commission ONCE to an already-saved settings doc
  // (otherwise the old values stored in MongoDB would silently win).
  rewardsVersion: 2,

  updatedAt: new Date(),
};

// Adds any NEW keys that exist in `defaults` but not yet in `existing`
// (e.g. a newly-added ad network), without touching values an admin has
// already customized away from the default for keys that already exist.
function mergeMissingKeys(existing, defaults) {
  const merged = { ...(existing || {}) };
  let changed = false;
  for (const key of Object.keys(defaults)) {
    if (!(key in merged)) {
      merged[key] = defaults[key];
      changed = true;
    }
  }
  return { merged, changed };
}

// Fetches economy settings, seeding defaults on first run if missing.
async function getSettings() {
  const col = await getCollection('settings');
  let settings = await col.findOne({ _id: 'economy' });

  if (!settings) {
    await col.insertOne(DEFAULT_SETTINGS);
    return DEFAULT_SETTINGS;
  }

  // One-time rewards migration (2026-10-09): the saved doc still holds the old
  // numbers (25/15/10 FC, Monetag 20/day, 10% commission) — overwrite them once.
  if ((settings.rewardsVersion || 0) < DEFAULT_SETTINGS.rewardsVersion) {
    const patch = {
      adRewardFc: { ...(settings.adRewardFc || {}), ...DEFAULT_SETTINGS.adRewardFc },
      adDailyLimits: { ...(settings.adDailyLimits || {}), ...DEFAULT_SETTINGS.adDailyLimits },
      referralWithdrawCommissionPercent: DEFAULT_SETTINGS.referralWithdrawCommissionPercent,
      rewardsVersion: DEFAULT_SETTINGS.rewardsVersion,
      updatedAt: new Date(),
    };
    await col.updateOne({ _id: 'economy' }, { $set: patch });
    settings = { ...settings, ...patch };
  }

  // Only fill in keys that are genuinely missing (e.g. a new ad network
  // added to DEFAULT_SETTINGS after this doc was first created) — never
  // overwrite a value the admin has already changed via updateSettings().
  const { merged: rewardFc, changed: rewardChanged } = mergeMissingKeys(settings.adRewardFc, DEFAULT_SETTINGS.adRewardFc);
  const { merged: dailyLimits, changed: limitsChanged } = mergeMissingKeys(settings.adDailyLimits, DEFAULT_SETTINGS.adDailyLimits);

  if (rewardChanged || limitsChanged) {
    await col.updateOne(
      { _id: 'economy' },
      {
        $set: {
          adRewardFc: rewardFc,
          adDailyLimits: dailyLimits,
          updatedAt: new Date(),
        },
      }
    );
    settings.adRewardFc = rewardFc;
    settings.adDailyLimits = dailyLimits;
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
