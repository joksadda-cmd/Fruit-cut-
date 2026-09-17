// lib/joinGate.js
// Mandatory join-gate: the user must be a member of BOTH the official
// channel and the community group before they can play / withdraw.
// (Only the public "payment channel" withdrawal-announcement feature was
// removed — this join requirement stays.)
//
// Uses Telegram Bot API's getChatMember to check real membership status
// server-side (never trust a client-reported "I've joined").

const REQUIRED_CHANNELS = [
  { key: 'channel',   label: 'Official Channel', chatId: '@fruit_cut_offcial', url: 'https://t.me/fruit_cut_offcial' },
  { key: 'community', label: 'Community Group',  chatId: '@fruit_cut_group',   url: 'https://t.me/fruit_cut_group' },
];

const JOINED_STATUSES = new Set(['member', 'administrator', 'creator']);

async function isMemberOf(chatId, telegramId, token) {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${telegramId}`
    );
    const data = await res.json();
    if (!data.ok) return false; // e.g. bot not admin, user never started, etc. — fail closed
    return JOINED_STATUSES.has(data.result?.status);
  } catch (err) {
    console.error(`joinGate: getChatMember failed for ${chatId}:`, err);
    return false; // fail closed on transient errors — checked again on next tap
  }
}

// Returns [{ key, label, url, joined }, ...] for every required channel.
async function checkChannelMembership(telegramId) {
  const token = process.env.BOT_TOKEN;
  const results = await Promise.all(
    REQUIRED_CHANNELS.map(async (ch) => ({
      ...ch,
      joined: token ? await isMemberOf(ch.chatId, telegramId, token) : false,
    }))
  );
  return results;
}

module.exports = { checkChannelMembership, REQUIRED_CHANNELS };
