// api/withdraw_history.js
// Returns the calling user's own withdrawal requests (never other users').

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection } = require('../lib/db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false });
  }

  try {
    const initData = req.headers['x-telegram-init-data'] || '';
    const verify = verifyTelegramInitData(initData, process.env.BOT_TOKEN);
    if (!verify.valid) {
      return res.status(401).json({ success: false, status: 'invalid_auth' });
    }
    const telegramId = verify.user.id;

    const col = await getCollection('withdrawals');
    const history = await col.find({ telegramId }).sort({ createdAt: -1 }).limit(20).toArray();

    return res.status(200).json({
      success: true,
      history: history.map((w) => ({
        method: w.method,
        amount: w.amount,
        status: w.status,
        createdAt: w.createdAt,
      })),
    });
  } catch (err) {
    console.error('withdraw_history error:', err);
    return res.status(500).json({ success: false });
  }
};
