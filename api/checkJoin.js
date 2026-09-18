// api/checkJoin.js
const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { checkChannelMembership } = require('../lib/joinGate');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { checkReferralStep1 } = require('../lib/referral');

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
    const telegramId = verify.user.id;

    const channels = await checkChannelMembership(telegramId);
    const allJoined = channels.every((c) => c.joined);

    if (allJoined) {
      const usersCol = await getCollection('users');
      const user = await findUserByTelegramId(usersCol, telegramId);
      if (user && user.referredBy && !user.referStep1Given) {
        checkReferralStep1(user).catch(() => {});
      }
    }

    return res.status(200).json({ success: true, allJoined, channels });
  } catch (err) {
    console.error('checkJoin error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
