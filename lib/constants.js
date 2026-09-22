// lib/constants.js
// Fixed, code-level constants only (enums, currency names, network).
//
// NOTE: Things that change often (withdrawal minimums, fee %, gold->FC rate)
// live in MongoDB (`settings` collection), NOT here — so the admin bot can
// update them later without touching code. See lib/settings.js.
// This file only holds TRUE constants: enums, currency names, network, etc.

module.exports = {
  // ── Core currencies ─────────────────────────────────────────────
  GOLD_NAME: 'Gold',
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
  // at least this many wins that week to be eligible for any prize at all.
  LEADERBOARD_MIN_WINS_FOR_PRIZE: 100,
  // Fixed FC payout per rank (index 0 = 1st place), 20 entries, sums to
  // 30,000: 1st=10,000, 2nd=5,000, 3rd=3,000, ranks 4-20 (17 users) split
  // the remaining 12,000 as evenly as an integer split allows.
  LEADERBOARD_WEEKLY_REWARDS: [
    10000, 5000, 3000,
    706, 706, 706, 706, 706, 706, 706, 706, 706, 706, 706, 706, 706, 706, 706, 705, 705,
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
    GOLD_EARNED: 'gold_earned',
    GOLD_TO_FC_CONVERT: 'gold_to_fc_convert',
    AD_REWARD: 'ad_reward',
    REFERRAL_REWARD: 'referral_reward',
    GIFT_REWARD: 'gift_reward',
    PROMO_REWARD: 'promo_reward',
    SHOP_PURCHASE: 'shop_purchase',
    FREEBOX_REWARD: 'freebox_reward',
    SLASH_REWARD: 'slash_reward',
    LEADERBOARD_REWARD: 'leaderboard_reward',
    REFERRAL_LEADERBOARD_REWARD: 'referral_leaderboard_reward',
    WITHDRAWAL: 'withdrawal',
    ADMIN_ADJUSTMENT: 'admin_adjustment',
  },

  WITHDRAWAL_STATUS: {
    PENDING: 'pending',
    APPROVED: 'approved',
    REJECTED: 'rejected',
  },
};
