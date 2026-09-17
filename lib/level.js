// lib/level.js
// Profile "Level" system.
//
// XP is derived from stats the app ALREADY tracks per user (never
// decreases, so level can never go down): ads watched, Fruit Slash wins,
// and tasks completed. No new field to write/sync — level is just
// computed fresh from existing counters every time it's needed.
//
//   XP = (ads watched × 2) + (slash wins × 5) + (tasks completed × 10)
//
// Tune the weights/thresholds below any time — pure function, no DB
// migration needed since nothing is stored.

const LEVEL_THRESHOLDS = [
  0,     // Level 1
  50,    // Level 2
  120,   // Level 3
  220,   // Level 4
  360,   // Level 5
  550,   // Level 6
  800,   // Level 7
  1150,  // Level 8
  1600,  // Level 9
  2200,  // Level 10
  3000,  // Level 11
  4000,  // Level 12
  5200,  // Level 13
  6600,  // Level 14
  8200,  // Level 15 (max — XP beyond this just fills the last bar)
];

function computeXp(user) {
  const ads = user.totalAdsWatched || 0;
  const wins = user.totalSlashWins || 0;
  const tasks = (user.completedTasks || []).length;
  return ads * 2 + wins * 5 + tasks * 10;
}

function computeLevel(user) {
  const xp = computeXp(user);
  let level = 1;
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
    if (xp >= LEVEL_THRESHOLDS[i]) level = i + 1;
  }
  const isMax = level >= LEVEL_THRESHOLDS.length;
  const currentFloor = LEVEL_THRESHOLDS[level - 1];
  const nextCeiling = isMax ? null : LEVEL_THRESHOLDS[level];
  const xpIntoLevel = xp - currentFloor;
  const xpForNextLevel = isMax ? null : nextCeiling - currentFloor;

  return { level, xp, isMax, xpIntoLevel, xpForNextLevel };
}

module.exports = { computeXp, computeLevel, LEVEL_THRESHOLDS };
