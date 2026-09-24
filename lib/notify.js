// lib/notify.js
// Server-side only helper for pushing a Telegram message to a user.
// BOT_TOKEN never leaves the server — this must never be called from
// client-side code, only from api/*.js handlers.

const { getCollection } = require('./db');

async function sendTelegramMessage(chatId, text, extra = {}) {
  const token = process.env.BOT_TOKEN;
  if (!token || !chatId) return { ok: false, reason: 'missing_token_or_chatId' };

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
    });
    return await res.json();
  } catch (err) {
    console.error('sendTelegramMessage failed:', err);
    return { ok: false, error: String(err) };
  }
}

// Same ADMIN_ID lookup api/bot.js uses for its admin-only commands —
// centralized here so any backend file can flag something to the admin
// without re-reading the env vars itself.
function notifyAdmin(text, extra = {}) {
  const adminId = String(process.env.ADMIN_TELEGRAM_ID || process.env.ADMIN_ID || '');
  if (!adminId) return Promise.resolve({ ok: false, reason: 'no_admin_id' });
  return sendTelegramMessage(adminId, text, extra);
}

// Sends the same message to every non-banned user, in parallel batches
// (same safe pattern as the admin bot's manual broadcast in api/bot.js) —
// fast enough to finish well inside a serverless function's time limit
// even with a few thousand users, and stays under Telegram's rate limit.
async function broadcastToAllUsers(text, extra = {}) {
  const usersCol = await getCollection('users');
  const all = await usersCol.find({ banned: { $ne: true } }, { projection: { telegramId: 1 } }).toArray();

  const CHUNK_SIZE = 25;
  const CHUNK_DELAY_MS = 1050;
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < all.length; i += CHUNK_SIZE) {
    const chunk = all.slice(i, i + CHUNK_SIZE);
    const results = await Promise.allSettled(chunk.map((u) => sendTelegramMessage(u.telegramId, text, extra)));
    results.forEach((r) => (r.status === 'fulfilled' && r.value && r.value.ok !== false ? sent++ : failed++));
    if (i + CHUNK_SIZE < all.length) {
      await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
    }
  }

  return { sent, failed, total: all.length };
}

module.exports = { sendTelegramMessage, notifyAdmin, broadcastToAllUsers };
