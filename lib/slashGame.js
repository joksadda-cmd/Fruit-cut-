// lib/slashGame.js
// Fruit Cut Slash Game Logic & Weighted Reward Engine
// Rewards range from 15 FC to 40 FC randomly.
// Cooldown: 1 hour (server-enforced).

const SLASH_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

const REWARD_TIERS = [
  // Tier 1: 15 - 22 FC (50% probability - small rewards common)
  { min: 15, max: 22, weight: 50 },
  // Tier 2: 23 - 30 FC (30% probability)
  { min: 23, max: 30, weight: 30 },
  // Tier 3: 31 - 36 FC (15% probability)
  { min: 31, max: 36, weight: 15 },
  // Tier 4: 37 - 40 FC (5% top prize)
  { min: 37, max: 40, weight: 5 },
];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Returns a random FC reward between 15 and 40 (weighted)
 */
function pickSlashReward() {
  const totalWeight = REWARD_TIERS.reduce((sum, r) => sum + r.weight, 0);
  let roll = Math.random() * totalWeight;

  for (const tier of REWARD_TIERS) {
    roll -= tier.weight;
    if (roll <= 0) {
      return randomInt(tier.min, tier.max);
    }
  }

  return randomInt(15, 25);
}

module.exports = {
  SLASH_COOLDOWN_MS,
  REWARD_TIERS,
  pickSlashReward,
};
