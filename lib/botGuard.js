// lib/botGuard.js — anti-script detection for AD CLAIMS (ported from NewTube's botGuard,
// adapted to Fruit Cut's ad sessions). Feeds the LOCKUP system (lib/lockup.js).
//
// A real person is irregular: the ad loads for a variable time, they watch, close it, then
// tap "Watch" again a few seconds later. A script repeats the same timing every cycle.
// For every claimed ad session we keep a sample on the user: { s: ad started, c: claimed, w: seconds }
// (last 8) and look for patterns a human cannot produce:
//
//   Rule A  5 ads in a row, each watched <= 7s, next one started <= 1s after the previous claim
//   Rule C  5 ads whose watch time is identical within 0.3s
//   Rule E  5 ads whose pauses between them are identical within 0.3s (metronome)
//   Rule B  8 ads whose cycle time is identical within 1s
//
// A rule hit is only EVIDENCE. The evidence is scored (account age, withdrawals, referrals...):
//   🔴 Likely script        -> account LOCKED ('bot_pattern': no withdraw, no ad rewards)
//   🟡 Unclear / 🟢 Real    -> NOT locked, claim still pays, admin gets a "Suspicious" alert
//                              (at most once per 24h per user) with Lock / Profile / Ban buttons.
// Principle: only things a real person physically cannot do justify an automatic lock.

const { getCollection } = require('./db');
const { notifyAdmin } = require('./notify');
const { lockUser } = require('./lockup');

const SAMPLE = 5, MAX_WATCH_S = 7, MAX_IDLE_S = 1, METRO_SAMPLES = 8, CYCLE_SPREAD_S = 1, CYCLE_MAX_S = 40;
const WATCH_SPREAD_S = 0.3, GAP_SPREAD_S = 0.3, GAP_MAX_S = 20;
const KEEP = 8;
const REVIEW_THROTTLE_MS = 24 * 3600 * 1000;

function detect(samples) {
  const n = samples.length;
  if (n >= SAMPLE) {
    const last = samples.slice(-SAMPLE);
    if (last.every((x, i) => x.w <= MAX_WATCH_S && (i === 0 || (x.s - last[i - 1].c) / 1000 <= MAX_IDLE_S))) {
      return { rule: 'A', detail: `${SAMPLE} ads in a row watched ≤${MAX_WATCH_S}s each with ≤${MAX_IDLE_S}s gap` };
    }
    const ws = last.map((x) => x.w);
    if (Math.max(...ws) - Math.min(...ws) <= WATCH_SPREAD_S) {
      return { rule: 'C', detail: `${SAMPLE} ads with near-identical watch time (${Math.min(...ws).toFixed(1)}–${Math.max(...ws).toFixed(1)}s)` };
    }
    const gaps = last.slice(1).map((x, i) => (x.s - last[i].c) / 1000);
    if (Math.max(...gaps) <= GAP_MAX_S && Math.max(...gaps) - Math.min(...gaps) <= GAP_SPREAD_S) {
      return { rule: 'E', detail: `${SAMPLE} ads with metronome-like pauses (${Math.min(...gaps).toFixed(1)}–${Math.max(...gaps).toFixed(1)}s)` };
    }
  }
  if (n >= METRO_SAMPLES) {
    const last = samples.slice(-METRO_SAMPLES);
    const cycles = last.slice(1).map((x, i) => (x.c - last[i].c) / 1000);
    if (Math.max(...cycles) <= CYCLE_MAX_S && Math.max(...cycles) - Math.min(...cycles) <= CYCLE_SPREAD_S) {
      return { rule: 'B', detail: `${METRO_SAMPLES} ads with a metronome-like cycle (${Math.min(...cycles).toFixed(1)}–${Math.max(...cycles).toFixed(1)}s apart)` };
    }
  }
  return null;
}

