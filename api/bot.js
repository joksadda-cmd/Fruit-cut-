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

const ADMIN_ID = String(process.env.ADMIN_ID || '');
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = 'Fruit_cut_bot';       // update if your bot's @username differs
const MINI_APP_SHORTNAME = 'PlayTo_Earn';   // update if your Mini App short name differs
const MINI_APP_URL = `https://t.me/${BOT_USERNAME}/${MINI_APP_SHORTNAME}`;

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

const edit = (chatId, msgId, text, extra = {}) =>
  tgApi('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', ...extra });

const answer = (id, text = '') => tgApi('answerCallbackQuery', { callback_query_id: id, text });

const adminKb = {
  inline_keyboard: [
    [{ text: '📊 Dashboard', callback_data: 'a_stats' }, { text: '👤 User Lookup', callback_data: 'a_user' }],
    [{ text: '🏆 Top Referrers', callback_data: 'a_toprefer' }, { text: '📢 Broadcast', callback_data: 'a_broadcast' }],
  ],
};
const backKb = { inline_keyboard: [[{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] };

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
      } else if (data.startsWith('a_ban_')) {
        const targetId = data.replace('a_ban_', '');
        await users.updateOne({ telegramId: targetId }, { $set: { banned: true } });
        await send(chatId, `🚫 User <b>${targetId}</b> banned.`, { reply_markup: backKb });
      } else if (data.startsWith('a_unban_')) {
        const targetId = data.replace('a_unban_', '');
        await users.updateOne({ telegramId: targetId }, { $set: { banned: false } });
        await send(chatId, `✅ User <b>${targetId}</b> unbanned.`, { reply_markup: backKb });
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
        await send(
          chatId,
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
