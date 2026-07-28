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

// ── Atomic regen apply (fixes the "retry → 5 tokens appear out of
// nowhere" bug) ──────────────────────────────────────────────────
//
// The old call sites did read → computeRegen() → blind $set. If two
// requests read the SAME stale lastTokenRegenAt before either had
// written back (api/auth.js on app load racing api/init.js's periodic
// sync, or a fast double app-reopen/network retry), both independently
// compute "N ticks elapsed" from that same old timestamp and both then
// write — so a slow retry of the same stale computation landing a few
// seconds after the first write can re-apply a tick jump that was
// already applied, making tokens jump by more than they should.
//
// Fix: compare-and-swap. Only write if lastTokenRegenAt in the DB still
// matches exactly what we read. If another request already moved it
// first, we do NOT recompute/re-apply — we just return the fresh,
// already-correct document.
async function applyRegen(usersCol, user) {
  const regen = computeRegen(user.gameTokens ?? 3, user.lastTokenRegenAt);
  if (!regen.changed) return regen;

  const matchLast = user.lastTokenRegenAt
    ? { lastTokenRegenAt: user.lastTokenRegenAt }
    : { lastTokenRegenAt: { $in: [null, undefined] } };

  const updated = await usersCol.findOneAndUpdate(
    { _id: user._id, ...matchLast },
    { $set: { gameTokens: regen.gameTokens, lastTokenRegenAt: regen.lastTokenRegenAt } },
    { returnDocument: 'after' }
  );

  if (updated) {
    return { ...regen, gameTokens: updated.gameTokens, lastTokenRegenAt: updated.lastTokenRegenAt };
  }

  // Lost the race — someone else already applied regen for this exact
  // window. Re-read instead of recomputing from a now-stale timestamp.
  const fresh = await usersCol.findOne({ _id: user._id });
  if (!fresh) return regen; // shouldn't happen, fall back to original calc
  return {
    gameTokens: fresh.gameTokens ?? 3,
    lastTokenRegenAt: fresh.lastTokenRegenAt,
    changed: false,
    nextTokenAt: computeRegen(fresh.gameTokens ?? 3, fresh.lastTokenRegenAt).nextTokenAt,
  };
}

module.exports = { computeRegen, applyRegen, REGEN_INTERVAL_MS, MAX_TOKENS };
