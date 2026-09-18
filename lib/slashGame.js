// lib/slashGame.js
// Fruit Cut Slash Game Logic & Weighted Reward Engine
// Rewards range from 10 FC to 200 FC, weighted so smaller rewards are common.

const REWARD_TIERS = [
  // Tier 1: 10 - 20 FC (50% probability)
  { min: 10, max: 20, weight: 50 },
  // Tier 2: 21 - 50 FC (30% probability)
  { min: 21, max: 50, weight: 30 },
  // Tier 3: 51 - 100 FC (14% probability)
  { min: 51, max: 100, weight: 14 },
  // Tier 4: 101 - 150 FC (5% probability)
  { min: 101, max: 150, weight: 5 },
  // Tier 5: 151 - 200 FC (1% jackpot probability)
  { min: 151, max: 200, weight: 1 },
];

/**
 * Generates a random integer between min and max (inclusive)
 */
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Selects a random FC reward according to weighted distribution
 * Returns an integer between 10 and 200
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

  return randomInt(10, 20); // safe fallback
}

module.exports = {
  REWARD_TIERS,
  pickSlashReward,
};
