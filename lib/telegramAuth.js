// lib/telegramAuth.js
// Verifies Telegram WebApp initData using HMAC-SHA256 per Telegram's spec.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

const crypto = require('crypto');

function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return { valid: false, reason: 'missing_data' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { valid: false, reason: 'no_hash' };
  params.delete('hash');

  const dataCheckArr = [];
  for (const [key, value] of params.entries()) {
    dataCheckArr.push(`${key}=${value}`);
  }
  dataCheckArr.sort();
  const dataCheckString = dataCheckArr.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) {
    return { valid: false, reason: 'hash_mismatch' };
  }

  // Reject stale initData (older than 24h) — prevents replay of an old
  // captured initData string.
  const authDate = parseInt(params.get('auth_date'), 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!authDate || nowSeconds - authDate > 86400) {
    return { valid: false, reason: 'expired' };
  }

  let user = null;
  try {
    user = JSON.parse(params.get('user'));
  } catch (e) {
    return { valid: false, reason: 'bad_user_json' };
  }

  if (!user || !user.id) return { valid: false, reason: 'no_user_id' };

  // Normalize to String here — the ONE place this value is extracted —
  // so every file that consumes verify.user.id gets a consistent type,
  // instead of each api/*.js file re-deciding String vs Number.
  user.id = String(user.id);

  return { valid: true, user };
}

module.exports = { verifyTelegramInitData };
