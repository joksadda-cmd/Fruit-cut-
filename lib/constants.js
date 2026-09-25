// lib/constants.js
// Fixed, code-level constants only (enums, currency names, network).
//
// NOTE: Things that change often (withdrawal minimums, fee %, ad rewards)
// live in MongoDB (`settings` collection), NOT here — so the admin bot can
// update them later without touching code. See lib/settings.js.
// This file only holds TRUE constants: enums, currency names, network, etc.

module.exports = {
  // ── Core currency ────────────────────────────────────────────────
  FC_NAME: 'Fruit Coin',
  FC_SHORT: 'FC',

  // ── Withdrawal — single network only ────────────────────────────
  // All payouts go through TonKeeper on the TON network (Rashu's call:
  // one main TON address handles Dogs, Hamster, Notcoin, TON, USDT, Gram).
  WITHDRAW_NETWORK: 'TON',
  SUPPORTED_WITHDRAW_CURRENCIES: ['dogs', 'hmstr', 'notcoin', 'ton', 'usdt', 'gram'],

  // ── Anti-cheat / rate limits (tune later in Phase 1) ────────────
  MAX_AD_WATCHES_PER_HOUR: 12,

  // ── Weekly "Top Slasher" leaderboard competition ─────────────────
  // Top 20 by slash-game wins each week share a 30,000 FC pool. Must have
  // at least this many wins that week to be eligible for any prize at all
  // (a user can still appear on the ranked list below 100 wins — they just
  // don't get paid until they cross the line).
  LEADERBOARD_MIN_WINS_FOR_PRIZE: 100,
  // Fixed FC payout per rank (index 0 = 1st place), 20 entries, sums to
  // exactly 30,000: 1st=7,000, 2nd=5,000, 3rd=3,000 (top 3 = 15,000, per
  // spec), ranks 4-20 (17 users) split the remaining 15,000 as evenly as an
  // integer split allows (882 or 883 each).
  // NOTE: to raise the pool later (spec says rewards should grow as the
  // user base grows), just edit this array — everything else (cron payout,
  // frontend display) reads from it, nothing else needs to change.
  LEADERBOARD_WEEKLY_REWARDS: [
    7000, 5000, 3000,
    883, 883, 883, 883, 883, 883, 882, 882, 882, 882, 882, 882, 882, 882, 882, 882, 882,
  ],

  // ── Weekly "Top Referrer" competition ─────────────────────────────
  // Top 10 by NEW referrals brought in that week (weekly count resets to 0
  // every Monday — separate from the lifetime `referralCount` field) share
  // a 25,000 FC pool. No minimum-referrals gate (unlike the slash
  // leaderboard's 100-win minimum) — every ranked user in the top 10 gets
  // paid. Decreasing payout, 1st place highest: sums to exactly 25,000.
  REFERRAL_WEEKLY_REWARDS: [6000, 4500, 3500, 2800, 2200, 1700, 1400, 1200, 900, 800],

  // ── Transaction types (fixed enum across the whole app) ─────────
  TRANSACTION_TYPES: {
    AD_REWARD: 'ad_reward',
    REFERRAL_REWARD: 'referral_reward',
    GIFT_REWARD: 'gift_reward',
    PROMO_REWARD: 'promo_reward',
    SHOP_PURCHASE: 'shop_purchase',
    SLASH_REWARD: 'slash_reward',
    TASK_REWARD: 'task_reward',
    LEADERBOARD_REWARD: 'leaderboard_reward',
    REFERRAL_LEADERBOARD_REWARD: 'referral_leaderboard_reward',
    WITHDRAWAL: 'withdrawal',
    ADMIN_ADJUSTMENT: 'admin_adjustment',
  },

  WITHDRAWAL_STATUS: {
    PENDING: 'pending',
    APPROVED: 'approved',
    REJECTED: 'rejected',
    WRONG_ADDRESS_REFUNDED: 'wrong_address_refunded',
  },

  // ── Withdraw — fixed keys/enums only. Tunable NUMBERS (min level,
  // min tasks, max FC, penalty %) live in lib/settings.js's
  // DEFAULT_SETTINGS so the admin bot can change them without a redeploy —
  // same convention as withdrawalFeePercent / withdrawMinimums. ─────────
  WITHDRAW_AD_NETWORK: 'withdrawGate', // adSessions network key for the mandatory pre-withdraw ad watch
  WITHDRAW_AD_SESSION_MAX_AGE_MS: 10 * 60 * 1000, // a claimed ad-gate session is valid for 10 min before it must be redone

  // ── Multi-account / one-device-one-account enforcement ────────────
  // A device that racks up this many DISTINCT blocked (second-account)
  // attempts is treated as active multi-accounting — the ORIGINAL account
  // that owns the device gets auto-banned, not just the new attempts.
  DEVICE_MULTI_ACCOUNT_BAN_THRESHOLD: 3,
};
