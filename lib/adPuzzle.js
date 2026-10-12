// lib/adPuzzle.js
// Captcha shown after an Adsgram ad (Ads section + in-game Adsgram claim).
// The reward is paid ONLY after the user types the 4-digit code from a server-drawn picture.
//
//   createChallenge({ telegramId, sessionId, source, amount })
//     -> { puzzleToken, image }                      (image = data:image/png;base64,...)
//   verifyChallenge(telegramId, puzzleToken, answer)
//     -> { ok: true, challenge: { source, amount, sessionId } }
//     -> { ok: false, error, final?, image?, triesLeft? }
//
// error codes (match AD_ERROR_MESSAGES in index.html):
//   puzzle_wrong (not final, new image + triesLeft) · too_fast (not final)
//   puzzle_failed (3 wrong, final) · puzzle_expired · puzzle_not_found · puzzle_used

const crypto = require('crypto');
const { getCollection } = require('./db');
const { renderCodePng } = require('./onboarding');

const MAX_TRIES = 3;
const TTL_MS = 5 * 60 * 1000;     // captcha valid for 5 minutes
const MIN_VIEW_MS = 1200;         // answers faster than this are a script, not a human

let indexesEnsured = false;
async function ensureIndexes(col) {
  if (indexesEnsured) return;
  indexesEnsured = true;
  try {
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await col.createIndex({ token: 1 }, { unique: true });
  } catch (e) {
    console.error('adPuzzle index setup failed:', e);
  }
}

function newCode() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}
function toImage(code) {
  return 'data:image/png;base64,' + renderCodePng(code).toString('base64');
}
const sameUser = (a, b) => String(a) === String(b);

async function createChallenge({ telegramId, sessionId, source, amount }) {
  const col = await getCollection('adPuzzles');
  await ensureIndexes(col);
  const token = crypto.randomBytes(16).toString('hex');
  const code = newCode();
  const now = new Date();
  await col.insertOne({
    token,
    telegramId,
    sessionId,
    source,
    amount,
    code,
    triesLeft: MAX_TRIES,
    used: false,
    shownAt: now,
    createdAt: now,
    expiresAt: new Date(now.getTime() + TTL_MS),
  });
  return { puzzleToken: token, image: toImage(code) };
}

async function verifyChallenge(telegramId, puzzleToken, answer) {
  if (!puzzleToken) return { ok: false, error: 'puzzle_not_found', final: true };
  const col = await getCollection('adPuzzles');
  const ch = await col.findOne({ token: String(puzzleToken) });

  if (!ch || !sameUser(ch.telegramId, telegramId)) return { ok: false, error: 'puzzle_not_found', final: true };
  if (ch.used) return { ok: false, error: 'puzzle_used', final: true };
  if (ch.expiresAt < new Date()) return { ok: false, error: 'puzzle_expired', final: true };
  if (Date.now() - new Date(ch.shownAt).getTime() < MIN_VIEW_MS) {
    return { ok: false, error: 'too_fast', final: false };
  }

  const given = String(answer == null ? '' : answer).trim();
  if (given.length === 4 && given === ch.code) {
    // atomic: only ONE request can flip used=false -> true
    const r = await col.findOneAndUpdate(
      { token: ch.token, used: false },
      { $set: { used: true, solvedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!r) return { ok: false, error: 'puzzle_used', final: true };
    return { ok: true, challenge: { source: ch.source, amount: ch.amount, sessionId: ch.sessionId } };
  }

  // wrong answer
  const triesLeft = (ch.triesLeft || MAX_TRIES) - 1;
  if (triesLeft <= 0) {
    await col.updateOne({ token: ch.token }, { $set: { used: true, failedAt: new Date(), triesLeft: 0 } });
    return { ok: false, error: 'puzzle_failed', final: true };
  }
  const code = newCode();
  await col.updateOne(
    { token: ch.token, used: false },
    { $set: { code, triesLeft, shownAt: new Date() } }
  );
  return { ok: false, error: 'puzzle_wrong', final: false, image: toImage(code), triesLeft };
}

module.exports = { createChallenge, verifyChallenge };
