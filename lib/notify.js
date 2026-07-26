// lib/notify.js
// Server-side only helper for pushing a Telegram message to a user.
// BOT_TOKEN never leaves the server — this must never be called from
// client-side code, only from api/*.js handlers.

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

module.exports = { sendTelegramMessage };
