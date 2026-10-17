// lib/wdProfile.js
// WITHDRAW DETAILS — one small record per user (collection `wdProfiles`, _id = telegram id as text).
//
// What it is for: when a user asks for a withdrawal, the admin must be able to tell a REAL user from a farm/bot.
// So from the user's first action the server counts what they did, and the admin sees it under every withdrawal.
//
// THE PERIOD
//   * A "period" starts at signup (first action) and runs until a withdrawal is APPROVED.
//   * Approved  -> the period is closed: its numbers are copied into `wdProfileHistory`
//                  (deleted automatically by TTL after HISTORY_DAYS) and the live counters start again from ZERO.
//   * Rejected / wrong-address refund / ban / balance reset -> NOTHING is reset. The counters keep growing
//                  until a withdrawal is finally approved.
//
// What is counted (the `kind` of track()):
//   'ad'    ads watched in the Ads section        (sub = adsgramDaily | adsgramTask | monetag | gigapub)
//   'game'  in-game loot claims (10 FC / 3 min)
//   'slash' fruit slashes
//   'task'  tasks completed
//   'gift'  treasure-box (daily gift) opens
// plus: Fruit Coin earned per kind, the days the user was active, and which hours of the day (UTC) they were active in.
//
// track() NEVER throws — a problem here must never break a reward.

const { getCollection } = require('./db');

const COL = 'wdProfiles';
const HIST = 'wdProfileHistory';
const HISTORY_DAYS = 30;          // closed periods are kept this long (TTL), then removed by MongoDB itself
const IDLE_DAYS = 120;            // a live record of a user who did nothing for this long is removed (TTL)
const DAY_MS = 86400000;

const KINDS = {
  ad:    { count: 'ads',        fc: 'ads' },
  game:  { count: 'gameClaims', fc: 'game' },
  slash: { count: 'slashes',    fc: 'slash' },
  task:  { count: 'tasks',      fc: 'task' },
  gift:  { count: 'gifts',      fc: 'gift' },
};
const SUBS = ['adsgramDaily', 'adsgramTask', 'monetag', 'gigapub'];

// Same names/options as lib/ttlIndexes.js, so running the admin "Auto-Cleanup" later changes nothing.
let indexesEnsured = false;
async function ensureIndexes() {
  if (indexesEnsured) return;
  indexesEnsured = true;
  try {
    await (await getCollection(HIST)).createIndex({ expireAt: 1 }, { name: 'ttl_wdProfileHistory_expire', expireAfterSeconds: 0 });
    await (await getCollection(COL)).createIndex({ lastAt: 1 }, { name: 'ttl_wdProfiles_lastAt', expireAfterSeconds: IDLE_DAYS * 86400 });
  } catch (e) { console.error('wdProfile index setup failed:', e && e.message); }
}

const dayKey = (d) => new Date(d.getTime() + 6 * 3600 * 1000).toISOString().slice(0, 10); // Dhaka calendar day

// Counts one action. kind: 'ad' | 'game' | 'slash' | 'task' | 'gift'. fc = Fruit Coin the action paid (without level bonus).
async function track(telegramId, kind, fc = 0, sub = null) {
  try {
    const k = KINDS[kind];
    if (!telegramId || !k) return;
    const now = new Date();
    const inc = { [k.count]: 1 };
    const amount = Number(fc) || 0;
    if (amount > 0) inc[`fc.${k.fc}`] = amount;
    if (kind === 'ad' && sub && SUBS.includes(sub)) inc[`adsBy.${sub}`] = 1;
    const update = {
      $inc: inc,
      $set: { lastAt: now },
      $addToSet: { activeDays: dayKey(now) },
      $bit: { hoursMask: { or: 1 << now.getUTCHours() } },
      $setOnInsert: { telegramId: String(telegramId), since: now, firstAt: now },
    };
    const filter = { _id: String(telegramId) };
    try {
      await (await getCollection(COL)).updateOne(filter, update, { upsert: true });
    } catch (e) {
      // two actions created the record at the very same moment -> the second one just needs a plain update
      if (e && e.code === 11000) await (await getCollection(COL)).updateOne(filter, update, { upsert: false });
      else throw e;
    }
    ensureIndexes();
  } catch (e) {
    console.error('wdProfile.track failed:', e && e.message);
  }
}

async function getProfile(telegramId) {
  try {
    return await (await getCollection(COL)).findOne({ _id: String(telegramId) });
  } catch (e) { return null; }
}

const emptyDoc = (telegramId, now) => ({
  _id: String(telegramId), telegramId: String(telegramId),
  since: now, firstAt: now, lastAt: now,
  ads: 0, adsBy: {}, gameClaims: 0, slashes: 0, tasks: 0, gifts: 0,
  fc: { ads: 0, game: 0, slash: 0, task: 0, gift: 0 },
  activeDays: [], hoursMask: 0,
});

// Called when a withdrawal is APPROVED (and only then). Closes the period: the old numbers go to the history
// (removed by TTL after HISTORY_DAYS) and the live record starts again from zero.
// The swap is ONE atomic database call, so an action that happens at the same moment is either in the old
// period or in the new one — never lost.
async function closePeriod(telegramId, withdrawal) {
  try {
    await ensureIndexes();
    const col = await getCollection(COL);
    const now = new Date();
    const before = await col.findOneAndReplace({ _id: String(telegramId) }, emptyDoc(telegramId, now), { returnDocument: 'before' });
    if (!before) return { closed: false };
    const hist = await getCollection(HIST);
    await hist.insertOne({
      telegramId: String(telegramId),
      withdrawalId: withdrawal && withdrawal._id ? String(withdrawal._id) : null,
      amountFc: withdrawal ? withdrawal.amount || null : null,
      payout: withdrawal ? `${withdrawal.convertedAmount || ''} ${withdrawal.unit || ''}`.trim() : null,
      periodStart: before.since || before.firstAt || null,
      periodEnd: now,
      stats: before,
      closedAt: now,
      expireAt: new Date(now.getTime() + HISTORY_DAYS * DAY_MS),
    });
    return { closed: true };
  } catch (e) {
    console.error('wdProfile.closePeriod failed:', e && e.message);
    return { closed: false, error: String(e && e.message || e) };
  }
}

// How many of the 24 hours of the day (UTC) the user has been active in.
const hoursActive = (mask) => { let n = 0, m = Number(mask) || 0; for (let i = 0; i < 24; i++) if (m & (1 << i)) n++; return n; };

module.exports = { track, getProfile, closePeriod, hoursActive, HISTORY_DAYS, IDLE_DAYS, SUBS };
