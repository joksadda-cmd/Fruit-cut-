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
  // Top 15 by NEW referrals brought in that week (weekly count resets to 0
  // every Monday — separate from the lifetime `referralCount` field) share
  // a 50,000 FC pool. Decreasing payout, 1st place highest: 15 entries sum
  // to exactly 50,000 — 1st=12,000, 2nd=9,000, 3rd=7,000 (top 3 = 28,000),
  // ranks 4-15 (12 users) split the remaining 22,000 as evenly as an
  // integer split allows (1,833 or 1,834 each), so the last-place winners
  // still get noticeably less than 1st-3rd, same distribution style as the
  // slash leaderboard above.
  REFERRAL_WEEKLY_REWARDS: [
    12000, 9000, 7000,
    1834, 1834, 1834, 1834, 1833, 1833, 1833, 1833, 1833, 1833, 1833, 1833,
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
  REFERRAL_MIN_FOR_PRIZE: 20,

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
