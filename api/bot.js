// api/bot.js
// Admin-panel Telegram bot webhook — completely separate from the Mini App.
// Only ADMIN_ID (env var, already set in Vercel) can use these commands.
// Anyone else's messages/clicks here are silently ignored — no info leak
// about admin functionality even exists for non-admins.
//
// ── One-time setup ────────────────────────────────────────────────
// After deploying, tell Telegram where to send updates for this bot by
// opening this URL once in a browser (replace YOUR_DOMAIN):
//
//   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://YOUR_DOMAIN/api/bot
//
// Note: if BOT_TOKEN above is the SAME bot used by your Mini App's
// "Open Game" button, that's fine — a bot can have both a webhook (for
// admin commands here) and be linked to a Mini App at the same time.

const { getCollection, findUserByTelegramId, idVariants } = require('../lib/db');
const { ObjectId } = require('mongodb');
const { createPromoCode, generateCode, listActivePromoCodes } = require('../lib/promo');
const adminPosts = require('../lib/adminPosts');
const adminSecurity = require('../lib/adminSecurity');
const { registerBan, unregisterBan } = require('../lib/lockup');
const { postPaymentProof } = require('../lib/proofImage');
const fs = require('fs');
const path = require('path');
const { grantWithdrawCommission, recountWeeklyReferrals } = require('../lib/referral');
const { getSettings } = require('../lib/settings');
const payoutFlow = require('../lib/payoutFlow');
const { userReport } = require('../lib/withdrawInfo');
const { getReferrals, referralReport } = require('../lib/referralReport');

const ADMIN_ID = String(process.env.ADMIN_TELEGRAM_ID || process.env.ADMIN_ID || '');
const BOT_TOKEN = process.env.BOT_TOKEN;
const hx = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); // safe text inside Telegram HTML
const BOT_USERNAME = 'Fruit_cut_bot';       // update if your bot's @username differs
const MINI_APP_SHORTNAME = 'PlayTo_Earn';   // update if your Mini App short name differs
const MINI_APP_URL = `https://t.me/${BOT_USERNAME}/${MINI_APP_SHORTNAME}`;
const WELCOME_PHOTO_URL = 'https://kommodo.ai/i/7iIBW2Wur84muWNjlOYl';

// ── Daily Growth stats ──────────────────────────────────────────
// "Today" is measured in Dhaka time (UTC+6, no DST), not server/UTC time
// — Vercel functions run in UTC, so without this a "today" count would
// flip over at 6am Bangladesh time instead of midnight, which would be
// confusing to read.
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
function dhakaStartOfDay(date) {
  const shifted = new Date(date.getTime() + DHAKA_OFFSET_MS);
  const startShiftedUTC = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(startShiftedUTC - DHAKA_OFFSET_MS); // back to the real UTC instant = Dhaka midnight
}
function dhakaDateLabel(date) {
  const shifted = new Date(date.getTime() + DHAKA_OFFSET_MS);
  return shifted.toISOString().slice(0, 10); // YYYY-MM-DD in Dhaka time
}

// One-time index on joinedAt so the daily-growth queries below stay fast
// and cheap even on a free-tier cluster as the users collection grows.
let joinedAtIndexEnsured = false;
async function ensureJoinedAtIndex(usersCol) {
  if (joinedAtIndexEnsured) return;
  joinedAtIndexEnsured = true;
  try {
    await usersCol.createIndex({ joinedAt: 1 });
  } catch (e) {
    console.error('joinedAt index setup failed:', e);
  }
}

// Hides the middle of an address for the public payment-channel post
// (e.g. "TXn9...k82Q"), while the user themselves still gets it in full
// in their own private notification.
function maskAddress(address) {
  const a = String(address || '');
  if (a.length <= 8) return a[0] + '***' + a[a.length - 1];
  return a.slice(0, 4) + '••••' + a.slice(-4);
}

// Per-admin multi-step input state.
//
// IMPORTANT: this used to be a plain in-memory object (`const state = {}`).
// That silently broke multi-step flows (promo generation, add-task, send-fc,
// send-gift, broadcast) in production, because Vercel serverless functions
// do NOT guarantee the same warm instance handles your next request — a
// cold start, a scale-up, or just a few seconds of idle time spins up a
// fresh instance with an empty `state = {}`. The admin would answer
// "Step 2/2" and randomly get bounced back to "Step 1/2" because the
// request landed on a different instance that never saw step 1.
//
// Fix: persist state in Mongo (tiny doc per admin, auto-expires after 1h
// of inactivity via a TTL index) so it survives across instances/cold starts.
const ADMIN_STATE_TTL_SECONDS = 60 * 60; // 1 hour of inactivity = abandoned flow
let adminStateIndexEnsured = false;
async function ensureAdminStateIndex(col) {
  if (adminStateIndexEnsured) return;
  adminStateIndexEnsured = true;
  try {
    await col.createIndex({ updatedAt: 1 }, { expireAfterSeconds: ADMIN_STATE_TTL_SECONDS });
  } catch (e) {
    console.error('adminState index setup failed:', e);
  }
}
async function getAdminState(adminId) {
  const col = await getCollection('adminState');
  await ensureAdminStateIndex(col);
  const doc = await col.findOne({ adminId: String(adminId) });
  return doc ? doc.data : null;
}
async function setAdminState(adminId, data) {
  const col = await getCollection('adminState');
  await ensureAdminStateIndex(col);
  await col.updateOne(
    { adminId: String(adminId) },
    { $set: { data, updatedAt: new Date() } },
    { upsert: true }
  );
}
async function clearAdminState(adminId) {
  const col = await getCollection('adminState');
  await col.deleteOne({ adminId: String(adminId) });
}

async function tgApi(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

const send = (chatId, text, extra = {}) =>
  tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });

const sendPhoto = (chatId, photoUrl, caption, extra = {}) =>
  tgApi('sendPhoto', { chat_id: chatId, photo: photoUrl, caption, parse_mode: 'HTML', ...extra });

const edit = (chatId, msgId, text, extra = {}) =>
  tgApi('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', ...extra });

const answer = (id, text = '') => tgApi('answerCallbackQuery', { callback_query_id: id, text });

// Everything lib/adminPosts.js needs from this file.
const postCtx = (chatId, fromId, msgId, cbId) => ({
  chatId, fromId, msgId, cbId,
  send, edit, answer, tgApi,
  getAdminState, setAdminState, clearAdminState,
  getCollection, ObjectId,
  MINI_APP_URL, adminKb, backKb,
  createPromoCode, generateCode,
});

// ── Broadcast preview — shown right before the admin confirms sending.
// Uses sendPhoto (with the text as caption) when a photo was attached,
// otherwise a plain text message — either way followed by the
// Confirm/Cancel buttons.
async function showBroadcastConfirm(chatId, fromId, state) {
  await setAdminState(fromId, { ...state, step: 'broadcast_confirm' });
  const preview =
    `📢 <b>Broadcast Preview</b>\n\n${state.text}` +
    (state.buttonText ? `\n\n🔘 Button: <b>${state.buttonText}</b> → ${state.buttonUrl}` : '') +
    (state.photoFileId ? `\n\n🖼 <i>(photo attached above)</i>` : '');
  const kb = {
    inline_keyboard: [
      [{ text: '✅ Send Broadcast', callback_data: 'broadcast_confirm_send' }],
      [{ text: '❌ Cancel', callback_data: 'broadcast_confirm_cancel' }],
    ],
  };
  if (state.photoFileId) {
    await sendPhoto(chatId, state.photoFileId, preview, { reply_markup: kb });
  } else {
    await send(chatId, preview, { reply_markup: kb });
  }
}

// ── 🎮 Games section (same setup as the NewTube admin panel) ─────────
// One admin line = "Title | GameURL | ThumbnailURL(optional)".
// GameURL may also be a pasted <iframe ... src="..."> snippet from GameMonetize.
function parseGameLine(line) {
  const parts = line.split('|').map((x) => x.trim());
  if (parts.length < 2) return null;
  const title = parts[0].slice(0, 60);
  let url = parts[1];
  const m = url.match(/src=["']([^"']+)["']/i);
  if (m) url = m[1];
  if (url.startsWith('//')) url = 'https:' + url;
  const okHttps = (u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };
  if (!title || !okHttps(url)) return null;
  let thumbnail = parts[2] || '';
  if (thumbnail && !okHttps(thumbnail)) thumbnail = '';
  return { title, gameUrl: url, thumbnail };
}

