// lib/joinGate.js
// Checks whether a user has joined the required official channels before
// they're allowed to play. Uses Telegram's own getChatMember API — this
// ONLY works if the bot has been added as an ADMIN of each channel/group
// below (Telegram requires that for a bot to look up membership).

const CHANNELS = [
  { key: 'channel', label: 'Official Channel', handle: '@fruit_cut_offcial', url: 'https://t.me/fruit_cut_offcial' },
  { key: 'community', label: 'Official Community', handle: '@fruit_cut_group', url: 'https://t.me/fruit_cut_group' },
];

// Any of these statuses count as "joined". 'left' and 'kicked' do not.
const JOINED_STATUSES = ['creator', 'administrator', 'member', 'restricted'];

async function checkChannelMembership(telegramId) {
  const token = process.env.BOT_TOKEN;

  return Promise.all(
    CHANNELS.map(async (ch) => {
      try {
        const url = `https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(ch.handle)}&user_id=${telegramId}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const data = await res.json();
        const status = data && data.ok && data.result ? data.result.status : null;
        return { key: ch.key, label: ch.label, url: ch.url, joined: JOINED_STATUSES.includes(status) };
      } catch (err) {
        console.error(`checkChannelMembership failed for ${ch.handle}:`, err);
        return { key: ch.key, label: ch.label, url: ch.url, joined: false };
      }
    })
  );
}

module.exports = { CHANNELS, checkChannelMembership };
