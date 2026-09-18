// lib/levelSystem.js
// 15-level progression system for Fruit Cut
// Each level requires a certain total number of fruit slices and awards milestone FC coins.

const LEVELS = [
  { level: 1,  name: 'Novice Slicer',       requiredSlices: 0,    rewardFc: 0,    fruit: '🍎' },
  { level: 2,  name: 'Fruit Peeler',        requiredSlices: 10,   rewardFc: 25,   fruit: '🍊' },
  { level: 3,  name: 'Juice Maker',         requiredSlices: 25,   rewardFc: 50,   fruit: '🍋' },
  { level: 4,  name: 'Kitchen Apprentice',  requiredSlices: 50,   rewardFc: 75,   fruit: '🍇' },
  { level: 5,  name: 'Fruit Carver',        requiredSlices: 80,   rewardFc: 100,  fruit: '🍓' },
  { level: 6,  name: 'Fast Blade',          requiredSlices: 120,  rewardFc: 150,  fruit: '🍑' },
  { level: 7,  name: 'Samurai Novice',      requiredSlices: 170,  rewardFc: 200,  fruit: '🍒' },
  { level: 8,  name: 'Combo Striker',       requiredSlices: 230,  rewardFc: 250,  fruit: '🥝' },
  { level: 9,  name: 'Ninja Warrior',       requiredSlices: 300,  rewardFc: 300,  fruit: '🍍' },
  { level: 10, name: 'Master Slicer',       requiredSlices: 400,  rewardFc: 400,  fruit: '🥥' },
  { level: 11, name: 'Dojo Master',         requiredSlices: 550,  rewardFc: 500,  fruit: '🍉' },
  { level: 12, name: 'Shadow Blade',        requiredSlices: 750,  rewardFc: 650,  fruit: '🥭' },
  { level: 13, name: 'Fruit Titan',         requiredSlices: 1000, rewardFc: 800,  fruit: '🍈' },
  { level: 14, name: 'Legend Slicer',       requiredSlices: 1300, rewardFc: 1000, fruit: '⭐' },
  { level: 15, name: 'Grandmaster God',     requiredSlices: 1700, rewardFc: 2000, fruit: '👑' },
];

const MAX_LEVEL = 15;

/**
 * Calculates current level based on total slices
 */
function getLevelForSlices(totalSlices = 0) {
  let currentLevel = 1;
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (totalSlices >= LEVELS[i].requiredSlices) {
      currentLevel = LEVELS[i].level;
      break;
    }
  }
  return Math.min(currentLevel, MAX_LEVEL);
}

/**
 * Returns level details including progress toward next level
 */
function getLevelProgress(totalSlices = 0) {
  const currentLevel = getLevelForSlices(totalSlices);
  const currentConfig = LEVELS.find((l) => l.level === currentLevel) || LEVELS[0];
  const nextConfig = LEVELS.find((l) => l.level === currentLevel + 1) || null;

  let progressPercent = 100;
  let slicesToNext = 0;

  if (nextConfig) {
    const currentBase = currentConfig.requiredSlices;
    const nextTarget = nextConfig.requiredSlices;
    const slicesInCurrentTier = Math.max(0, totalSlices - currentBase);
    const tierSpan = nextTarget - currentBase;
    progressPercent = Math.min(100, Math.max(0, Math.round((slicesInCurrentTier / tierSpan) * 100)));
    slicesToNext = Math.max(0, nextTarget - totalSlices);
  }

  return {
    level: currentLevel,
    name: currentConfig.name,
    fruit: currentConfig.fruit,
    totalSlices,
    nextLevel: nextConfig ? nextConfig.level : null,
    nextLevelName: nextConfig ? nextConfig.name : 'Max Level',
    requiredForNext: nextConfig ? nextConfig.requiredSlices : currentConfig.requiredSlices,
    slicesToNext,
    progressPercent,
    isMaxLevel: currentLevel >= MAX_LEVEL,
  };
}

module.exports = {
  LEVELS,
  MAX_LEVEL,
  getLevelForSlices,
  getLevelProgress,
};