// One-click import from GameMonetize's public feed. Every press continues from the
// next feed page (page counter saved in `settings`), skips duplicates (matched by
// gameUrl) and stops at `target` new games.
async function importFromGameMonetize(target) {
  const games = await getCollection('games');
  const settingsCol = await getCollection('settings');
  const st = await settingsCol.findOne({ _id: 'gm_import' });
  let page = (st && st.page) || 1;
  let added = 0, skipped = 0, pagesUsed = 0, lastErr = '';
  const PER_PAGE = 50;
  while (added < target && pagesUsed < 6) {
    const feedUrl = `https://gamemonetize.com/feed.php?format=0&num=${PER_PAGE}&page=${page}`;
    let list = [];
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(feedUrl, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      clearTimeout(t);
      if (!r.ok) { lastErr = `HTTP ${r.status}`; break; }
      const j = await r.json();
      list = Array.isArray(j) ? j : (j.games || j.items || j.data || []);
    } catch (e) { lastErr = String(e.message || e).slice(0, 80); break; }
    if (!list.length) { lastErr = lastErr || 'feed returned no games (end of feed?)'; break; }
    for (const it of list) {
      if (added >= target) break;
      const gameUrl = it.url || it.gameUrl || it.link || '';
      const title = String(it.title || it.name || '').trim().slice(0, 60);
      if (!title || !/^https:\/\//i.test(gameUrl)) continue;
      if (await games.findOne({ gameUrl }, { projection: { _id: 1 } })) { skipped++; continue; }
      let thumbnail = it.thumb || it.thumbnail || it.image || '';
      if (!/^https:\/\//i.test(thumbnail)) thumbnail = '';
      await games.insertOne({ title, gameUrl, thumbnail, category: String(it.category || '').slice(0, 30), source: 'gamemonetize', isActive: true, playCount: 0, createdAt: new Date() });
      added++;
    }
    page++; pagesUsed++;
  }
  await settingsCol.updateOne({ _id: 'gm_import' }, { $set: { page } }, { upsert: true });
  return { added, skipped, nextPage: page, error: lastErr };
}

async function renderManageGames(chatId, msgId, page = 0) {
  const games = await getCollection('games');
  const perPage = 8;
  const total = await games.countDocuments({});
  const list = await games.find({}).sort({ createdAt: -1 }).skip(page * perPage).limit(perPage).toArray();
  if (!list.length) {
    await edit(chatId, msgId, page === 0 ? '📭 No games yet.' : '📭 No more games.', { reply_markup: backKb });
    return;
  }
  const rows = list.map((g) => [
    { text: `${g.isActive ? '🟢' : '⚪'} ${(g.title || 'Game').slice(0, 28)}`, callback_data: 'noop_dismiss' },
    { text: '🗑 Remove', callback_data: `delgame_${g._id}_${page}` },
  ]);
  const nav = [];
  if (page > 0) nav.push({ text: '◀️ Prev', callback_data: `a_managegames_${page - 1}` });
  if ((page + 1) * perPage < total) nav.push({ text: 'Next ▶️', callback_data: `a_managegames_${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]);
  await edit(chatId, msgId, `🎮 <b>Manage Games</b> (${total} total)`, { reply_markup: { inline_keyboard: rows } });
}

// ── Withdrawal approved & paid: payment proof + user message + referral commission ──
// Used by the normal approve flow AND by "✅ Sent" (after an uncertain automatic payout).
async function completeApproval(w, chatId, msgId, headLine) {
  const refLink = `${MINI_APP_URL}?startapp=${w.telegramId}`;
  // The three jobs do not depend on each other, so they run AT THE SAME TIME (saves a few seconds):
  //   1. community post (targets: lib/proofImage.js)   2. message to the user   3. 15% referral commission for the inviter.
  // The commission is awaited too (a serverless function can be frozen right after the reply, which silently lost it).
  const [proofRes] = await Promise.all([
    postPaymentProof(w, MINI_APP_URL).catch((e) => { console.error('payment proof failed:', e); return []; }),
    send(
      w.telegramId,
      `🎉🎉 <b>Congratulations! Your withdrawal is complete!</b> 🎉🎉\n\n` +
        `💵 <b>You received ${w.convertedAmount} ${w.unit}</b>\n` +
        `📍 Sent to: <code>${w.address}</code>\n\n` +
        `✅ Your payment has been sent to your wallet — your hard work just turned into real money! 🍎➡️💰\n\n` +
        `🌟 Thank you for being a part of Fruit Cut. You are doing great!\n\n` +
        `🚀 <b>Keep going:</b> slash fruits, finish tasks and watch ads to reach your next withdrawal even faster.\n` +
        `👥 Invite friends and earn <b>15% commission</b> every time their withdrawal is approved!`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎮 Keep Playing', url: MINI_APP_URL }],
            [{ text: '👥 Invite Friends & Earn 15%', url: `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent('🍎 I just got paid in Fruit Cut! Play, earn & withdraw real USDT 👇')}` }],
          ],
        },
      }
    ).catch((e) => console.error('user notify failed:', e)),
    grantWithdrawCommission(w.telegramId, w.amount).catch((e) => console.error('commission failed:', e)),
  ]);

  const proof = proofRes || [];
  const proofLine = proof.length
    ? proof.map((r) => `${r.ok ? '✅' : '❌'} ${r.target}${r.ok ? (r.mode === 'text' ? ' (text only)' : '') : ' — ' + String(r.error || 'failed').slice(0, 80)}`).join('\n')
    : '❌ proof not posted (see server logs)';
  await edit(chatId, msgId, `${headLine}\n\n📸 Payment proof:\n${proofLine}`, { reply_markup: backKb });
}

const adminKb = {
  inline_keyboard: [
    [{ text: '📊 Dashboard', callback_data: 'a_stats' }, { text: '📈 Daily Growth', callback_data: 'a_growth' }],
    [{ text: '👤 User Lookup', callback_data: 'a_user' }, { text: '🏆 Top Referrers', callback_data: 'a_toprefer' }],
    [{ text: '📢 Broadcast', callback_data: 'a_broadcast' }, { text: '📣 Channel Post', callback_data: 'a_chpost' }],
    [{ text: '🔄 Recount Weekly Referrals', callback_data: 'a_recount_refs' }],
    [{ text: '🎮 Add Games', callback_data: 'a_addgame' }, { text: '🗑 Manage Games', callback_data: 'a_managegames_0' }],
    [{ text: '📥 Import from GameMonetize', callback_data: 'a_importgames' }],
    [{ text: '🔒 Locked Accounts', callback_data: 'lk_list_0' }, { text: '💵 Withdraw Report', callback_data: 'a_wdreport' }],
    [{ text: '🧹 Auto-Cleanup (TTL)', callback_data: 'a_ttl' }],
    [{ text: '♻️ Restore Wrongly Device-Banned', callback_data: 'a_restore_devban' }],
    [{ text: '💰 Send Fruit Coin', callback_data: 'a_sendfc' }, { text: '🎁 Send Gift', callback_data: 'a_sendgift' }],
    [{ text: '📋 Manage Tasks', callback_data: 'a_managetasks' }],
    [{ text: '🎟️ Promo Codes', callback_data: 'a_promo' }],
    [{ text: '💰 Withdrawals', callback_data: 'a_withdrawals' }, { text: '💳 Payout Wallet', callback_data: 'a_payout' }],
  ],
};
const backKb = { inline_keyboard: [[{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] };
const TASK_CATEGORIES = ['daily', 'exclusive', 'partner'];
const TASK_CAT_LABEL = { daily: '🔥 Daily', exclusive: '💎 Exclusive', partner: '🤝 Partner' };

// Renders one page of a single category's task list with remove buttons.
async function renderTaskCategory(chatId, msgId, category, page, prefix = '') {
  const perPage = 6;
  const tasksCol = await getCollection('tasks');
  const filter = { category };
  const totalCount = await tasksCol.countDocuments(filter);
  const list = await tasksCol.find(filter).sort({ createdAt: -1 }).skip(page * perPage).limit(perPage).toArray();

  const label = TASK_CAT_LABEL[category] || category;
  let text_ = `${prefix}📋 <b>${label} Tasks</b> (${totalCount} total)\n\n`;
  if (!list.length) text_ += 'No tasks in this category yet.';
  list.forEach((t) => {
    const qtyTxt = t.maxCompletions > 0 ? `👥 ${t.completedCount || 0}/${t.maxCompletions}` : `👥 ${t.completedCount || 0}/∞`;
    const expTxt = t.expiresAt ? ` · ⏳ ${new Date(t.expiresAt) > new Date() ? 'until ' + new Date(t.expiresAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'expired'}` : '';
    const lvlTxt = t.minLevel > 0 ? ` · 🔒 Lv ${t.minLevel}+` : '';
    text_ += `${t.active ? '🟢' : '⚪'} <b>${t.title}</b> [${t.type}]\n🍎 ${t.rewardFc || t.reward || 0} FC · ${qtyTxt}${expTxt}${lvlTxt}\n\n`;
  });
  const rows = list.map((t) => [{ text: `🗑 Remove: ${t.title.slice(0, 24)}`, callback_data: `deltask_${t._id}_${category}_${page}` }]);
  const navRow = [];
  if (page > 0) navRow.push({ text: '◀️ Prev', callback_data: `a_mtcat_${category}_${page - 1}` });
  if ((page + 1) * perPage < totalCount) navRow.push({ text: 'Next ▶️', callback_data: `a_mtcat_${category}_${page + 1}` });
  if (navRow.length) rows.push(navRow);
  rows.push([{ text: '➕ Add Task', callback_data: 'a_addtask' }]);
  rows.push([{ text: '◀️ Categories', callback_data: 'a_managetasks' }]);
  await edit(chatId, msgId, text_, { reply_markup: { inline_keyboard: rows } });
}
const promoMenuKb = {
  inline_keyboard: [
    [{ text: '➕ Generate Code', callback_data: 'a_promo_gen' }],
    [{ text: '📜 Active Codes', callback_data: 'a_promo_list' }],
    [{ text: '🖼 Set Banner Photo', callback_data: 'pr_banner' }],
    [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }],
  ],
};

module.exports = async function handler(req, res) {
  // ONE-TIME SETUP LINK (GET): registers this bot's webhook WITH the secret from TELEGRAM_WEBHOOK_SECRET, so you never
  // have to paste BOT_TOKEN into a browser. Open  https://YOUR_DOMAIN/api/bot?setup=webhook&key=<CRON_SECRET>
  // It keeps the webhook URL and allowed_updates you already have and only adds the secret.
  if (req.method === 'GET' && req.query && req.query.setup === 'webhook') {
    try {
      const crypto = require('crypto');
      const cron = String(process.env.CRON_SECRET || '');
      const key = String(req.query.key || '');
      const same = cron && key.length === cron.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(cron));
      if (!same) return res.status(403).json({ ok: false, error: 'wrong key' });
      const secret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
        return res.status(200).json({ ok: false, error: 'TELEGRAM_WEBHOOK_SECRET is missing or has characters Telegram does not allow (only A-Z a-z 0-9 _ - are allowed).' });
      }
      const api = (m, body) => fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${m}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
      }).then((r) => r.json());
      const info = await api('getWebhookInfo');
      const cur = (info && info.result) || {};
      // Always point to THIS file (/api/bot). Old code kept whatever URL was already registered, which can be a wrong/dead one (e.g. /api/webhook).
      const url = `https://${req.headers.host}/api/bot`;
      const payload = { url, secret_token: secret, drop_pending_updates: false };
      if (Array.isArray(cur.allowed_updates) && cur.allowed_updates.length) payload.allowed_updates = cur.allowed_updates;
      if (cur.max_connections) payload.max_connections = cur.max_connections;
      const r = await api('setWebhook', payload);
      const after = await api('getWebhookInfo');
      const ai = (after && after.result) || {};
      return res.status(200).json({ ok: !!r.ok, telegram: r.description || null, old_webhook_url: cur.url || null, webhook_url: url, pending_updates: ai.pending_update_count, last_error: ai.last_error_message || null });
    } catch (e) {
      return res.status(200).json({ ok: false, error: String(e && e.message || e) });
    }
  }
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  // WEBHOOK SECRET: without this anybody could POST a fake Telegram update that says "from: admin" and run admin
  // commands (approve withdrawals, add Fruit Coin...). Telegram sends the secret you give to setWebhook in this header.
  {
    const secret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
    if (secret) {
      const got = String(req.headers['x-telegram-bot-api-secret-token'] || '');
      if (got !== secret) {
        console.warn(`[guardian] webhook call ignored: secret header ${got ? 'does not match' : 'is MISSING'} — run /api/bot?setup=webhook&key=<CRON_SECRET> once.`);
        return res.status(200).json({ ok: true }); // ignore forged calls
      }
    } else {
      console.warn('[guardian] TELEGRAM_WEBHOOK_SECRET is not set — the bot webhook accepts anyone. Set it and re-run setWebhook with secret_token.');
    }
  }

  const update = req.body || {};

  // Everything below used to have `const users = await getCollection('users')`
  // sitting here completely unguarded. If Mongo hiccupped even briefly (very
  // common right after launch, when real traffic can momentarily exhaust the
  // connection pool), this line threw BEFORE any try/catch below could catch
  // it — the whole function crashed with an unhandled rejection, Vercel
  // returned a 500, and Telegram got NO reply at all (not even the "⚠️
  // Something went wrong" message, since res.status() was never reached).
  // That's exactly "no response at all" instead of an error message.
  //
  // Fix: wrap the entire handler in one top-level try/catch. Now any DB
  // hiccup gets logged AND the admin still gets a reply telling them to
  // retry, instead of silence.
  let users;
  try {
    users = await getCollection('users');
  } catch (err) {
    console.error('bot.js: failed to get users collection (DB connection issue?):', err);
    // Best-effort — if we at least know who's asking, tell them to retry.
    const fallbackChatId = update.callback_query?.message?.chat?.id || update.message?.chat?.id;
    if (fallbackChatId) {
      await send(fallbackChatId, '⚠️ Server is temporarily busy (database connection issue). Please try again in a few seconds.').catch(() => {});
    }
    return res.status(200).json({ ok: true }); // 200 so Telegram doesn't endlessly retry-storm us
  }

  // ══════════════════════════════════════════════════════════════
  // BUTTON CLICKS
  // ══════════════════════════════════════════════════════════════
  if (update.callback_query) {
    const cb = update.callback_query;
    const fromId = String(cb.from.id);
    const chatId = cb.message.chat.id;
    const msgId = cb.message.message_id;
    const data = cb.data;

    await answer(cb.id);
    if (fromId !== ADMIN_ID) return res.status(200).json({ ok: true }); // silent ignore, not even an error reply

    try {
      // Promo codes + Channel Post (lib/adminPosts.js) handle their own buttons first.
      if (await adminPosts.handleCallback(data, postCtx(chatId, fromId, msgId, cb.id))) {
        return res.status(200).json({ ok: true });
      }
      // Lockup / Velocity alerts, Auto-Cleanup (TTL) and the Withdraw Report (lib/adminSecurity.js)
      if (await adminSecurity.handleCallback(data, { chatId, msgId, send, edit, backKb })) {
        return res.status(200).json({ ok: true });
      }
      if (data === 'a_menu') {
        await edit(chatId, msgId, '🛠 <b>Fruit Cut — Admin Panel</b>', { reply_markup: adminKb });
      } else if (data === 'a_stats') {
        const withdrawalsCol = await getCollection('withdrawals');
        const tasksCol = await getCollection('tasks');
        const slashLogCol = await getCollection('slashLog');
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        const [totalUsers, bannedUsers, agg, pendingWithdrawals, totalTasks, slashCount7d] = await Promise.all([
          users.countDocuments({}),
          users.countDocuments({ banned: true }),
          users.aggregate([{ $group: { _id: null, fc: { $sum: '$fruitCoin' } } }]).toArray(),
          withdrawalsCol.countDocuments({ status: 'pending' }),
          tasksCol.countDocuments({}),
          slashLogCol.countDocuments({ createdAt: { $gte: weekAgo } }),
        ]);
        const totals = agg[0] || { fc: 0 };
        const lockedUsers = await users.countDocuments({ accountLocked: true });
        const wdText = await adminSecurity.withdrawSummaryText();
        await edit(
          chatId,
          msgId,
          `📊 <b>Dashboard</b>\n\n` +
            `👥 Total users: <b>${totalUsers}</b>\n` +
            `🚫 Banned: <b>${bannedUsers}</b> · 🔒 Locked: <b>${lockedUsers}</b>\n` +
            `🍎 Fruit Coin in circulation: <b>${totals.fc.toLocaleString()}</b>\n` +
            `💸 Pending withdrawals: <b>${pendingWithdrawals}</b>\n` +
            `📋 Total tasks: <b>${totalTasks}</b>\n` +
            `🔪 Slash plays (last 7 days): <b>${slashCount7d}</b>\n` +
            wdText,
          { reply_markup: backKb }
        );
      } else if (data === 'a_growth') {
        await ensureJoinedAtIndex(users);

        const now = new Date();
        const startToday = dhakaStartOfDay(now);
        const startYesterday = new Date(startToday.getTime() - 24 * 60 * 60 * 1000);
        const start7d = new Date(startToday.getTime() - 6 * 24 * 60 * 60 * 1000); // today + 6 previous = 7 days
        const start30d = new Date(startToday.getTime() - 29 * 24 * 60 * 60 * 1000);

        // Users created before this feature shipped have no joinedAt field
        // at all — treat those as "unknown join date", not "joined today"
        // (a missing $gte comparison against a missing field would simply
        // not match, so they're correctly excluded from all the counts
        // below without any extra handling needed).
        const [todayCount, yesterdayCount, last7Count, last30Count, totalUsers, dailyBreakdown] = await Promise.all([
          users.countDocuments({ joinedAt: { $gte: startToday } }),
          users.countDocuments({ joinedAt: { $gte: startYesterday, $lt: startToday } }),
          users.countDocuments({ joinedAt: { $gte: start7d } }),
          users.countDocuments({ joinedAt: { $gte: start30d } }),
          users.countDocuments({}),
          users
            .aggregate([
              { $match: { joinedAt: { $gte: start7d } } },
              {
                $group: {
                  _id: { $dateToString: { format: '%Y-%m-%d', date: '$joinedAt', timezone: '+06:00' } },
                  count: { $sum: 1 },
                },
              },
            ])
            .toArray(),
        ]);

        const dayMap = {};
        dailyBreakdown.forEach((d) => { dayMap[d._id] = d.count; });

        let perDayText = '';
        for (let i = 6; i >= 0; i--) {
          const d = new Date(startToday.getTime() - i * 24 * 60 * 60 * 1000);
          const key = dhakaDateLabel(d);
          const label = i === 0 ? 'Today' : i === 1 ? 'Yesterday' : key;
          perDayText += `${label}: <b>${dayMap[key] || 0}</b>\n`;
        }

        await edit(
          chatId,
          msgId,
          `📈 <b>Daily Growth</b> <i>(Dhaka time)</i>\n\n` +
            `🆕 Today: <b>${todayCount}</b>\n` +
            `📅 Yesterday: <b>${yesterdayCount}</b>\n` +
            `🗓️ Last 7 days: <b>${last7Count}</b>\n` +
            `📆 Last 30 days: <b>${last30Count}</b>\n` +
            `👥 All-time total: <b>${totalUsers}</b>\n\n` +
            `<b>Per day (last 7):</b>\n${perDayText}`,
          { reply_markup: backKb }
        );
      } else if (data === 'a_toprefer') {
        const top = await users.find({ referralCount: { $gt: 0 } }).sort({ referralCount: -1 }).limit(10).toArray();
        let text = '🏆 <b>Top Referrers</b>\n\n';
        if (!top.length) text += 'No referrals yet.';
        top.forEach((u, i) => {
          text += `${i + 1}. @${u.username || 'unknown'} — <b>${u.referralCount}</b> refers\n`;
        });
        await edit(chatId, msgId, text, { reply_markup: backKb });
      } else if (data === 'a_user') {
        await setAdminState(fromId, { step: 'awaiting_user_lookup' });
        await edit(chatId, msgId, '👤 Send the Telegram ID or @username to look up:', { reply_markup: backKb });
      } else if (data === 'a_broadcast') {
        await setAdminState(fromId, { step: 'broadcast_photo' });
        await edit(
          chatId, msgId,
          '📢 <b>Broadcast — Step 1/3</b>\n\nSend a photo to include with this broadcast, or skip for text-only:',
          { reply_markup: { inline_keyboard: [[{ text: '⏭ Skip Photo', callback_data: 'broadcast_skip_photo' }], [{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } }
        );
      } else if (data === 'broadcast_skip_photo') {
        const s0 = await getAdminState(fromId);
        if (!s0 || s0.step !== 'broadcast_photo') return res.status(200).json({ ok: true });
        await setAdminState(fromId, { step: 'broadcast_text' });
        await edit(chatId, msgId, '📢 <b>Broadcast — Step 2/3</b>\n\nSend the message text to broadcast to all users:', { reply_markup: backKb });
      } else if (data === 'broadcast_add_button') {
        const s0 = await getAdminState(fromId);
        if (!s0 || s0.step !== 'broadcast_button_ask') return res.status(200).json({ ok: true });
        await setAdminState(fromId, { ...s0, step: 'broadcast_button_text' });
        await edit(chatId, msgId, '🔘 Send the button text (e.g. 🎮 Open Game):', { reply_markup: backKb });
      } else if (data === 'broadcast_skip_button') {
        const s0 = await getAdminState(fromId);
        if (!s0 || s0.step !== 'broadcast_button_ask') return res.status(200).json({ ok: true });
        await showBroadcastConfirm(chatId, fromId, s0);
      } else if (data === 'broadcast_confirm_send') {
        const s0 = await getAdminState(fromId);
        if (!s0 || s0.step !== 'broadcast_confirm') return res.status(200).json({ ok: true });
        await clearAdminState(fromId);
        const all = await users.find({}, { projection: { telegramId: 1 } }).toArray();
        await send(chatId, `📢 Broadcasting to <b>${all.length}</b> users...`);
        const extra = {};
        if (s0.buttonText && s0.buttonUrl) {
          extra.reply_markup = { inline_keyboard: [[{ text: s0.buttonText, url: s0.buttonUrl }]] };
        }
        let sentCount = 0;
        let failed = 0;
        const BROADCAST_CHUNK_SIZE = 25;
        const BROADCAST_CHUNK_DELAY_MS = 1050;
        for (let i = 0; i < all.length; i += BROADCAST_CHUNK_SIZE) {
          const chunk = all.slice(i, i + BROADCAST_CHUNK_SIZE);
          const results = await Promise.allSettled(
            chunk.map((u) =>
              s0.photoFileId
                ? sendPhoto(u.telegramId, s0.photoFileId, s0.text, extra)
                : send(u.telegramId, s0.text, extra)
            )
          );
          results.forEach((r) => (r.status === 'fulfilled' ? sentCount++ : failed++));
          if (i + BROADCAST_CHUNK_SIZE < all.length) {
            await new Promise((r) => setTimeout(r, BROADCAST_CHUNK_DELAY_MS)); // stay under Telegram's rate limit
          }
        }
        await send(chatId, `✅ Done! Sent: <b>${sentCount}</b> | Failed: <b>${failed}</b>`, { reply_markup: adminKb });
      } else if (data === 'broadcast_confirm_cancel') {
        await clearAdminState(fromId);
        await edit(chatId, msgId, '❌ Broadcast cancelled.', { reply_markup: backKb });
      } else if (data === 'a_sendfc') {
        await setAdminState(fromId, { step: 'sendfc_id' });
        await edit(chatId, msgId, '💰 Send the <b>Telegram ID</b> of who you want to send Fruit Coin to:', { reply_markup: backKb });
      } else if (data === 'a_sendgift') {
        await setAdminState(fromId, { step: 'gift_reason' });
        await edit(
          chatId, msgId,
          "🎁 <b>Send Gift — Step 1/3</b>\n\nWhat's the reason for this gift? (the user will see this reason when they open the app)",
          { reply_markup: backKb }
        );
      } else if (data === 'gift_confirm') {
        const gs = await getAdminState(fromId);
        if (!gs || gs.step !== 'gift_confirm') return res.status(200).json({ ok: true });
        await clearAdminState(fromId);
        const giftsCol = await getCollection('gifts');
        await giftsCol.insertOne({
          telegramId: gs.targetId,
          amount: gs.amount,
          reason: gs.reason,
          status: 'pending',
          createdBy: fromId,
          createdAt: new Date(),
        });
        await edit(
          chatId, msgId,
          `✅ <b>Gift created!</b>\n\n👤 <code>${gs.targetId}</code>\n🍎 ${gs.amount.toLocaleString()} Fruit Coin\n📝 ${gs.reason}\n\nThe user will see an animated gift-box as soon as they open the app, and their balance will be credited when they claim it.`,
          { reply_markup: backKb }
        );
        send(gs.targetId, `🎁 A <b>surprise gift</b> is waiting for you! Open Fruit Cut to see it.`).catch(() => {});
      } else if (data === 'gift_cancel') {
        await clearAdminState(fromId);
        await edit(chatId, msgId, '❌ Gift cancelled.', { reply_markup: backKb });
      } else if (data.startsWith('a_ban_')) {
        const targetId = data.replace('a_ban_', '');
        await users.updateOne({ telegramId: targetId }, { $set: { banned: true, bannedAt: new Date(), bannedReason: 'admin_manual' } });
        await registerBan(targetId, 'admin_manual'); // permanent record (survives the 60-day TTL cleanup)
        await send(chatId, `🚫 User <b>${targetId}</b> banned.`, { reply_markup: backKb });
      } else if (data.startsWith('a_unban_')) {
        const targetId = data.replace('a_unban_', '');
        await users.updateOne({ telegramId: targetId }, { $set: { banned: false }, $unset: { bannedAt: '', bannedReason: '' } });
        await unregisterBan(targetId);
        await send(chatId, `✅ User <b>${targetId}</b> unbanned.`, { reply_markup: backKb });
      } else if (data.startsWith('a_wd_paid_') || data.startsWith('a_wd_back_')) {
        // Human decision after an uncertain automatic payout.
        const sent = data.startsWith('a_wd_paid_');
        const idStr = data.replace(sent ? 'a_wd_paid_' : 'a_wd_back_', '');
        const withdrawalsCol = await getCollection('withdrawals');
        const w = await withdrawalsCol.findOneAndUpdate(
          { _id: new ObjectId(idStr), status: { $in: ['payout_check', 'paying'] } },
          sent
            ? { $set: { status: 'approved', paidAt: new Date(), payoutMode: 'auto_confirmed_by_admin' } }
            : { $set: { status: 'pending' }, $unset: { processedAt: '' } },
          { returnDocument: 'after' }
        );
        if (!w) {
          await edit(chatId, msgId, '⚠️ Already handled.', { reply_markup: backKb });
        } else if (sent) {
          await completeApproval(w, chatId, msgId, '✅ <b>Marked as paid</b> — user notified, commission sent to referrer (if any).');
        } else {
          await edit(chatId, msgId, '🔁 Back to pending. Find it in 💰 Withdrawals and approve again when the wallet is ready.', { reply_markup: backKb });
        }
      } else if (data === 'a_payout') {
        if (!payoutFlow.isConfigured()) {
          await edit(chatId, msgId,
            '💳 <b>Payout Wallet</b>\n\nAutomatic payout is <b>OFF</b> (withdrawals are approved by hand).\n\n' +
            'To turn it on add <code>TON_PAYOUT_MNEMONIC</code> (the 24 words of a dedicated payout wallet) in Vercel → Environment Variables, then redeploy.',
            { reply_markup: backKb });
        } else {
          await edit(chatId, msgId, '💳 Checking the payout wallet…').catch(() => {});
          let info;
          try { info = await payoutFlow.loadPayoutLib().walletInfo(); } catch (e) { info = { ok: false, error: String((e && e.message) || e).slice(0, 120) }; }
          if (!info.ok) {
            await edit(chatId, msgId,
              `💳 <b>Payout Wallet</b>\n\n❌ Problem: <code>${hx(info.error)}</code>${info.derived ? `\nThe 24 words give this address: <code>${info.derived}</code>` : ''}`,
              { reply_markup: backKb });
          } else {
            await edit(chatId, msgId,
              `💳 <b>Payout Wallet</b> (automatic payout is <b>ON</b>)\n\n` +
              `📍 <code>${info.address}</code>\n🧩 Wallet version: ${info.version}\n` +
              `💎 TON (fees): <b>${info.ton}</b>\n💵 USDT: <b>${info.usdt}</b>\n\n` +
              (info.readyForPayout ? '✅ Ready to pay.' : '⚠️ Not ready: the wallet needs at least 0.15 TON (recommended 0.5) and some USDT.'),
              { reply_markup: backKb });
          }
        }
      } else if (data === 'a_withdrawals') {
        const withdrawalsCol = await getCollection('withdrawals');
        const pending = await withdrawalsCol.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(5).toArray();
        // Automatic payouts that need a human look: result unknown, or stuck "paying" for over 3 minutes.
        const attention = await withdrawalsCol.find({ $or: [{ status: 'payout_check' }, { status: 'paying', processedAt: { $lt: new Date(Date.now() - 3 * 60 * 1000) } }] }).sort({ createdAt: 1 }).limit(5).toArray();
        for (const w of attention) {
          await send(
            chatId,
            `⚠️ <b>Check this payout manually</b>\n\n` +
              `👤 @${w.username || 'unknown'} (ID: <code>${w.telegramId}</code>)\n` +
              `💵 <b>${w.convertedAmount} ${w.unit}</b> → <code>${w.address}</code>\n` +
              `ℹ️ ${hx(String(w.payoutNote || 'payout was interrupted').slice(0, 150))}\n\n` +
              `Open the payout wallet's history in Tonkeeper. Was this USDT sent?`,
            { reply_markup: { inline_keyboard: [[{ text: '✅ Yes, it was sent', callback_data: `a_wd_paid_${w._id}` }], [{ text: '🔁 No, not sent (back to pending)', callback_data: `a_wd_back_${w._id}` }]] } }
          );
        }

        // Payout wallet balance (so the admin sees how much USDT is left before approving).
        let walletLine = '';
        if (payoutFlow.isConfigured()) {
          try {
            const wi = await payoutFlow.loadPayoutLib().walletInfo();
            walletLine = wi.ok
              ? `\n\n💳 Payout wallet: <b>${wi.usdt} USDT</b> · ${wi.ton} TON (fees)${wi.readyForPayout ? '' : '\n⚠️ Not ready — add USDT / TON'}`
              : `\n\n💳 Payout wallet: ❌ ${hx(wi.error)}`;
          } catch (e) { walletLine = ''; }
        }

        if (!pending.length && attention.length) {
          await edit(chatId, msgId, `💰 <b>Withdrawals</b>\n\nNo new requests — only the payout(s) above need your check.${walletLine}`, { reply_markup: backKb });
        } else if (!pending.length) {
          await edit(chatId, msgId, `💰 <b>Withdrawals</b>\n\nNo pending requests. 🎉${walletLine}`, { reply_markup: backKb });
        } else {
          const settings = await getSettings();
          const penaltyPercent = settings.withdrawWrongAddressPenaltyPercent ?? 10;
          await edit(chatId, msgId, `💰 <b>Withdrawals</b>\n\n<b>${pending.length}</b> pending request(s) below ⬇️${walletLine}`, { reply_markup: backKb });
          for (const w of pending) {
            await send(
              chatId,
              `🧾 <b>Withdrawal Request</b>\n\n` +
                `👤 @${w.username || 'unknown'} (ID: <code>${w.telegramId}</code>)\n` +
                `💎 Amount: <b>${w.amount} Fruit Coin</b>\n` +
                `💵 Payout: <b>${w.convertedAmount} ${w.unit}</b> via ${w.method}\n` +
                `📍 Address: <code>${w.address}</code>` +
                (await userReport(w)),
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: '✅ Approve', callback_data: `a_wd_ok_${w._id}` },
                      { text: '❌ Reject', callback_data: `a_wd_no_${w._id}` },
                    ],
                    [
                      { text: `⚠️ Wrong Address (refund -${penaltyPercent}%)`, callback_data: `a_wd_wra_${w._id}` },
                    ],
                    [
                      { text: '🚫 Ban user', callback_data: `a_wd_ban_${w._id}` },
                      { text: '🧹 Reset balance to 0', callback_data: `a_wd_rst_${w._id}` },
                    ],
                    [
                      { text: '👥 Referrals (7d ads)', callback_data: `a_wd_refs_${w._id}` },
                    ],
                  ],
                },
              }
            );
          }
        }
      } else if (data.startsWith('a_wd_refs_')) {
        // Show this user's referrals (+ ads each one watched in the last 7 days).
        const wdCol = await getCollection('withdrawals');
        const w = await wdCol.findOne({ _id: new ObjectId(data.replace('a_wd_refs_', '')) });
        if (!w) {
          await send(chatId, '⚠️ Request not found.', { reply_markup: backKb });
        } else {
          const rep = await referralReport(w.telegramId);
          await send(chatId, rep.text, {
            reply_markup: { inline_keyboard: [
              ...(rep.count ? [[{ text: `🚫 Ban user + all ${rep.count} referrals`, callback_data: `a_wd_banall_${w._id}` }]] : []),
              [{ text: '◀️ Back to Withdrawals', callback_data: 'a_withdrawals' }],
            ] },
          });
        }
      } else if (data.startsWith('a_wd_banall_')) {
        const wdCol = await getCollection('withdrawals');
        const w = await wdCol.findOne({ _id: new ObjectId(data.replace('a_wd_banall_', '')) });
        if (!w) {
          await edit(chatId, msgId, '⚠️ Request not found.', { reply_markup: backKb });
        } else {
          const refs = await getReferrals(w.telegramId);
          await edit(chatId, msgId,
            `🚫 <b>Ban this user AND all their referrals?</b>\n\n` +
              `👤 @${hx(w.username || 'unknown')} (ID: <code>${hx(w.telegramId)}</code>)\n` +
              `👥 <b>${refs.length}</b> referred accounts will be banned too (${refs.filter((r) => r.banned).length} already banned).\n\n` +
              `All their open withdrawal requests are cancelled (no refund). Bans are permanent.\n\nThis cannot be undone.`,
            { reply_markup: { inline_keyboard: [[{ text: '✅ Yes, ban all', callback_data: `a_wd_banallok_${w._id}` }], [{ text: '❌ Cancel', callback_data: 'a_withdrawals' }]] } });
        }
      } else if (data.startsWith('a_wd_banallok_')) {
        const wdCol = await getCollection('withdrawals');
        const w = await wdCol.findOne({ _id: new ObjectId(data.replace('a_wd_banallok_', '')) });
        if (!w) {
          await edit(chatId, msgId, '⚠️ Request not found.', { reply_markup: backKb });
        } else {
          const refs = await getReferrals(w.telegramId);
          const targets = [String(w.telegramId), ...refs.map((r) => String(r.telegramId))];
          let banned = 0;
          for (const t of targets) {
            try {
              const v = idVariants(t);
              const r = await users.updateOne({ telegramId: { $in: v } }, { $set: { banned: true, bannedAt: new Date(), bannedReason: 'admin_withdraw_cheat_ring' } });
              if (r.matchedCount) banned++;
              await registerBan(t, 'admin_withdraw_cheat_ring');
              await wdCol.updateMany({ telegramId: { $in: v }, status: { $in: ['pending', 'payout_check'] } }, { $set: { status: 'rejected_banned', processedAt: new Date() } });
            } catch (e) { console.error('banall failed for', t, e); }
          }
          await edit(chatId, msgId, `🚫 <b>Done.</b>\n\n👤 @${hx(w.username || 'unknown')} (<code>${hx(w.telegramId)}</code>) + <b>${refs.length}</b> referrals banned (${banned} accounts updated).\nTheir open withdrawal requests were cancelled (no refund).`, { reply_markup: backKb });
        }
      } else if (data.startsWith('a_wd_ban_') || data.startsWith('a_wd_rst_')) {
        // Cheater handling straight from a withdrawal request: ask "are you sure?" first.
        const isBan = data.startsWith('a_wd_ban_');
        const idStr = data.replace(isBan ? 'a_wd_ban_' : 'a_wd_rst_', '');
        const wdCol = await getCollection('withdrawals');
        const w = await wdCol.findOne({ _id: new ObjectId(idStr), status: 'pending' });
        if (!w) {
          await edit(chatId, msgId, '⚠️ Already processed.', { reply_markup: backKb });
        } else {
          await edit(chatId, msgId,
            `${isBan ? '🚫 <b>Ban this user?</b>' : '🧹 <b>Reset this user\'s balance to 0?</b>'}\n\n` +
              `👤 @${hx(w.username || 'unknown')} (ID: <code>${hx(w.telegramId)}</code>)\n` +
              `💎 Request: ${w.amount} FC → ${w.convertedAmount} ${w.unit}\n\n` +
              (isBan
                ? `The account is banned for good (it can never sign up again), this withdrawal is cancelled and the FC is NOT returned.`
                : `All Fruit Coin left on the account becomes 0 and this withdrawal is cancelled (the FC is NOT returned). The user is not banned.`) +
              `\n\nThis cannot be undone.`,
            { reply_markup: { inline_keyboard: [[{ text: isBan ? '✅ Yes, ban' : '✅ Yes, reset to 0', callback_data: `${isBan ? 'a_wd_banok_' : 'a_wd_rstok_'}${w._id}` }], [{ text: '❌ Cancel', callback_data: 'a_withdrawals' }]] } });
        }
      } else if (data.startsWith('a_wd_banok_') || data.startsWith('a_wd_rstok_')) {
        const isBan = data.startsWith('a_wd_banok_');
        const idStr = data.replace(isBan ? 'a_wd_banok_' : 'a_wd_rstok_', '');
        const wdCol = await getCollection('withdrawals');
        // Atomic: only the first tap works (the request leaves "pending" at once).
        const w = await wdCol.findOneAndUpdate(
          { _id: new ObjectId(idStr), status: 'pending' },
          { $set: { status: isBan ? 'rejected_banned' : 'rejected_reset', processedAt: new Date() } },
          { returnDocument: 'after' }
        );
        if (!w) {
          await edit(chatId, msgId, '⚠️ Already processed.', { reply_markup: backKb });
        } else if (isBan) {
          await users.updateOne(
            { telegramId: { $in: idVariants(w.telegramId) } },
            { $set: { banned: true, bannedAt: new Date(), bannedReason: 'admin_withdraw_cheat' } }
          );
          await registerBan(String(w.telegramId), 'admin_withdraw_cheat');
          await edit(chatId, msgId, `🚫 <b>User banned.</b>\n\n👤 @${hx(w.username || 'unknown')} (<code>${hx(w.telegramId)}</code>)\nTheir withdrawal request was cancelled (no refund).`, { reply_markup: backKb });
        } else {
          const before = await users.findOneAndUpdate(
            { telegramId: { $in: idVariants(w.telegramId) } },
            { $set: { fruitCoin: 0, balanceResetAt: new Date(), balanceResetReason: 'admin_withdraw_cheat' } },
            { returnDocument: 'before' }
          );
          const wasFc = before ? (before.fruitCoin || 0) : 0;
          try {
            const txCol = await getCollection('transactions');
            await txCol.insertOne({ telegramId: w.telegramId, type: 'admin_balance_reset', amount: -wasFc, currency: 'FC', balanceAfter: 0, meta: { withdrawalId: String(w._id) }, createdAt: new Date() });
          } catch (e) { /* log only */ }
          await edit(chatId, msgId, `🧹 <b>Balance reset to 0.</b>\n\n👤 @${hx(w.username || 'unknown')} (<code>${hx(w.telegramId)}</code>)\nRemoved: <b>${wasFc.toLocaleString('en-US')} FC</b>. Their withdrawal request was cancelled (no refund).`, { reply_markup: backKb });
        }
      } else if (data.startsWith('a_wd_ok_') || data.startsWith('a_wd_no_') || data.startsWith('a_wd_wra_')) {
        const approve   = data.startsWith('a_wd_ok_');
        const wrongAddr = data.startsWith('a_wd_wra_');
        const idStr     = data.replace(approve ? 'a_wd_ok_' : wrongAddr ? 'a_wd_wra_' : 'a_wd_no_', '');
        const withdrawalsCol = await getCollection('withdrawals');
        const usersCol       = await getCollection('users');

        // Atomic: only one admin tap can flip 'pending' -> approved/rejected/wrong_address.
        // With automatic payout set up (TON_PAYOUT_MNEMONIC) an approval first becomes 'paying'
        // and only turns 'approved' once the USDT really left the payout wallet.
        const autoPayOn = approve && payoutFlow.isConfigured();
        const newStatus = approve ? (autoPayOn ? 'paying' : 'approved') : wrongAddr ? 'wrong_address_refunded' : 'rejected';
        const w = await withdrawalsCol.findOneAndUpdate(
          { _id: new ObjectId(idStr), status: 'pending' },
          { $set: { status: newStatus, processedAt: new Date() } },
          { returnDocument: 'after' }
        );

        if (!w) {
          await edit(chatId, msgId, '⚠️ Already processed by you or another admin.', { reply_markup: backKb });
          return res.status(200).json({ ok: true });
        }

        if (approve) {
          if (autoPayOn) {
            await edit(chatId, msgId, `⏳ Sending <b>${w.convertedAmount} ${w.unit}</b> to the user's wallet… please wait (usually 10–30 seconds).`).catch(() => {});
            const r = await payoutFlow.autoPay(withdrawalsCol, w);
            if (r.state === 'paid') w.payoutTxHash = r.txHash || null; // used for the "View Transaction" link in the community post
            if (r.state === 'failed') {
              await edit(chatId, msgId,
                `❌ <b>Payment NOT sent</b> — nothing left your wallet.\n\n${payoutFlow.reasonText(r.error)}${r.detail ? `\n<code>${hx(String(r.detail).slice(0, 120))}</code>` : ''}\n\n` +
                `The request is back in 💰 Withdrawals (pending). Fix the problem, then tap ✅ Approve again.`,
                { reply_markup: backKb });
              return res.status(200).json({ ok: true });
            }
            if (r.state === 'uncertain') {
              await edit(chatId, msgId,
                `⚠️ <b>Payment status unknown</b>\n\n${payoutFlow.reasonText(r.error)}${r.detail ? `\n<code>${hx(String(r.detail).slice(0, 120))}</code>` : ''}\n\n` +
                `The USDT <b>may or may not</b> have been sent. Do NOT approve again. Open the payout wallet's history in Tonkeeper and check ` +
                `<b>${w.convertedAmount} ${w.unit}</b> → <code>${w.address}</code>:`,
                { reply_markup: { inline_keyboard: [[{ text: '✅ Yes, it was sent', callback_data: `a_wd_paid_${w._id}` }], [{ text: '🔁 No, not sent (back to pending)', callback_data: `a_wd_back_${w._id}` }]] } });
              return res.status(200).json({ ok: true });
            }
          }
          await completeApproval(w, chatId, msgId, autoPayOn
            ? '✅ <b>Paid automatically</b> — USDT sent, user notified, commission sent to referrer (if any).'
            : '✅ <b>Approved</b> — user notified, commission sent to referrer (if any).');

        } else if (wrongAddr) {
          // Wrong-address refund penalty — reads settings.withdrawWrongAddressPenaltyPercent
          // (admin-configurable) instead of a hardcoded 10%. This was found
          // hardcoded during a full-codebase bug sweep: the setting existed
          // in lib/settings.js and the DB doc, but nothing ever actually
          // read it — changing it via the admin bot would have had zero
          // effect on the real refund amount.
          const settings = await getSettings();
          const penaltyPercent = settings.withdrawWrongAddressPenaltyPercent ?? 10;
          const penaltyFc = Math.round(w.amount * (penaltyPercent / 100));
          const refundFc  = w.amount - penaltyFc;

          await usersCol.updateOne(
            { telegramId: w.telegramId },
            { $inc: { fruitCoin: refundFc } }
          );

          await send(
            w.telegramId,
            `⚠️ <b>Wrong Address Refund</b>\n\n` +
              `Your withdrawal of <b>${w.amount} Fruit Coin</b> was refunded because you entered a wrong wallet address.\n\n` +
              `💸 Refunded: <b>${refundFc} Fruit Coin</b>\n` +
              `🔻 Penalty (${penaltyPercent}%): <b>-${penaltyFc} Fruit Coin</b>\n\n` +
              `⚠️ Please make sure to use the correct wallet address next time!`
          ).catch((e) => console.error('user notify failed:', e));

          await edit(chatId, msgId, `⚠️ Wrong Address Refund processed — ${refundFc} FC refunded (${penaltyFc} FC penalty deducted). User notified.`, { reply_markup: backKb });

        } else {
          // Normal rejection: full refund
          await usersCol.updateOne({ telegramId: w.telegramId }, { $inc: { fruitCoin: w.amount } });

          await send(
            w.telegramId,
            `❌ Your withdrawal request for <b>${w.amount} Fruit Coin</b> was rejected.\n\n` +
              `Your Fruit Coin has been refunded to your balance.`
          ).catch((e) => console.error('user notify failed:', e));

          await edit(chatId, msgId, `❌ Rejected — Fruit Coin refunded & user notified.`, { reply_markup: backKb });
        }

      } else if (data === 'a_managetasks') {
        const tasksCol = await getCollection('tasks');
        const counts = await tasksCol.aggregate([{ $group: { _id: '$category', n: { $sum: 1 } } }]).toArray();
        const countMap = {};
        counts.forEach((c) => { countMap[c._id] = c.n; });
        const rows = TASK_CATEGORIES.map((cat) => [
          { text: `${TASK_CAT_LABEL[cat]} (${countMap[cat] || 0})`, callback_data: `a_mtcat_${cat}_0` },
        ]);
        rows.push([{ text: '➕ Add Task', callback_data: 'a_addtask' }]);
        rows.push([{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]);
        await edit(chatId, msgId, `📋 <b>Manage Tasks</b>\n\nChoose a category:`, { reply_markup: { inline_keyboard: rows } });
      } else if (data.startsWith('a_mtcat_')) {
        const [, , category, pageStr] = data.split('_');
        const page = parseInt(pageStr, 10) || 0;
        await renderTaskCategory(chatId, msgId, category, page);
      } else if (data.startsWith('deltask_')) {
        const [, tid, category, pageStr] = data.split('_');
        const tasksCol = await getCollection('tasks');
        await tasksCol.deleteOne({ _id: new ObjectId(tid) }).catch(() => {});
        const page = parseInt(pageStr, 10) || 0;
        await renderTaskCategory(chatId, msgId, category, page, '🗑 Task removed.\n\n');
      } else if (data === 'a_addtask') {
        await setAdminState(fromId, { step: 'task_category' });
        await edit(chatId, msgId, '📋 <b>Add Task — Step 1/4</b>\n\nChoose a category:', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔥 Daily', callback_data: 'task_cat_daily' }, { text: '💎 Exclusive', callback_data: 'task_cat_exclusive' }],
              [{ text: '🤝 Partner', callback_data: 'task_cat_partner' }, { text: '◀️ Cancel', callback_data: 'a_menu' }],
            ],
          },
        });
      } else if (data.startsWith('task_cat_')) {
        const category = data.replace('task_cat_', '');
        await setAdminState(fromId, { step: 'task_title', category });
        await edit(chatId, msgId, `📋 Category: ✅ <b>${category}</b>\n\nNow send the task <b>title</b>:`, { reply_markup: backKb });
      } else if (data === 'task_type_api') {
        const s0 = await getAdminState(fromId);
        if (!s0 || s0.step !== 'task_type') return res.status(200).json({ ok: true });
        await setAdminState(fromId, { ...s0, step: 'task_chatid', type: 'api' });
        await edit(chatId, msgId, `📋 Type: ✅ <b>Telegram Channel/Group (auto-verified)</b>\n\nSend the channel/group <b>@username</b>\n(⚠️ this bot must be an admin there to verify membership):`, { reply_markup: backKb });
      } else if (data === 'task_type_nonapi') {
        const s0 = await getAdminState(fromId);
        if (!s0 || s0.step !== 'task_type') return res.status(200).json({ ok: true });
        await setAdminState(fromId, { ...s0, step: 'task_url', type: 'nonapi' });
        await edit(chatId, msgId, `📋 Type: ✅ <b>Website / Other Bot (trust-based)</b>\n\nSend the <b>link</b> to open for this task:`, { reply_markup: backKb });
      } else if (data === 'task_confirm_save') {
        const s0 = await getAdminState(fromId);
        if (!s0 || s0.step !== 'task_confirm') return res.status(200).json({ ok: true });
        await clearAdminState(fromId);
        const tasksCol = await getCollection('tasks');
        const fcReward = s0.rewardFc || s0.reward || 0;
        await tasksCol.insertOne({
          title: s0.title,
          category: s0.category,
          type: s0.type,
          chatId: s0.chatId || null,
          url: s0.url || (s0.chatId ? `https://t.me/${String(s0.chatId).replace('@', '')}` : ''),
          icon: s0.type === 'api' ? '📢' : '⚡',
          reward: fcReward,
          rewardFc: fcReward,
          maxCompletions: s0.maxCompletions || 0,   // 0 = unlimited
          completedCount: 0,
          expiresAt: s0.expiresHours > 0 ? new Date(Date.now() + s0.expiresHours * 3600 * 1000) : null,
          minLevel: s0.minLevel || 0,
          active: true,
          createdAt: new Date(),
        });
        await edit(chatId, msgId, `✅ <b>Task created!</b>\n\n📋 ${s0.title}\n🍎 <b>${fcReward} Fruit Coin</b>`, { reply_markup: backKb });
      } else if (data === 'task_confirm_cancel') {
        await clearAdminState(fromId);
        await edit(chatId, msgId, '❌ Task creation cancelled.', { reply_markup: backKb });
      } else if (data === 'noop_dismiss') {
        // inert label button in lists
      } else if (data === 'a_addgame') {
        await setAdminState(fromId, { step: 'game_lines' });
        await edit(chatId, msgId,
          `🎮 <b>Add Games</b>\n\nSend one game per line (you can send many lines at once):\n\n<code>Title | GameURL | ThumbnailURL</code>\n\nThumbnailURL is optional. GameURL = the game's https embed link from GameMonetize (a pasted &lt;iframe&gt; snippet also works).\n\nExample:\n<code>Bike Race | https://html5.gamemonetize.com/abc123/ | https://img.gamemonetize.com/abc123/512x384.jpg</code>`,
          { reply_markup: backKb });
      } else if (data === 'a_importgames') {
        await edit(chatId, msgId, `📥 <b>Import from GameMonetize</b>\n\nHow many NEW games should I import now?\n(Every press continues where the last one stopped; duplicates are skipped.)`, {
          reply_markup: { inline_keyboard: [
            [{ text: '20 games', callback_data: 'a_impgm_20' }, { text: '50 games', callback_data: 'a_impgm_50' }, { text: '100 games', callback_data: 'a_impgm_100' }],
            [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }],
          ] },
        });
      } else if (data.startsWith('a_impgm_')) {
        const n = Math.min(100, parseInt(data.replace('a_impgm_', ''), 10) || 20);
        await edit(chatId, msgId, `⏳ Importing up to ${n} games from GameMonetize... please wait.`);
        const r = await importFromGameMonetize(n);
        const total = await (await getCollection('games')).countDocuments({});
        await edit(chatId, msgId,
          `${r.added ? '✅' : '⚠️'} <b>Import done</b>\n\n➕ Added: <b>${r.added}</b>\n♻️ Duplicates skipped: <b>${r.skipped}</b>\n🎮 Total games now: <b>${total}</b>` +
            (r.error ? `\n\n⚠️ Feed note: ${r.error}` : ''),
          { reply_markup: { inline_keyboard: [[{ text: '📥 Import more', callback_data: 'a_importgames' }], [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] } });
      } else if (data.startsWith('a_managegames_')) {
        await renderManageGames(chatId, msgId, parseInt(data.replace('a_managegames_', ''), 10) || 0);
      } else if (data.startsWith('delgame_')) {
        const [, gid, pg] = data.split('_');
        try { await (await getCollection('games')).deleteOne({ _id: new ObjectId(gid) }); } catch (e) { /* ignore */ }
        await answer(cb.id, '🗑 Game removed');
        await renderManageGames(chatId, msgId, parseInt(pg, 10) || 0);
      } else if (data === 'a_restore_devban') {
        // The old weak device fingerprint made unrelated phones collide, so some
        // innocent users were auto-banned as "multi_account_device". Undo those.
        const usersCol2 = await getCollection('users');
        const devicesCol2 = await getCollection('devices');
        const restored = await usersCol2.find({ bannedReason: 'multi_account_device' }, { projection: { telegramId: 1 } }).toArray();
        for (const u of restored) await unregisterBan(u.telegramId);
        const r1 = await usersCol2.updateMany({ bannedReason: 'multi_account_device' }, { $set: { banned: false }, $unset: { bannedReason: '', bannedAt: '' } });
        await devicesCol2.updateMany({}, { $unset: { blockedAttempts: '', lastBlockedAt: '' } });
        await edit(chatId, msgId, `♻️ <b>Done</b>\n\nRestored <b>${r1.modifiedCount}</b> account(s) that were auto-banned for "multi account device".\nBlocked-attempt counters reset.\n\n(Manual bans for other reasons are untouched.)`, { reply_markup: backKb });
      } else if (data === 'a_recount_refs') {
        await edit(chatId, msgId, '🔄 Recounting this week\'s referrals...', { reply_markup: backKb });
        const r = await recountWeeklyReferrals();
        await edit(chatId, msgId, `✅ <b>Weekly referral recount done</b>\n\nChecked: <b>${r.checked}</b> friends (joined this week, channels verified, not yet counted)\nNewly counted: <b>${r.counted}</b>`, { reply_markup: backKb });
      } else if (data === 'a_promo') {
        await edit(chatId, msgId, '🎟️ <b>Promo Codes</b>\n\nGenerate 2 codes at once and post them to the channel in one tap. You choose how long they stay valid (6h–72h); after that they auto-expire.', { reply_markup: promoMenuKb });
      } else if (data === 'a_promo_list') {
        const codes = await listActivePromoCodes(10);
        let text_ = '📜 <b>Active Promo Codes</b>\n\n';
        if (!codes.length) {
          text_ += 'No active codes right now.';
        } else {
          const now = Date.now();
          codes.forEach((c) => {
            const minsLeft = Math.max(0, Math.round((new Date(c.expiresAt).getTime() - now) / 60000));
            const usesText = c.maxUses > 0 ? `${c.usedCount}/${c.maxUses}` : `${c.usedCount}/∞`;
            text_ += `<code>${c.code}</code> — 🍎 ${(c.rewardFc || 0).toLocaleString()} FC\nUsed: ${usesText} · Expires in ${minsLeft}m\n\n`;
          });
        }
        await edit(chatId, msgId, text_, { reply_markup: promoMenuKb });
      }
    } catch (err) {
      console.error('bot callback error:', err);
      await send(chatId, `⚠️ Something went wrong:\n<code>${String(err && err.message || err).replace(/[<>&]/g, '').slice(0, 300)}</code>`, { reply_markup: backKb });
    }

    return res.status(200).json({ ok: true });
  }

  // ══════════════════════════════════════════════════════════════
  // TEXT MESSAGES
  // ══════════════════════════════════════════════════════════════
  if (update.message) {
    const msg = update.message;
    const fromId = String(msg.from.id);
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    if (fromId !== ADMIN_ID) {
      // ── Regular user: friendly welcome + their personal referral link ──
      if (text === '/start') {
        const referralLink = `${MINI_APP_URL}?startapp=${fromId}`;
        const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent('🍉 Slice fruits, earn crypto! Join me on Fruit Cut:')}`;
        await sendPhoto(
          chatId,
          WELCOME_PHOTO_URL,
          `🍉 <b>Welcome to Fruit Cut!</b>\n\n` +
            `Slice fruits every 1 hour, earn Fruit Coin, and cash out real crypto!\n\n` +
            `Invite friends to earn huge Fruit Coin bonuses! 🚀`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🎮 Open Mini App', url: MINI_APP_URL }],
                [{ text: '👥 Invite Friends', url: shareUrl }],
              ],
            },
          }
        );
      }
      return res.status(200).json({ ok: true }); // nothing else for non-admins
    }

    // ── Admin ────────────────────────────────────────────────────
    try {
      if (text === '/start' || text === '/admin') {
        await send(chatId, '🛠 <b>Fruit Cut — Admin Panel</b>', { reply_markup: adminKb });
        return res.status(200).json({ ok: true });
      }

      const s = await getAdminState(fromId);

      if (s && s.step === 'broadcast_photo') {
        if (msg.photo && msg.photo.length) {
          const fileId = msg.photo[msg.photo.length - 1].file_id; // last = largest resolution
          await setAdminState(fromId, { step: 'broadcast_text', photoFileId: fileId });
          await send(chatId, '🖼 Photo saved.\n\n📢 <b>Broadcast — Step 2/3</b>\n\nSend the message text to broadcast to all users:', { reply_markup: backKb });
        } else {
          await send(chatId, '⚠️ Please send a photo, or tap ⏭ Skip Photo above.');
        }
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'broadcast_text') {
        await setAdminState(fromId, { ...s, step: 'broadcast_button_ask', text });
        await send(
          chatId,
          '📢 Message saved.\n\n<b>Step 3/3</b> — Add a button to this broadcast? (e.g. an "Open App" button)',
          { reply_markup: { inline_keyboard: [[{ text: '➕ Add Button', callback_data: 'broadcast_add_button' }], [{ text: '⏭ Skip Button', callback_data: 'broadcast_skip_button' }]] } }
        );
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'broadcast_button_text') {
        await setAdminState(fromId, { ...s, step: 'broadcast_button_url', buttonText: text });
        await send(chatId, `🔘 Button text: ✅ <b>${text}</b>\n\nNow send the button URL (must start with http:// or https://):`);
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'broadcast_button_url') {
        if (!/^https?:\/\//i.test(text)) {
          await send(chatId, '❌ URL must start with http:// or https://. Send it again:');
          return res.status(200).json({ ok: true });
        }
        await showBroadcastConfirm(chatId, fromId, { ...s, buttonUrl: text });
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'awaiting_user_lookup') {
        await clearAdminState(fromId);
        const query = text.replace('@', '');
        const user = (await findUserByTelegramId(users, query)) || (await users.findOne({ username: query }));
        if (!user) {
          await send(chatId, '❌ User not found.', { reply_markup: backKb });
        } else {
          const p = await adminSecurity.profileMessage(user);
          await send(chatId, p.text, { reply_markup: p.kb });
        }
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'sendfc_id') {
        const user = (await findUserByTelegramId(users, text)) || (await users.findOne({ username: text.replace('@', '') }));
        if (!user) {
          await send(chatId, '❌ User not found. Send the ID/username again, or tap Back:', { reply_markup: backKb });
          return res.status(200).json({ ok: true });
        }
        await setAdminState(fromId, { step: 'sendfc_amount', targetId: user.telegramId });
        await send(chatId, `💰 How much <b>Fruit Coin</b> do you want to send to <code>${user.telegramId}</code>?`);
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'sendfc_amount') {
        const amt = parseInt(text, 10);
        if (!amt || isNaN(amt) || amt <= 0) {
          await send(chatId, '❌ Enter a valid positive number:');
          return res.status(200).json({ ok: true });
        }
        const targetId = s.targetId;
        await clearAdminState(fromId);
        const updated = await users.findOneAndUpdate(
          { telegramId: targetId },
          { $inc: { fruitCoin: amt } },
          { returnDocument: 'after' }
        );
        if (!updated) {
          await send(chatId, '❌ User not found (may have been removed).', { reply_markup: adminKb });
          return res.status(200).json({ ok: true });
        }
        await send(chatId, `✅ <b>${amt.toLocaleString()} Fruit Coin</b> sent to <code>${targetId}</code>`, { reply_markup: adminKb });
        await send(targetId, `🎁 You've received <b>${amt.toLocaleString()} 🍎 Fruit Coin</b> from the admin!`).catch(() => {});
        return res.status(200).json({ ok: true });
      }

      // ── Send Gift — reason → target → amount → confirm (user claims in-app) ──
      if (s && s.step === 'gift_reason') {
        await setAdminState(fromId, { step: 'gift_target', reason: text });
        await send(chatId, `📝 Reason: <b>${text}</b>\n\n🎁 <b>Send Gift — Step 2/3</b>\n\nWho do you want to gift? Send their <b>Telegram ID</b> or <b>@username</b>:`, { reply_markup: backKb });
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'gift_target') {
        const query = text.trim().replace(/^@/, '');
        const target = (await findUserByTelegramId(users, query)) || (await users.findOne({ username: query }));
        if (!target) {
          await send(chatId, '❌ User not found. Send the ID/username again, or tap Back:', { reply_markup: backKb });
          return res.status(200).json({ ok: true });
        }
        await setAdminState(fromId, { ...s, step: 'gift_amount', targetId: target.telegramId, targetUsername: target.username || 'unknown' });
        await send(chatId, `👤 Found: <code>${target.telegramId}</code> (@${target.username || 'unknown'})\n\n🎁 <b>Send Gift — Step 3/3</b>\n\nHow much <b>Fruit Coin</b> do you want to gift?`, { reply_markup: backKb });
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'gift_amount') {
        const amt = parseInt(text, 10);
        if (!amt || isNaN(amt) || amt <= 0) {
          await send(chatId, '❌ Enter a valid positive number:');
          return res.status(200).json({ ok: true });
        }
        await setAdminState(fromId, { ...s, step: 'gift_confirm', amount: amt });
        await send(
          chatId,
          `🎁 <b>Gift Preview</b>\n\n👤 <code>${s.targetId}</code> (@${s.targetUsername})\n🍎 <b>${amt.toLocaleString()} Fruit Coin</b>\n📝 ${s.reason}\n\nConfirming this will show an animated gift-box as soon as the user opens the app.`,
          { reply_markup: { inline_keyboard: [[{ text: '✅ Confirm & Send', callback_data: 'gift_confirm' }], [{ text: '❌ Cancel', callback_data: 'gift_cancel' }]] } }
        );
        return res.status(200).json({ ok: true });
      }

      // ── Add Task — title → type → chatid/url → reward → rewardFc → confirm ──
      if (s && s.step === 'task_title') {
        await setAdminState(fromId, { ...s, step: 'task_type', title: text });
        await send(chatId, `📋 Title: ✅ <b>${text}</b>\n\n<b>Step 3/5</b> — Choose the task type:`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Telegram Channel/Group (auto-verified)', callback_data: 'task_type_api' }],
              [{ text: '🌐 Website / Other Bot / Social (trust-based)', callback_data: 'task_type_nonapi' }],
              [{ text: '◀️ Cancel', callback_data: 'a_menu' }],
            ],
          },
        });
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'task_chatid') {
        const chatIdVal = text.startsWith('@') ? text : `@${text}`;
        await setAdminState(fromId, { ...s, step: 'task_reward', chatId: chatIdVal });
        await send(chatId, `📋 Channel: ✅ <code>${chatIdVal}</code>\n\n<b>Step 4/4</b> — How much <b>Fruit Coin (FC)</b> reward?`);
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'task_url') {
        await setAdminState(fromId, { ...s, step: 'task_reward', url: text });
        await send(chatId, `📋 Link: ✅ ${text}\n\n<b>Step 4/4</b> — How much <b>Fruit Coin (FC)</b> reward?`);
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'task_reward') {
        const rewardFc = parseInt(text, 10);
        if (!rewardFc || isNaN(rewardFc) || rewardFc <= 0) {
          await send(chatId, '❌ Enter a valid positive number:');
          return res.status(200).json({ ok: true });
        }
        await setAdminState(fromId, { ...s, step: 'task_qty', rewardFc, reward: rewardFc });
        await send(chatId, `🍎 Reward: ✅ <b>${rewardFc}</b>\n\n👥 <b>Task quantity</b> — how many users can complete this task? Send a number (e.g. <code>500</code>), or <code>0</code> for unlimited.\nWhen the limit is reached the task disappears automatically.`);
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'task_qty') {
        const qty = parseInt(text, 10);
        if (isNaN(qty) || qty < 0) {
          await send(chatId, '❌ Enter 0 (unlimited) or a positive number:');
          return res.status(200).json({ ok: true });
        }
        await setAdminState(fromId, { ...s, step: 'task_hours', maxCompletions: qty });
        await send(chatId, `👥 Quantity: ✅ <b>${qty > 0 ? qty : 'Unlimited'}</b>\n\n⏳ <b>Duration</b> — after how many <b>hours</b> should this task expire? (e.g. <code>24</code> or <code>72</code>), or <code>0</code> for no expiry.`);
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'task_hours') {
        const hrs = parseFloat(text);
        if (isNaN(hrs) || hrs < 0) {
          await send(chatId, '❌ Enter 0 (no expiry) or a number of hours:');
          return res.status(200).json({ ok: true });
        }
        await setAdminState(fromId, { ...s, step: 'task_level', expiresHours: hrs });
        await send(chatId, `⏳ Duration: ✅ <b>${hrs > 0 ? hrs + 'h' : 'No expiry'}</b>\n\n🔒 <b>Minimum level</b> — which level must a user reach to do this task? Send a number (e.g. <code>3</code>), or <code>0</code> for everyone.`);
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'task_level') {
        const lvl = parseInt(text, 10);
        if (isNaN(lvl) || lvl < 0) {
          await send(chatId, '❌ Enter 0 (everyone) or a level number:');
          return res.status(200).json({ ok: true });
        }
        const s1 = { ...s, step: 'task_confirm', minLevel: lvl };
        await setAdminState(fromId, s1);
        const preview =
          `📋 <b>Task Preview</b>\n\n` +
          `Title: <b>${s1.title}</b>\n` +
          `Category: <b>${s1.category}</b>\n` +
          `Type: <b>${s1.type === 'api' ? 'Telegram Channel/Group (verified)' : 'Website/Other (trust-based)'}</b>\n` +
          (s1.chatId ? `Channel: <code>${s1.chatId}</code>\n` : `Link: ${s1.url || 'none'}\n`) +
          `Reward: <b>🍎 ${s1.rewardFc} Fruit Coin</b>\n` +
          `Quantity: <b>${s1.maxCompletions > 0 ? s1.maxCompletions + ' users' : 'Unlimited'}</b>\n` +
          `Duration: <b>${s1.expiresHours > 0 ? s1.expiresHours + ' hours' : 'No expiry'}</b>\n` +
          `Min level: <b>${s1.minLevel > 0 ? 'Level ' + s1.minLevel + '+' : 'Everyone'}</b>\n\n` +
          (s1.type === 'api' ? `⚠️ Make sure this bot is an admin in that channel/group, or verification will always fail!\n\n` : '');
        await send(chatId, preview, {
          reply_markup: { inline_keyboard: [[{ text: '✅ Confirm & Save', callback_data: 'task_confirm_save' }], [{ text: '❌ Cancel', callback_data: 'task_confirm_cancel' }]] },
        });
        return res.status(200).json({ ok: true });
      }

      // ── 🎮 Add Games — bulk, one game per line ──
      if (s && s.step === 'game_lines') {
        const gamesCol = await getCollection('games');
        const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
        const docs = []; let dup = 0; const bad = [];
        for (const line of lines) {
          const g = parseGameLine(line);
          if (!g) { bad.push(line.slice(0, 30)); continue; }
          if (docs.some((d) => d.gameUrl === g.gameUrl) || await gamesCol.findOne({ gameUrl: g.gameUrl }, { projection: { _id: 1 } })) { dup++; continue; }
          docs.push({ ...g, isActive: true, playCount: 0, createdAt: new Date() });
        }
        if (!docs.length) {
          await send(chatId, `❌ Nothing added.${dup ? ` ${dup} duplicate(s).` : ''}${bad.length ? ` Bad lines: ${bad.length}.` : ''}\nFormat: <code>Title | https://game-url | https://thumb-url</code>\nTry again or press Cancel.`);
          return res.status(200).json({ ok: true });
        }
        await clearAdminState(fromId);
        await gamesCol.insertMany(docs);
        await send(chatId, `✅ <b>${docs.length} game(s) added!</b>${dup ? `\n♻️ Skipped duplicates: ${dup}` : ''}${bad.length ? `\n⚠️ Bad lines skipped: ${bad.length}` : ''}`, { reply_markup: adminKb });
        return res.status(200).json({ ok: true });
      }

      // ══ Promo codes + Channel Post flows live in lib/adminPosts.js ══
      if (await adminPosts.handleMessage(s, text, msg, postCtx(chatId, fromId, null, null))) {
        return res.status(200).json({ ok: true });
      }

    } catch (err) {
      console.error('bot message error:', err);
      await send(chatId, `⚠️ Something went wrong:\n<code>${String(err && err.message || err).replace(/[<>&]/g, '').slice(0, 300)}</code>`, { reply_markup: backKb });
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({ ok: true });
};
