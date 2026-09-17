// api/checkJoin.js
// POST /api/checkJoin
// Verifies the user has joined the mandatory Official Channel + Community
// Group. Called on every app open (blocks the menu behind a join-gate
// until satisfied) and again when the user taps "I've Joined — Verify".

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { checkChannelMembership } = require('../lib/joinGate');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const initData = req.headers['x-telegram-init-data'] || '';
  const verify = verifyTelegramInitData(initData, process.env.BOT_TOKEN);
  if (!verify.valid) {
    return res.status(401).json({ success: false, message: 'invalid_auth' });
  }
  const telegramId = verify.user.id;

  try {
    const channels = await checkChannelMembership(telegramId);
    const allJoined = channels.every((c) => c.joined);
    return res.status(200).json({ success: true, allJoined, channels });
  } catch (err) {
    console.error('checkJoin error:', err);
    return res.status(500).json({ success: false, message: 'server error' });
  }
};