async function buildEvidence(u, hit, samples) {
  const ageDays = u.joinedAt ? Math.floor((Date.now() - new Date(u.joinedAt).getTime()) / 86400000) : 30;
  const wdCol = await getCollection('withdrawals');
  const wCount = await wdCol.countDocuments({ telegramId: u.telegramId, status: 'approved' });
  const claims = samples.slice(-6);
  const watch = claims.map((x) => `${x.w}s`).join(', ') || '—';
  const gapVals = claims.slice(1).map((x, i) => Math.max(0, (x.s - claims[i].c) / 1000));
  const gaps = gapVals.map((g) => `${g.toFixed(1)}s`).join(', ') || '—';

  let script = 0, real = 0;
  if (hit.rule === 'A') script += 3;                                           // ≤1s between ads, 5 times — not humanly possible
  if (hit.rule === 'E' || (gapVals.length >= 4 && Math.max(...gapVals) - Math.min(...gapVals) <= 0.5)) script += 2;
  const wVals = claims.map((x) => x.w);
  if (wVals.length >= 5 && Math.max(...wVals) - Math.min(...wVals) <= 0.5) script += 1;
  if (ageDays < 2) script += 1;
  if (wCount === 0 && (u.totalAdsWatched || 0) > 80 && ageDays < 3) script += 1;
  if (ageDays >= 7) real += 1;
  if (wCount > 0) real += 1;
  if ((u.referralCount || 0) > 0) real += 1;
  if (hit.rule === 'B') real += 1;                                             // metronome-only has the most false positives

  const likelyScript = script >= 3 && script > real;
  const hint = likelyScript ? '🔴 Likely script' : real >= 3 && real > script ? '🟢 Likely real user' : '🟡 Unclear — check profile';
  const text =
    `\n<b>Evidence</b>\n` +
    `Name: ${u.username || '—'}\n` +
    `Account age: ${ageDays}d · Balance: ${u.fruitCoin || 0} FC · Withdrawals: ${wCount} · Referrals: ${u.referralCount || 0}\n` +
    `Ads lifetime: ${u.totalAdsWatched || 0}\n` +
    `Tap→claim times: ${watch}\n` +
    `Gaps between ads: ${gaps}\n` +
    `Hint: <b>${hint}</b> (script ${script} / real ${real})\n`;
  return { text, likelyScript };
}

// Records the claim and checks it. Returns true ONLY if the account is now locked
// (the caller must then reject the claim).
async function recordAdClaimAndCheck(user, { createdAt, network }) {
  try {
    const usersCol = await getCollection('users');
    const claimedMs = Date.now();
    const startMs = new Date(createdAt || claimedMs).getTime();
    const sample = { s: startMs, c: claimedMs, w: Math.round(((claimedMs - startMs) / 1000) * 10) / 10 };

    const after = await usersCol.findOneAndUpdate(
      { _id: user._id },
      { $push: { recentAdClaims: { $each: [sample], $slice: -KEEP } } },
      { returnDocument: 'after' }
    );
    if (!after) return false;
    if (after.accountLocked) return after.accountLockedReason === 'bot_pattern';

    const samples = after.recentAdClaims || [];
    const hit = detect(samples);
    if (!hit) return false;

    const ev = await buildEvidence(after, hit, samples);
    if (ev.likelyScript) {
      const locked = await lockUser(after, 'bot_pattern', { botFlaggedAt: new Date() });
      if (locked) {
        notifyAdmin(
          `🤖 <b>Bot / script pattern detected (ads)</b>\n\nUser: <code>${after.telegramId}</code> (${network})\nRule ${hit.rule}: ${hit.detail}\n${ev.text}\nThe account is now 🔒 locked (no withdraw, no ad rewards).`,
          { reply_markup: { inline_keyboard: [
            [{ text: '🔓 Unlock', callback_data: `lk_unlock_${after.telegramId}` }, { text: '👤 Profile', callback_data: `lk_profile_${after.telegramId}` }],
            [{ text: '🚫 Ban', callback_data: `a_ban_${after.telegramId}` }],
          ] } }
        ).catch(() => {});
      }
      return true;
    }

    // Not clearly a script: do NOT lock, claim pays; tell the admin at most once per 24h.
    const mark = await usersCol.updateOne(
      { _id: after._id, $or: [{ botReviewAt: { $exists: false } }, { botReviewAt: { $lt: new Date(Date.now() - REVIEW_THROTTLE_MS) } }] },
      { $set: { botReviewAt: new Date() } }
    );
    if (mark.modifiedCount > 0) {
      notifyAdmin(
        `⚠️ <b>Suspicious ad pattern — NOT locked</b>\n\nUser: <code>${after.telegramId}</code> (${network})\nRule ${hit.rule}: ${hit.detail}\n${ev.text}\nNothing was blocked. Lock the account yourself if you think it is a script.`,
        { reply_markup: { inline_keyboard: [
          [{ text: '🔒 Lock', callback_data: `lk_lock_${after.telegramId}` }, { text: '👤 Profile', callback_data: `lk_profile_${after.telegramId}` }],
          [{ text: '🚫 Ban', callback_data: `a_ban_${after.telegramId}` }],
        ] } }
      ).catch(() => {});
    }
    return false;
  } catch (e) {
    console.error('recordAdClaimAndCheck failed (claim allowed):', e);
    return false; // the guard must never break a legitimate claim
  }
}

module.exports = { recordAdClaimAndCheck, detect };
