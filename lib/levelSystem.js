// lib/levelSystem.js
// 15-Level Progression System based on XP (Experience Points)
// XP gains:
//   - Watch an ad: +2 XP
//   - Play slash game: +5 XP
//   - Complete a task: +10 XP
//   - Claim daily gift: +5 XP
//
// Level Thresholds (15 levels):
//   Level 1:  0 XP     (Novice Slicer 🍎)
//   Level 2:  100 XP   (Fruit Peeler 🍊)       -> Milestone Bonus: +25 FC
//   Level 3:  250 XP   (Juice Maker 🍋)        -> Milestone Bonus: +50 FC (Triggers Refer Step 4!)
//   Level 4:  500 XP   (Kitchen Apprentice 🍇) -> Milestone Bonus: +75 FC
//   Level 5:  850 XP   (Fruit Carver 🍓)       -> Milestone Bonus: +100 FC
//   Level 6:  1,300 XP (Fast Blade 🍑)         -> Milestone Bonus: +150 FC
//   Level 7:  1,900 XP (Samurai Novice 🍒)     -> Milestone Bonus: +200 FC
//   Level 8:  2,700 XP (Combo Striker 🥝)      -> Milestone Bonus: +250 FC
//   Level 9:  3,700 XP (Ninja Warrior 🍍)      -> Milestone Bonus: +300 FC
//   Level 10: 5,000 XP (Master Slicer 🥥)      -> Milestone Bonus: +400 FC
//   Level 11: 6,800 XP (Dojo Master 🍉)        -> Milestone Bonus: +500 FC
//   Level 12: 9,000 XP (Blade Grandmaster 🍈)  -> Milestone Bonus: +600 FC
//   Level 13: 12,000 XP (Fruit Legend 🍌)      -> Milestone Bonus: +750 FC
//   Level 14: 16,000 XP (Supreme Sensei 🍏)    -> Milestone Bonus: +1,000 FC
//   Level 15: 22,000 XP (Fruit God 🌟)         -> Milestone Bonus: +1,500 FC

const LEVELS = [
  { level: 1,  name: 'Novice Slicer',       requiredXp: 0,     rewardFc: 0,    fruit: '🍎' },
  { level: 2,  name: 'Fruit Peeler',        requiredXp: 100,   rewardFc: 25,   fruit: '🍊' },
  { level: 3,  name: 'Juice Maker',         requiredXp: 250,   rewardFc: 50,   fruit: '🍋' },
  { level: 4,  name: 'Kitchen Apprentice',  requiredXp: 500,   rewardFc: 75,   fruit: '🍇' },
  { level: 5,  name: 'Fruit Carver',        requiredXp: 850,   rewardFc: 100,  fruit: '🍓' },
  { level: 6,  name: 'Fast Blade',          requiredXp: 1300,  rewardFc: 150,  fruit: '🍑' },
  { level: 7,  name: 'Samurai Novice',      requiredXp: 1900,  rewardFc: 200,  fruit: '🍒' },
  { level: 8,  name: 'Combo Striker',       requiredXp: 2700,  rewardFc: 250,  fruit: '🥝' },
  { level: 9,  name: 'Ninja Warrior',       requiredXp: 3700,  rewardFc: 300,  fruit: '🍍' },
  { level: 10, name: 'Master Slicer',       requiredXp: 5000,  rewardFc: 400,  fruit: '🥥' },
  { level: 11, name: 'Dojo Master',         requiredXp: 6800,  rewardFc: 500,  fruit: '🍉' },
  { level: 12, name: 'Blade Grandmaster',   requiredXp: 9000,  rewardFc: 650,  fruit: '🍈' },
  { level: 13, name: 'Fruit Legend',        requiredXp: 12000, rewardFc: 800,  fruit: '🍌' },
  { level: 14, name: 'Supreme Sensei',      requiredXp: 16000, rewardFc: 1000, fruit: '🍏' },
  { level: 15, name: 'Fruit God',           requiredXp: 22000, rewardFc: 1500, fruit: '🌟' },
];

const MAX_LEVEL = 15;

function getLevelForXp(totalXp = 0) {
  let currentLevel = 1;
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (totalXp >= LEVELS[i].requiredXp) {
      currentLevel = LEVELS[i].level;
      break;
    }
  }
  return Math.min(currentLevel, MAX_LEVEL);
}

function getLevelProgress(totalXp = 0) {
  const currentLevel = getLevelForXp(totalXp);
  const currentConfig = LEVELS.find((l) => l.level === currentLevel) || LEVELS[0];
  const nextConfig = LEVELS.find((l) => l.level === currentLevel + 1) || null;

  let progressPercent = 100;
  let xpToNext = 0;

  if (nextConfig) {
    const currentBase = currentConfig.requiredXp;
    const nextTarget = nextConfig.requiredXp;
    const xpInCurrentTier = Math.max(0, totalXp - currentBase);
    const tierSpan = nextTarget - currentBase;
    progressPercent = Math.min(100, Math.max(0, Math.round((xpInCurrentTier / tierSpan) * 100)));
    xpToNext = Math.max(0, nextTarget - totalXp);
  }

  return {
    level: currentLevel,
    name: currentConfig.name,
    fruit: currentConfig.fruit,
    totalXp,
    nextLevel: nextConfig ? nextConfig.level : null,
    nextLevelName: nextConfig ? nextConfig.name : 'Max Level',
    requiredForNext: nextConfig ? nextConfig.requiredXp : currentConfig.requiredXp,
    xpToNext,
    progressPercent,
    isMaxLevel: currentLevel >= MAX_LEVEL,
  };
}

module.exports = {
  LEVELS,
  MAX_LEVEL,
  getLevelForXp,
  getLevelProgress,
};
