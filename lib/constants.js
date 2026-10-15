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
  // (a user can still appear on the ranked list below 50 wins — they just
  // don't get paid until they cross the line).
  LEADERBOARD_MIN_WINS_FOR_PRIZE: 50,
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
  // Top 20 by NEW referrals brought in that week (weekly count resets to 0
  // every Monday — separate from the lifetime `referralCount` field) share
  // a 100,000 FC pool (about $2 at 50,000 FC = $1). Payouts: 1st 20,000 · 2nd 12,000 · 3rd 8,000 ·
  // 4th 7,000 · 5th 6,000 · 6th 5,000 · 7th-8th 4,500 · 9th-10th 4,000 · 11th-15th 3,000 · 16th-20th 2,000.
  REFERRAL_WEEKLY_REWARDS: [
    20000, 12000, 8000, 7000, 6000, 5000, 4500, 4500, 4000, 4000, // 1st-10th
    3000, 3000, 3000, 3000, 3000,                                  // 11th-15th
    2000, 2000, 2000, 2000, 2000,                                  // 16th-20th
  ],
  // NOTE (bug fix, found while making the change above): this constant was
  // referenced by lib/referralLeaderboard.js (payout gate) and
  // api/game_claim.js (UI "eligible" flag + the "need N+ referrals" text)
  // but was never actually defined here — it evaluated to `undefined`
  // everywhere it was used. Net effect: the payout gate never blocked
  // anyone (referrals < undefined is always false), while the UI showed
  // every referrer as "not eligible" (referrals >= undefined is always
  // false) — the two were silently contradicting each other. Defining it
  // now, at the value both files' own comments already claimed (20).
  // Flag this to Rasedul if 20 isn't actually the intended minimum.
  REFERRAL_MIN_FOR_PRIZE: 15, // changed 20 -> 15 (2026-10-14)

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

  // ── "Sponsor & Post Task" (users buy a task with TON) — see lib/sponsor.js ──
  // Prices/packages are code-level on purpose: they are real money, so a change should be a deploy.
  // ── Withdraw level rules (changed 2026-10-15) ─────────────────────
  // Level 1: no withdrawals. Level 2: at most 2 withdrawals in total, each up to 5,000 FC.
  // Level 3 and above: unlimited withdrawals (normal per-request maximum from settings).
  WITHDRAW_RULES: {
    MIN_LEVEL: 2,
    FULL_LEVEL: 3,
    LEVEL2_MAX_REQUESTS: 2,
    LEVEL2_MAX_FC: 5000,
  },

  // Adsgram interstitial ("init") ads — short, no reward. Block id comes from env ADSGRAM_INTERSTITIAL_BLOCK_ID.
  INTERSTITIAL_ADS: {
    MIN_LEVEL: 2,            // only users at this level or above see them
    GAME_EVERY_MS: 300000,   // once per 5 minutes of in-app game play
    RESUME_AFTER_MS: 60000,  // app brought back after being away this long (counts as a new open)
  },

  SPONSOR_TASK: {
    CATEGORY: 'daily',           // tab of the Tasks window where paid tasks appear
    REWARD_FC: 10,                  // fixed Fruit Coin each user gets for a sponsored task
    PACKAGES: [
      { users: 100,  ton: 0.15 },
      { users: 200,  ton: 0.30 },
      { users: 500,  ton: 0.75 },
      { users: 1000, ton: 1.50 },
      { users: 1500, ton: 2.25 },
      { users: 2000, ton: 3.00 },
    ],
    ORDER_TTL_MS: 3 * 60 * 60 * 1000, // an unpaid order shows as "expired" after 3h (a late payment still activates it)
    MAX_OPEN_ORDERS: 3,               // unpaid orders one user can have at the same time
  },

  // ── Multi-account / one-device-one-account enforcement ────────────
  // A device that racks up this many DISTINCT blocked (second-account)
  // attempts is treated as active multi-accounting — the ORIGINAL account
  // that owns the device gets auto-banned, not just the new attempts.
  DEVICE_MULTI_ACCOUNT_BAN_THRESHOLD: 3,
};
