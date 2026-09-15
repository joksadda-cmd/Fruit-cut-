// lib/slashGame.js
// "One Slash" mini-game: player taps a big fruit until it's destroyed,
// then gets a small USD-denominated reward. Cooldown + reward amount are
// both decided here, server-side — the client never sends (and is never
// trusted for) the reward value, only which action it wants to take.
//
// NOTE: the wider currency system is being redesigned (per project owner),
// so this reward is tracked in its own field (user.slashEarningsUsd) in
// plain USD rather than being mixed into Gold/Fruit Coin. That keeps this
// feature decoupled and easy to re-wire once the new currency system lands.

const SLASH_COOLDOWN_MS = 60 * 60 * 1000; // once every 1 hour

// Weighted table — small amounts common, the $0.01 top prize rare.
// Tune freely; weights don't need to sum to 100.
const REWARD_TABLE = [
  { amount: 0.0001, weight: 40 },
  { amount: 0.0002, weight: 25 },
  { amount: 0.0005, weight: 15 },
  { amount: 0.001,  weight: 10 },
  { amount: 0.002,  weight: 6  },
  { amount: 0.005,  weight: 3  },
  { amount: 0.01,   weight: 1  },
];

function pickSlashReward() {
  const totalWeight = REWARD_TABLE.reduce((sum, r) => sum + r.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const row of REWARD_TABLE) {
    roll -= row.weight;
    if (roll <= 0) return row.amount;
  }
  return REWARD_TABLE[0].amount; // fallback, should never hit
}

module.exports = { SLASH_COOLDOWN_MS, REWARD_TABLE, pickSlashReward };
