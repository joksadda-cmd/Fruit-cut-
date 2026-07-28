// lib/tokens.js
// Game Token regeneration: +1 every 4 hours, up to 10 max.
// The ONLY way tokens can exceed 10 is a referral bonus (handled in
// api/auth.js directly) — regen here never pushes tokens above 10, and
// never reduces an above-10 balance either; it just "banks" elapsed time
// via lastTokenRegenAt so nothing is lost once the balance drops back
// under 10 from actually playing games.

const REGEN_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_TOKENS = 10;

function computeRegen(gameTokens, lastTokenRegenAt) {
  const now = Date.now();
  const last = lastTokenRegenAt ? new Date(lastTokenRegenAt).getTime() : now;
  const elapsed = now - last;

  if (elapsed < REGEN_INTERVAL_MS) {
    return {
      gameTokens,
      lastTokenRegenAt: lastTokenRegenAt || new Date(now),
      changed: !lastTokenRegenAt,
      nextTokenAt: new Date(last + REGEN_INTERVAL_MS),
    };
  }

  const ticks = Math.floor(elapsed / REGEN_INTERVAL_MS);
  const newLast = new Date(last + ticks * REGEN_INTERVAL_MS);
  const newTokens = gameTokens < MAX_TOKENS ? Math.min(MAX_TOKENS, gameTokens + ticks) : gameTokens;

  return {
    gameTokens: newTokens,
    lastTokenRegenAt: newLast,
    changed: true,
    nextTokenAt: new Date(newLast.getTime() + REGEN_INTERVAL_MS),
  };
}

module.exports = { computeRegen, REGEN_INTERVAL_MS, MAX_TOKENS };
