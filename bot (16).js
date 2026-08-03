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

const { getCollection, findUserByTelegramId } = require('../lib/db');
const { ObjectId } = require('mongodb');
const { createPromoCode, listActivePromoCodes } = require('../lib/promo');

const ADMIN_ID = String(process.env.ADMIN_TELEGRAM_ID || process.env.ADMIN_ID || '');
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = 'Fruit_cut_bot';       // update if your bot's @username differs
const MINI_APP_SHORTNAME = 'PlayTo_Earn';   // update if your Mini App short name differs
const MINI_APP_URL = `https://t.me/${BOT_USERNAME}/${MINI_APP_SHORTNAME}`;
const WELCOME_PHOTO_URL = 'https://kommodo.ai/i/7iIBW2Wur84muWNjlOYl';
const PAYMENT_CHANNEL = '@fruit_cut_payment'; // bot must be an ADMIN of this channel to post here

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

const adminKb = {
  inline_keyboard: [
    [{ text: '📊 Dashboard', callback_data: 'a_stats' }, { text: '📈 Daily Growth', callback_data: 'a_growth' }],
    [{ text: '👤 User Lookup', callback_data: 'a_user' }, { text: '🏆 Top Referrers', callback_data: 'a_toprefer' }],
    [{ text: '📢 Broadcast', callback_data: 'a_broadcast' }],
    [{ text: '💰 Send Fruit Coin', callback_data: 'a_sendfc' }, { text: '🎁 Send Gift', callback_data: 'a_sendgift' }],
    [{ text: '📋 Manage Tasks', callback_data: 'a_managetasks_0' }],
    [{ text: '🎟️ Promo Codes', callback_data: 'a_promo' }],
    [{ text: '💰 Withdrawals', callback_data: 'a_withdrawals' }],
  ],
};
const backKb = { inline_keyboard: [[{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] };
const promoMenuKb = {
  inline_keyboard: [
    [{ text: '➕ Generate Code', callback_data: 'a_promo_gen' }],
    [{ text: '📜 Active Codes', callback_data: 'a_promo_list' }],
    [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }],
  ],
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

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
      if (data === 'a_menu') {
        await edit(chatId, msgId, '🛠 <b>Fruit Cut — Admin Panel</b>', { reply_markup: adminKb });
      } else if (data === 'a_stats') {
        const totalUsers = await users.countDocuments({});
        const bannedUsers = await users.countDocuments({ banned: true });
        const agg = await users
          .aggregate([{ $group: { _id: null, gold: { $sum: '$gold' }, fc: { $sum: '$fruitCoin' } } }])
          .toArray();
        const totals = agg[0] || { gold: 0, fc: 0 };
        await edit(
          chatId,
          msgId,
          `📊 <b>Dashboard</b>\n\n` +
            `👥 Total users: <b>${totalUsers}</b>\n` +
            `🚫 Banned: <b>${bannedUsers}</b>\n` +
            `🪙 Gold in circulation: <b>${totals.gold.toLocaleString()}</b>\n` +
            `🍎 Fruit Coin in circulation: <b>${totals.fc.toLocaleString()}</b>`,
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
        for (const u of all) {
          try {
            if (s0.photoFileId) {
              await sendPhoto(u.telegramId, s0.photoFileId, s0.text, extra);
            } else {
              await send(u.telegramId, s0.text, extra);
            }
            sentCount++;
          } catch {
            failed++;
          }
          await new Promise((r) => setTimeout(r, 50)); // stay under Telegram's rate limit
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
        await users.updateOne({ telegramId: targetId }, { $set: { banned: true } });
        await send(chatId, `🚫 User <b>${targetId}</b> banned.`, { reply_markup: backKb });
      } else if (data.startsWith('a_unban_')) {
        const targetId = data.replace('a_unban_', '');
        await users.updateOne({ telegramId: targetId }, { $set: { banned: false } });
        await send(chatId, `✅ User <b>${targetId}</b> unbanned.`, { reply_markup: backKb });
      } else if (data === 'a_withdrawals') {
        const withdrawalsCol = await getCollection('withdrawals');
        const pending = await withdrawalsCol.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(5).toArray();

        if (!pending.length) {
          await edit(chatId, msgId, '💰 <b>Withdrawals</b>\n\nNo pending requests. 🎉', { reply_markup: backKb });
        } else {
          await edit(chatId, msgId, `💰 <b>Withdrawals</b>\n\n<b>${pending.length}</b> pending request(s) below ⬇️`, { reply_markup: backKb });
          for (const w of pending) {
            await send(
              chatId,
              `🧾 <b>Withdrawal Request</b>\n\n` +
                `👤 @${w.username || 'unknown'} (ID: <code>${w.telegramId}</code>)\n` +
                `💎 Amount: <b>${w.amount} Fruit Coin</b>\n` +
                `💵 Payout: <b>${w.convertedAmount} ${w.unit}</b> via ${w.method}\n` +
                `📍 Address: <code>${w.address}</code>`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: '✅ Approve', callback_data: `a_wd_ok_${w._id}` },
                      { text: '❌ Reject', callback_data: `a_wd_no_${w._id}` },
                    ],
                  ],
                },
              }
            );
          }
        }
      } else if (data.startsWith('a_wd_ok_') || data.startsWith('a_wd_no_')) {
        const approve = data.startsWith('a_wd_ok_');
        const idStr = data.replace(approve ? 'a_wd_ok_' : 'a_wd_no_', '');
        const withdrawalsCol = await getCollection('withdrawals');

        // Atomic: only one admin tap can flip 'pending' -> approved/rejected
        // (Driver v6+ returns the document directly, not wrapped in { value })
        const w = await withdrawalsCol.findOneAndUpdate(
          { _id: new ObjectId(idStr), status: 'pending' },
          { $set: { status: approve ? 'approved' : 'rejected', processedAt: new Date() } },
          { returnDocument: 'after' }
        );

        if (!w) {
          await edit(chatId, msgId, '⚠️ Already processed by you or another admin.', { reply_markup: backKb });
          return res.status(200).json({ ok: true });
        }

        if (approve) {
          // Post to the public payment channel with a masked address
          await send(
            PAYMENT_CHANNEL,
            `✅ <b>Withdrawal Completed</b>\n\n` +
              `👤 User: @${w.username || 'unknown'} (ID: <code>${w.telegramId}</code>)\n` +
              `💵 Amount: <b>${w.convertedAmount} ${w.unit}</b>\n` +
              `📍 Address: <code>${maskAddress(w.address)}</code>`
          ).catch((e) => console.error('payment channel post failed:', e));

          // Notify the user privately with the FULL address
          await send(
            w.telegramId,
            `🎉 <b>Congratulations! You have received ${w.convertedAmount} ${w.unit}</b>\n\n` +
              `📍 Address: <code>${w.address}</code>`,
            { reply_markup: { inline_keyboard: [[{ text: '🎮 Open Mini App', url: MINI_APP_URL }]] } }
          ).catch((e) => console.error('user notify failed:', e));

          await edit(chatId, msgId, `✅ Approved — posted to payment channel & user notified.`, { reply_markup: backKb });
        } else {
          // Refund the Fruit Coin back to the user
          await users.updateOne({ telegramId: w.telegramId }, { $inc: { fruitCoin: w.amount } });

          await send(
            w.telegramId,
            `❌ Your withdrawal request for <b>${w.amount} Fruit Coin</b> was rejected.\n\n` +
              `Your Fruit Coin has been refunded to your balance.`
          ).catch((e) => console.error('user notify failed:', e));

          await edit(chatId, msgId, `❌ Rejected — Fruit Coin refunded & user notified.`, { reply_markup: backKb });
        }
      } else if (data.startsWith('a_managetasks_')) {
        const page = parseInt(data.replace('a_managetasks_', ''), 10) || 0;
        const perPage = 6;
        const tasksCol = await getCollection('tasks');
        const totalCount = await tasksCol.countDocuments({});
        const list = await tasksCol.find({}).sort({ createdAt: -1 }).skip(page * perPage).limit(perPage).toArray();

        let text_ = `📋 <b>Manage Tasks</b> (${totalCount} total)\n\n`;
        if (!list.length) text_ += 'No tasks yet — tap ➕ Add Task below.';
        list.forEach((t) => {
          text_ += `${t.active ? '🟢' : '⚪'} <b>${t.title}</b> [${t.category}/${t.type}]\n🪙 ${t.reward}g` + (t.rewardFc ? ` + 🍎${t.rewardFc}` : '') + `\n\n`;
        });
        const rows = list.map((t) => [{ text: `🗑 Remove: ${t.title.slice(0, 24)}`, callback_data: `deltask_${t._id}_${page}` }]);
        const navRow = [];
        if (page > 0) navRow.push({ text: '◀️ Prev', callback_data: `a_managetasks_${page - 1}` });
        if ((page + 1) * perPage < totalCount) navRow.push({ text: 'Next ▶️', callback_data: `a_managetasks_${page + 1}` });
        if (navRow.length) rows.push(navRow);
        rows.push([{ text: '➕ Add Task', callback_data: 'a_addtask' }]);
        rows.push([{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]);
        await edit(chatId, msgId, text_, { reply_markup: { inline_keyboard: rows } });
      } else if (data.startsWith('deltask_')) {
        const [, tid, pageStr] = data.split('_');
        const tasksCol = await getCollection('tasks');
        await tasksCol.deleteOne({ _id: new ObjectId(tid) }).catch(() => {});
        // Re-render the same page after deleting
        const page = parseInt(pageStr, 10) || 0;
        const perPage = 6;
        const totalCount = await tasksCol.countDocuments({});
        const list = await tasksCol.find({}).sort({ createdAt: -1 }).skip(page * perPage).limit(perPage).toArray();
        let text_ = `🗑 Task removed.\n\n📋 <b>Manage Tasks</b> (${totalCount} total)\n\n`;
        list.forEach((t) => {
          text_ += `${t.active ? '🟢' : '⚪'} <b>${t.title}</b> [${t.category}/${t.type}]\n🪙 ${t.reward}g` + (t.rewardFc ? ` + 🍎${t.rewardFc}` : '') + `\n\n`;
        });
        const rows = list.map((t) => [{ text: `🗑 Remove: ${t.title.slice(0, 24)}`, callback_data: `deltask_${t._id}_${page}` }]);
        rows.push([{ text: '➕ Add Task', callback_data: 'a_addtask' }]);
        rows.push([{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]);
        await edit(chatId, msgId, text_, { reply_markup: { inline_keyboard: rows } });
      } else if (data === 'a_addtask') {
        await setAdminState(fromId, { step: 'task_category' });
        await edit(chatId, msgId, '📋 <b>Add Task — Step 1/5</b>\n\nChoose a category:', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔥 Daily', callback_data: 'task_cat_daily' }, { text: '💬 Social', callback_data: 'task_cat_social' }],
              [{ text: '💎 Exclusive', callback_data: 'task_cat_exclusive' }, { text: '🤝 Partner', callback_data: 'task_cat_partner' }],
              [{ text: '◀️ Cancel', callback_data: 'a_menu' }],
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
        await edit(chatId, msgId, `📋 Type: ✅ <b>Website / Other Bot / Social (trust-based)</b>\n\nSend the <b>link</b> to open for this task:`, { reply_markup: backKb });
      } else if (data === 'task_confirm_save') {
        const s0 = await getAdminState(fromId);
        if (!s0 || s0.step !== 'task_confirm') return res.status(200).json({ ok: true });
        await clearAdminState(fromId);
        const tasksCol = await getCollection('tasks');
        await tasksCol.insertOne({
          title: s0.title,
          category: s0.category,
          type: s0.type,
          chatId: s0.chatId || null,
          url: s0.url || (s0.chatId ? `https://t.me/${String(s0.chatId).replace('@', '')}` : ''),
          icon: s0.type === 'api' ? '📢' : '⚡',
          reward: s0.reward,
          rewardFc: s0.rewardFc || 0,
          active: true,
          createdAt: new Date(),
        });
        await edit(chatId, msgId, `✅ <b>Task created!</b>\n\n📋 ${s0.title}\n🪙 ${s0.reward} Gold` + (s0.rewardFc ? ` + 🍎 ${s0.rewardFc} Fruit Coin` : ''), { reply_markup: backKb });
      } else if (data === 'task_confirm_cancel') {
        await clearAdminState(fromId);
        await edit(chatId, msgId, '❌ Task creation cancelled.', { reply_markup: backKb });
      } else if (data === 'a_promo') {
        await edit(chatId, msgId, '🎟️ <b>Promo Codes</b>\n\nEach code is valid for exactly <b>24 hours</b> from creation, then it auto-expires and can no longer be claimed.', { reply_markup: promoMenuKb });
      } else if (data === 'a_promo_gen') {
        await setAdminState(fromId, { step: 'promo_gold' });
        await edit(chatId, msgId, '🎟️ <b>Generate Promo Code — Step 1/3</b>\n\nHow much <b>Gold</b> should this code give? (enter <code>0</code> for none):', { reply_markup: backKb });
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
            const rewardParts = [];
            if (c.rewardGold) rewardParts.push(`🪙 ${c.rewardGold.toLocaleString()} Gold`);
            if (c.rewardFc) rewardParts.push(`🍎 ${c.rewardFc.toLocaleString()} FC`);
            text_ += `<code>${c.code}</code> — ${rewardParts.join(' + ') || '0'}\nUsed: ${usesText} · Expires in ${minsLeft}m\n\n`;
          });
        }
        await edit(chatId, msgId, text_, { reply_markup: promoMenuKb });
      } else if (data === 'promo_confirm_save') {
        const s0 = await getAdminState(fromId);
        if (!s0 || s0.step !== 'promo_confirm') return res.status(200).json({ ok: true });
        await clearAdminState(fromId);
        const created = await createPromoCode({ rewardFc: s0.rewardFc, rewardGold: s0.rewardGold, maxUses: s0.maxUses, createdBy: fromId });
        const usesText = created.maxUses > 0 ? `${created.maxUses} user(s)` : 'Unlimited (until it expires)';
        const rewardParts = [];
        if (created.rewardGold) rewardParts.push(`🪙 <b>${created.rewardGold.toLocaleString()} Gold</b>`);
        if (created.rewardFc) rewardParts.push(`🍎 <b>${created.rewardFc.toLocaleString()} Fruit Coin</b>`);
        await edit(
          chatId, msgId,
          `✅ <b>Promo code created!</b>\n\n` +
            `🎟️ <code>${created.code}</code>\n` +
            `Reward: ${rewardParts.join(' + ') || 'none'}\n` +
            `👥 Uses: <b>${usesText}</b>\n` +
            `⏳ Expires: in 24 hours\n\n` +
            `Tap the code above to copy it, then share it with your users.`,
          { reply_markup: promoMenuKb }
        );
      } else if (data === 'promo_confirm_cancel') {
        await clearAdminState(fromId);
        await edit(chatId, msgId, '❌ Promo code creation cancelled.', { reply_markup: promoMenuKb });
      }
    } catch (err) {
      console.error('bot callback error:', err);
      await send(chatId, '⚠️ Something went wrong. Check server logs.', { reply_markup: backKb });
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
            `Slice fruits, earn Gold, and cash out real rewards!\n\n` +
            `Invite friends to earn bonus Game Tokens + Lottery Tokens instantly. 🚀`,
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
          const withdrawalsCol = await getCollection('withdrawals');
          const wdAgg = await withdrawalsCol
            .aggregate([
              { $match: { telegramId: user.telegramId, status: 'approved' } },
              { $group: { _id: null, totalFc: { $sum: '$amount' }, count: { $sum: 1 }, lastAt: { $max: '$processedAt' } } },
            ])
            .toArray();
          const wd = wdAgg[0] || { totalFc: 0, count: 0, lastAt: null };

          const daysAgo = (date) => {
            if (!date) return null;
            return Math.floor((Date.now() - new Date(date).getTime()) / (24 * 60 * 60 * 1000));
          };
          const joinedDays = daysAgo(user.joinedAt);
          const lastWithdrawDays = daysAgo(user.lastWithdrawAt);

          await send(
            chatId,
            `👤 <b>@${user.username || 'unknown'}</b>\n` +
              `ID: <code>${user.telegramId}</code>\n` +
              `🪙 Gold: <b>${user.gold || 0}</b>\n` +
              `🍎 Fruit Coin: <b>${user.fruitCoin || 0}</b>\n` +
              `🎮 Game Tokens: <b>${user.gameTokens ?? 3}</b>\n` +
              `🎰 Lottery Tokens: <b>${user.lotteryTokens || 0}</b>\n` +
              `📺 Total Ads Watched: <b>${user.totalAdsWatched || 0}</b>\n` +
              `👥 Referrals: <b>${user.referralCount || 0}</b>\n` +
              `📅 Joined: <b>${joinedDays !== null ? joinedDays + ' day(s) ago' : 'Unknown'}</b>\n` +
              `💸 Total Withdrawn: <b>${(wd.totalFc || 0).toLocaleString()} Fruit Coin</b> <i>(${wd.count || 0} approved)</i>\n` +
              `🕒 Last Withdraw: <b>${lastWithdrawDays !== null ? lastWithdrawDays + ' day(s) ago' : 'Never'}</b>\n` +
              `🚫 Banned: <b>${user.banned ? 'Yes' : 'No'}</b>`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    user.banned
                      ? { text: '✅ Unban', callback_data: `a_unban_${user.telegramId}` }
                      : { text: '🚫 Ban', callback_data: `a_ban_${user.telegramId}` },
                  ],
                  [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }],
                ],
              },
            }
          );
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
        await send(chatId, `📋 Channel: ✅ <code>${chatIdVal}</code>\n\n<b>Step 4/5</b> — How much <b>Gold</b> reward?`);
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'task_url') {
        await setAdminState(fromId, { ...s, step: 'task_reward', url: text });
        await send(chatId, `📋 Link: ✅ ${text}\n\n<b>Step 4/5</b> — How much <b>Gold</b> reward?`);
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'task_reward') {
        const reward = parseInt(text, 10);
        if (!reward || isNaN(reward) || reward <= 0) {
          await send(chatId, '❌ Enter a valid positive number:');
          return res.status(200).json({ ok: true });
        }
        await setAdminState(fromId, { ...s, step: 'task_rewardfc', reward });
        await send(chatId, `🪙 Gold reward: ✅ <b>${reward}</b>\n\n<b>Step 5/5</b> — Any <b>Fruit Coin</b> bonus? (enter a number, or <code>0</code> for none):`);
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'task_rewardfc') {
        const rewardFc = parseInt(text, 10);
        if (isNaN(rewardFc) || rewardFc < 0) {
          await send(chatId, '❌ Enter a valid number (0 or more):');
          return res.status(200).json({ ok: true });
        }
        const s1 = { ...s, step: 'task_confirm', rewardFc };
        await setAdminState(fromId, s1);
        const preview =
          `📋 <b>Task Preview</b>\n\n` +
          `Title: <b>${s1.title}</b>\n` +
          `Category: <b>${s1.category}</b>\n` +
          `Type: <b>${s1.type === 'api' ? 'Telegram Channel/Group (verified)' : 'Website/Other (trust-based)'}</b>\n` +
          (s1.chatId ? `Channel: <code>${s1.chatId}</code>\n` : `Link: ${s1.url || 'none'}\n`) +
          `Reward: <b>${s1.reward} Gold</b>` + (s1.rewardFc ? ` + <b>${s1.rewardFc} Fruit Coin</b>` : '') + `\n\n` +
          (s1.type === 'api' ? `⚠️ Make sure this bot is an admin in that channel/group, or verification will always fail!\n\n` : '');
        await send(chatId, preview, {
          reply_markup: { inline_keyboard: [[{ text: '✅ Confirm & Save', callback_data: 'task_confirm_save' }], [{ text: '❌ Cancel', callback_data: 'task_confirm_cancel' }]] },
        });
        return res.status(200).json({ ok: true });
      }

      // ── Generate Promo Code — gold → fruit coin → max uses → confirm ──
      if (s && s.step === 'promo_gold') {
        const gold = parseInt(text, 10);
        if (isNaN(gold) || gold < 0) {
          await send(chatId, '❌ Enter a valid number (0 or more):');
          return res.status(200).json({ ok: true });
        }
        await setAdminState(fromId, { step: 'promo_fc', rewardGold: gold });
        await send(chatId, `🪙 Gold: ✅ <b>${gold.toLocaleString()}</b>\n\n<b>Step 2/3</b> — How much <b>Fruit Coin</b> should this code give? (enter <code>0</code> for none):`);
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'promo_fc') {
        const fc = parseInt(text, 10);
        if (isNaN(fc) || fc < 0) {
          await send(chatId, '❌ Enter a valid number (0 or more):');
          return res.status(200).json({ ok: true });
        }
        if (fc <= 0 && !(s.rewardGold > 0)) {
          await send(chatId, '❌ The code needs at least some Gold or Fruit Coin reward. Enter a positive number:');
          return res.status(200).json({ ok: true });
        }
        await setAdminState(fromId, { ...s, step: 'promo_maxuses', rewardFc: fc });
        await send(chatId, `🍎 Fruit Coin: ✅ <b>${fc.toLocaleString()}</b>\n\n<b>Step 3/3</b> — How many users can claim this code? Send a number, or <code>0</code> for unlimited (anyone can claim until it expires in 24h):`);
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'promo_maxuses') {
        const maxUses = parseInt(text, 10);
        if (isNaN(maxUses) || maxUses < 0) {
          await send(chatId, '❌ Enter a valid number (0 or more):');
          return res.status(200).json({ ok: true });
        }
        await setAdminState(fromId, { ...s, step: 'promo_confirm', maxUses });
        const usesText = maxUses > 0 ? `${maxUses} user(s)` : 'Unlimited (until it expires)';
        const rewardParts = [];
        if (s.rewardGold) rewardParts.push(`🪙 <b>${s.rewardGold.toLocaleString()} Gold</b>`);
        if (s.rewardFc) rewardParts.push(`🍎 <b>${s.rewardFc.toLocaleString()} Fruit Coin</b>`);
        await send(
          chatId,
          `🎟️ <b>Promo Code Preview</b>\n\nReward: ${rewardParts.join(' + ') || 'none'}\n👥 Uses: <b>${usesText}</b>\n⏳ Expires: <b>24 hours</b> after creation\n\nReward is credited instantly on redeem; a random ad plays right after (for revenue only).`,
          { reply_markup: { inline_keyboard: [[{ text: '✅ Confirm & Generate', callback_data: 'promo_confirm_save' }], [{ text: '❌ Cancel', callback_data: 'promo_confirm_cancel' }]] } }
        );
        return res.status(200).json({ ok: true });
      }

    } catch (err) {
      console.error('bot message error:', err);
      await send(chatId, '⚠️ Something went wrong. Check server logs.', { reply_markup: backKb });
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({ ok: true });
};
