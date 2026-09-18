// api/checkJoin.js
// Frontend calls this right after login, and again when the user taps
// "I've Joined — Verify". Blocks nothing by itself — index.html decides
// what to show based on the response.

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { checkChannelMembership } = require('../lib/joinGate');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const initData = req.headers['x-telegram-init-data'] || '';
    const verify = verifyTelegramInitData(initData, process.env.BOT_TOKEN);
    if (!verify.valid) {
      return res.status(401).json({ success: false, status: 'invalid_auth' });
    }

    const channels = await checkChannelMembership(verify.user.id);
    const allJoined = channels.every((c) => c.joined);

    return res.status(200).json({ success: true, allJoined, channels });
  } catch (err) {
    console.error('checkJoin error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
