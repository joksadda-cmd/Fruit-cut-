// lib/joinGate.js
// Checks whether a user has joined the required official channels before
// they're allowed to play. Uses Telegram's own getChatMember API — this
// ONLY works if the bot has been added as an ADMIN of each channel/group
// below (Telegram requires that for a bot to look up membership).

const CHANNELS = [
  { key: 'channel', label: 'Official Channel', handle: '@fruit_cut_play', url: 'https://t.me/fruit_cut_play' },
  { key: 'community', label: 'Official Community', handle: '@earn_fruit_Chat', url: 'https://t.me/earn_fruit_Chat' },
  { key: 'payment', label: 'Payment Channel', handle: '@fruit_cut_payment', url: 'https://t.me/fruit_cut_payment' },
];

// Any of these statuses count as "joined". 'left' and 'kicked' do not.
const JOINED_STATUSES = ['creator', 'administrator', 'member', 'restricted'];

async function checkChannelMembership(telegramId) {
  const token = process.env.BOT_TOKEN;
  const results = [];

  for (const ch of CHANNELS) {
    try {
      const url = `https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(ch.handle)}&user_id=${telegramId}`;
      const res = await fetch(url);
      const data = await res.json();
      const status = data && data.ok && data.result ? data.result.status : null;
      results.push({ key: ch.key, label: ch.label, url: ch.url, joined: JOINED_STATUSES.includes(status) });
    } catch (err) {
      console.error(`checkChannelMembership failed for ${ch.handle}:`, err);
      // Fail closed for THIS channel (treat as not-joined) rather than
      // crashing the whole check — one bad lookup shouldn't 500 everything.
      results.push({ key: ch.key, label: ch.label, url: ch.url, joined: false });
    }
  }

  return results;
}

module.exports = { CHANNELS, checkChannelMembership };
