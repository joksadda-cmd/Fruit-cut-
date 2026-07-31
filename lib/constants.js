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
  MAX_GAMES_PER_HOUR: 30,

  // ── Referral (Phase 4 will use these) ───────────────────────────
  REFERRAL_MIN_GAMES_BEFORE_REWARD: 3, // referred user must play 3 games first

  // ── Transaction types (fixed enum across the whole app) ─────────
  TRANSACTION_TYPES: {
    GOLD_EARNED: 'gold_earned',
    GOLD_TO_FC_CONVERT: 'gold_to_fc_convert',
    AD_REWARD: 'ad_reward',
    GAME_REWARD: 'game_reward',
    REFERRAL_REWARD: 'referral_reward',
    LOTTERY_REWARD: 'lottery_reward',
    GIFT_REWARD: 'gift_reward',
    PROMO_REWARD: 'promo_reward',
    SHOP_PURCHASE: 'shop_purchase',
    FREEBOX_REWARD: 'freebox_reward',
    WITHDRAWAL: 'withdrawal',
    ADMIN_ADJUSTMENT: 'admin_adjustment',
    SHOP_PURCHASE: 'shop_purchase',
  },

  WITHDRAWAL_STATUS: {
    PENDING: 'pending',
    APPROVED: 'approved',
    REJECTED: 'rejected',
  },
};
