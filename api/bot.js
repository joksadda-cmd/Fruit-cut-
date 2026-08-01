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

// Hides the middle of an address for the public payment-channel post
// (e.g. "TXn9...k82Q"), while the user themselves still gets it in full
// in their own private notification.
function maskAddress(address) {
  const a = String(address || '');
  if (a.length <= 8) return a[0] + '***' + a[a.length - 1];
  return a.slice(0, 4) + '••••' + a.slice(-4);
}

// Per-admin multi-step input state (in-memory). Fine for a single admin;
// if you ever add a second admin, move this to Mongo (a tiny "admin conversational state" doc).
const state = {};

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

const adminKb = {
  inline_keyboard: [
    [{ text: '📊 Dashboard', callback_data: 'a_stats' }, { text: '👤 User Lookup', callback_data: 'a_user' }],
    [{ text: '🏆 Top Referrers', callback_data: 'a_toprefer' }, { text: '📢 Broadcast', callback_data: 'a_broadcast' }],
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
  const users = await getCollection('users');

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
      } else if (data === 'a_toprefer') {
        const top = await users.find({ referralCount: { $gt: 0 } }).sort({ referralCount: -1 }).limit(10).toArray();
        let text = '🏆 <b>Top Referrers</b>\n\n';
        if (!top.length) text += 'No referrals yet.';
        top.forEach((u, i) => {
          text += `${i + 1}. @${u.username || 'unknown'} — <b>${u.referralCount}</b> refers\n`;
        });
        await edit(chatId, msgId, text, { reply_markup: backKb });
      } else if (data === 'a_user') {
        state[fromId] = { step: 'awaiting_user_lookup' };
        await edit(chatId, msgId, '👤 Send the Telegram ID or @username to look up:', { reply_markup: backKb });
      } else if (data === 'a_broadcast') {
        state[fromId] = { step: 'awaiting_broadcast' };
        await edit(chatId, msgId, '📢 Send the message text to broadcast to all users:', { reply_markup: backKb });
      } else if (data === 'a_sendfc') {
        state[fromId] = { step: 'sendfc_id' };
        await edit(chatId, msgId, '💰 Send the <b>Telegram ID</b> of who you want to send Fruit Coin to:', { reply_markup: backKb });
      } else if (data === 'a_sendgift') {
        state[fromId] = { step: 'gift_reason' };
        await edit(
          chatId, msgId,
          "🎁 <b>Send Gift — Step 1/3</b>\n\nWhat's the reason for this gift? (the user will see this reason when they open the app)",
          { reply_markup: backKb }
        );
      } else if (data === 'gift_confirm') {
        const gs = state[fromId];
        if (!gs || gs.step !== 'gift_confirm') return res.status(200).json({ ok: true });
        delete state[fromId];
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
        delete state[fromId];
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
        state[fromId] = { step: 'task_category' };
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
        state[fromId] = { step: 'task_title', category };
        await edit(chatId, msgId, `📋 Category: ✅ <b>${category}</b>\n\nNow send the task <b>title</b>:`, { reply_markup: backKb });
      } else if (data === 'task_type_api') {
        const s0 = state[fromId];
        if (!s0 || s0.step !== 'task_type') return res.status(200).json({ ok: true });
        state[fromId] = { ...s0, step: 'task_chatid', type: 'api' };
        await edit(chatId, msgId, `📋 Type: ✅ <b>Telegram Channel/Group (auto-verified)</b>\n\nSend the channel/group <b>@username</b>\n(⚠️ this bot must be an admin there to verify membership):`, { reply_markup: backKb });
      } else if (data === 'task_type_nonapi') {
        const s0 = state[fromId];
        if (!s0 || s0.step !== 'task_type') return res.status(200).json({ ok: true });
        state[fromId] = { ...s0, step: 'task_url', type: 'nonapi' };
        await edit(chatId, msgId, `📋 Type: ✅ <b>Website / Other Bot / Social (trust-based)</b>\n\nSend the <b>link</b> to open for this task:`, { reply_markup: backKb });
      } else if (data === 'task_confirm_save') {
        const s0 = state[fromId];
        if (!s0 || s0.step !== 'task_confirm') return res.status(200).json({ ok: true });
        delete state[fromId];
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
        delete state[fromId];
        await edit(chatId, msgId, '❌ Task creation cancelled.', { reply_markup: backKb });
      } else if (data === 'a_promo') {
        await edit(chatId, msgId, '🎟️ <b>Promo Codes</b>\n\nEach code is valid for exactly <b>24 hours</b> from creation, then it auto-expires and can no longer be claimed.', { reply_markup: promoMenuKb });
      } else if (data === 'a_promo_gen') {
        state[fromId] = { step: 'promo_reward' };
        await edit(chatId, msgId, '🎟️ <b>Generate Promo Code — Step 1/2</b>\n\nHow much <b>Fruit Coin</b> should this code give?', { reply_markup: backKb });
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
            text_ += `<code>${c.code}</code> — 🍎 ${c.rewardFc.toLocaleString()} FC\nUsed: ${usesText} · Expires in ${minsLeft}m\n\n`;
          });
        }
        await edit(chatId, msgId, text_, { reply_markup: promoMenuKb });
      } else if (data === 'promo_confirm_save') {
        const s0 = state[fromId];
        if (!s0 || s0.step !== 'promo_confirm') return res.status(200).json({ ok: true });
        delete state[fromId];
        const created = await createPromoCode({ rewardFc: s0.rewardFc, maxUses: s0.maxUses, createdBy: fromId });
        const usesText = created.maxUses > 0 ? `${created.maxUses} user(s)` : 'Unlimited (until it expires)';
        await edit(
          chatId, msgId,
          `✅ <b>Promo code created!</b>\n\n` +
            `🎟️ <code>${created.code}</code>\n` +
            `🍎 Reward: <b>${created.rewardFc.toLocaleString()} Fruit Coin</b>\n` +
            `👥 Uses: <b>${usesText}</b>\n` +
            `⏳ Expires: in 24 hours\n\n` +
            `Tap the code above to copy it, then share it with your users.`,
          { reply_markup: promoMenuKb }
        );
      } else if (data === 'promo_confirm_cancel') {
        delete state[fromId];
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

      const s = state[fromId];

      if (s && s.step === 'awaiting_user_lookup') {
        delete state[fromId];
        const query = text.replace('@', '');
        const user = (await findUserByTelegramId(users, query)) || (await users.findOne({ username: query }));
        if (!user) {
          await send(chatId, '❌ User not found.', { reply_markup: backKb });
        } else {
          await send(
            chatId,
            `👤 <b>@${user.username || 'unknown'}</b>\n` +
              `ID: <code>${user.telegramId}</code>\n` +
              `🪙 Gold: <b>${user.gold || 0}</b>\n` +
              `🍎 Fruit Coin: <b>${user.fruitCoin || 0}</b>\n` +
              `🎮 Game Tokens: <b>${user.gameTokens ?? 3}</b>\n` +
              `🎰 Lottery Tokens: <b>${user.lotteryTokens || 0}</b>\n` +
              `👥 Referrals: <b>${user.referralCount || 0}</b>\n` +
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
        state[fromId] = { step: 'sendfc_amount', targetId: user.telegramId };
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
        delete state[fromId];
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
        state[fromId] = { step: 'gift_target', reason: text };
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
        state[fromId] = { ...s, step: 'gift_amount', targetId: target.telegramId, targetUsername: target.username || 'unknown' };
        await send(chatId, `👤 Found: <code>${target.telegramId}</code> (@${target.username || 'unknown'})\n\n🎁 <b>Send Gift — Step 3/3</b>\n\nHow much <b>Fruit Coin</b> do you want to gift?`, { reply_markup: backKb });
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'gift_amount') {
        const amt = parseInt(text, 10);
        if (!amt || isNaN(amt) || amt <= 0) {
          await send(chatId, '❌ Enter a valid positive number:');
          return res.status(200).json({ ok: true });
        }
        state[fromId] = { ...s, step: 'gift_confirm', amount: amt };
        await send(
          chatId,
          `🎁 <b>Gift Preview</b>\n\n👤 <code>${s.targetId}</code> (@${s.targetUsername})\n🍎 <b>${amt.toLocaleString()} Fruit Coin</b>\n📝 ${s.reason}\n\nConfirming this will show an animated gift-box as soon as the user opens the app.`,
          { reply_markup: { inline_keyboard: [[{ text: '✅ Confirm & Send', callback_data: 'gift_confirm' }], [{ text: '❌ Cancel', callback_data: 'gift_cancel' }]] } }
        );
        return res.status(200).json({ ok: true });
      }

      // ── Add Task — title → type → chatid/url → reward → rewardFc → confirm ──
      if (s && s.step === 'task_title') {
        state[fromId] = { ...s, step: 'task_type', title: text };
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
        state[fromId] = { ...s, step: 'task_reward', chatId: chatIdVal };
        await send(chatId, `📋 Channel: ✅ <code>${chatIdVal}</code>\n\n<b>Step 4/5</b> — How much <b>Gold</b> reward?`);
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'task_url') {
        state[fromId] = { ...s, step: 'task_reward', url: text };
        await send(chatId, `📋 Link: ✅ ${text}\n\n<b>Step 4/5</b> — How much <b>Gold</b> reward?`);
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'task_reward') {
        const reward = parseInt(text, 10);
        if (!reward || isNaN(reward) || reward <= 0) {
          await send(chatId, '❌ Enter a valid positive number:');
          return res.status(200).json({ ok: true });
        }
        state[fromId] = { ...s, step: 'task_rewardfc', reward };
        await send(chatId, `🪙 Gold reward: ✅ <b>${reward}</b>\n\n<b>Step 5/5</b> — Any <b>Fruit Coin</b> bonus? (enter a number, or <code>0</code> for none):`);
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'task_rewardfc') {
        const rewardFc = parseInt(text, 10);
        if (isNaN(rewardFc) || rewardFc < 0) {
          await send(chatId, '❌ Enter a valid number (0 or more):');
          return res.status(200).json({ ok: true });
        }
        state[fromId] = { ...s, step: 'task_confirm', rewardFc };
        const s1 = state[fromId];
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

      // ── Generate Promo Code — reward amount → max uses → confirm ──
      if (s && s.step === 'promo_reward') {
        const reward = parseInt(text, 10);
        if (!reward || isNaN(reward) || reward <= 0) {
          await send(chatId, '❌ Enter a valid positive number:');
          return res.status(200).json({ ok: true });
        }
        state[fromId] = { step: 'promo_maxuses', rewardFc: reward };
        await send(chatId, `🍎 Reward: ✅ <b>${reward.toLocaleString()} Fruit Coin</b>\n\n<b>Step 2/2</b> — How many users can claim this code? Send a number, or <code>0</code> for unlimited (anyone can claim until it expires in 24h):`);
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'promo_maxuses') {
        const maxUses = parseInt(text, 10);
        if (isNaN(maxUses) || maxUses < 0) {
          await send(chatId, '❌ Enter a valid number (0 or more):');
          return res.status(200).json({ ok: true });
        }
        state[fromId] = { ...s, step: 'promo_confirm', maxUses };
        const usesText = maxUses > 0 ? `${maxUses} user(s)` : 'Unlimited (until it expires)';
        await send(
          chatId,
          `🎟️ <b>Promo Code Preview</b>\n\n🍎 Reward: <b>${s.rewardFc.toLocaleString()} Fruit Coin</b>\n👥 Uses: <b>${usesText}</b>\n⏳ Expires: <b>24 hours</b> after creation\n\nUsers will watch one random ad before the code credits their balance.`,
          { reply_markup: { inline_keyboard: [[{ text: '✅ Confirm & Generate', callback_data: 'promo_confirm_save' }], [{ text: '❌ Cancel', callback_data: 'promo_confirm_cancel' }]] } }
        );
        return res.status(200).json({ ok: true });
      }

      if (s && s.step === 'awaiting_broadcast') {
        delete state[fromId];
        const all = await users.find({}, { projection: { telegramId: 1 } }).toArray();
        await send(chatId, `📢 Broadcasting to <b>${all.length}</b> users...`);
        let sent = 0;
        let failed = 0;
        for (const u of all) {
          try {
            await send(u.telegramId, `📢 <b>Fruit Cut Update</b>\n\n${text}`);
            sent++;
          } catch {
            failed++;
          }
          await new Promise((r) => setTimeout(r, 50)); // stay under Telegram's rate limit
        }
        await send(chatId, `✅ Done! Sent: <b>${sent}</b> | Failed: <b>${failed}</b>`, { reply_markup: adminKb });
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
