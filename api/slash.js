// lib/slashGame.js
// "One Slash" mini-game: player taps a big fruit until it's destroyed,
// then must watch a gate ad (see api/slash.js + 'slashGate' in
// lib/adSession.js) before claiming a Fruit Coin reward. Cooldown +
// reward amount are both decided here, server-side — the client never
// sends (and is never trusted for) the reward value, only which action
// it wants to take.
//
// Reward credits Fruit Coin directly (15-60 FC), weighted so low amounts
// are common and 60 is rare.

const SLASH_COOLDOWN_MS = 60 * 60 * 1000; // once every 1 hour

// Weighted table — small amounts common, 60 FC top prize rare.
// Tune freely; weights don't need to sum to 100.
const REWARD_TABLE = [
  { amount: 15, weight: 35 },
  { amount: 20, weight: 25 },
  { amount: 25, weight: 15 },
  { amount: 30, weight: 10 },
  { amount: 40, weight: 7  },
  { amount: 50, weight: 5  },
  { amount: 60, weight: 3  },
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
