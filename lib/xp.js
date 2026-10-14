// lib/xp.js
// XP for ads / in-game rewards (everything that goes through lib/adReward.js and the GigaPub postback).
//
//   Ads section : Adsgram (block + daily) = 2 XP, GigaPub = 2 XP, Monetag = 0 XP
//   Adsgram Task card (Tasks > Daily)     = 2 XP (same as any other task)
//   In-game reward (every 3 min of play)  = 1 XP
//   Withdraw-unlock ad                    = 0 XP
//
// Other XP sources (slash, treasure box, normal tasks, referrals) live in their own files.
// To change a number, change it here only.

const { getLevelForXp, LEVELS } = require('./levelSystem');

const AD_XP = {
  adsgram: 2,
  adsgramDaily: 2,
  gigapub: 2,
  monetag: 0,
  adsgramTask: 2,
  gameAd: 1,
  withdrawGate: 0,
};

// Works out what a user gains for `source`, including a level-up bonus.
// Returns { xpGain, newLevel, isLevelUp, levelReward }.
function planXp(user, source) {
  const xpGain = AD_XP[source] || 0;
  if (!xpGain) return { xpGain: 0, newLevel: null, isLevelUp: false, levelReward: 0 };
  const oldXp = (user && user.xp) || 0;
  const oldLevel = getLevelForXp(oldXp);
  const newLevel = getLevelForXp(oldXp + xpGain);
  let levelReward = 0;
  const isLevelUp = newLevel > oldLevel;
  if (isLevelUp) {
    const cfg = LEVELS.find((l) => l.level === newLevel);
    levelReward = (cfg && cfg.rewardFc) || 0;
  }
  return { xpGain, newLevel, isLevelUp, levelReward };
}

module.exports = { AD_XP, planXp };
