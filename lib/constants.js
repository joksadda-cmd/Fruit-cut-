// lib/constants.js
// Fixed, code-level constants only (enums, currency names, network).
//
// NOTE: Things that change often (withdrawal minimums, fee %, FC->USDT rate)
// live in MongoDB (`settings` collection), NOT here — so the admin bot can
// update them later without touching code. See lib/settings.js.
// This file only holds TRUE constants: enums, currency names, network, etc.
//
// GOLD REMOVED (2026-09): the app used to have a soft "Gold" currency that
// converted into Fruit Coin at a fixed rate. Gold has been fully removed —
// every reward (ads, tasks, free box, shop, slash game, leaderboard,
// referrals) now credits Fruit Coin (FC) directly. FC is the only in-app
// currency and is what withdraws out to USDT.

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

  // ── Transaction types (fixed enum across the whole app) ─────────
  TRANSACTION_TYPES: {
    AD_REWARD: 'ad_reward',
    REFERRAL_REWARD: 'referral_reward',
    WEEKLY_REFERRAL_REWARD: 'weekly_referral_reward',
    GIFT_REWARD: 'gift_reward',
    PROMO_REWARD: 'promo_reward',
    SHOP_PURCHASE: 'shop_purchase',
    FREEBOX_REWARD: 'freebox_reward',
    SLASH_REWARD: 'slash_reward',
    TASK_REWARD: 'task_reward',
    LEADERBOARD_REWARD: 'leaderboard_reward',
    WITHDRAWAL: 'withdrawal',
    ADMIN_ADJUSTMENT: 'admin_adjustment',
  },

  WITHDRAWAL_STATUS: {
    PENDING: 'pending',
    APPROVED: 'approved',
    REJECTED: 'rejected',
  },

  // ── Weekly leaderboard ("Top Slasher") ───────────────────────────
  // Ranked by number of Slash-the-Fruit rounds won this week. Resets
  // every Monday 00:00 UTC (see lib/leaderboard.js getWeekKey()).
  LEADERBOARD_TOP_N: 10,
  // Rank-weighted split of the weekly prize pool (must sum to 100).
  // Rank 1 gets 25%, rank 2 gets 18%, ... rank 10 gets 2%.
  LEADERBOARD_RANK_WEIGHTS: [25, 18, 14, 11, 9, 7, 6, 5, 3, 2],
};
