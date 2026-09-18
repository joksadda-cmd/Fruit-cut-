// api/withdraw_history.js
// Returns the calling user's own withdrawal requests and summary totals

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
    const history = await col.find({ telegramId }).sort({ createdAt: -1 }).limit(30).toArray();

    let totalPendingFc = 0;
    let totalPendingUsdt = 0;
    let totalApprovedFc = 0;
    let totalApprovedUsdt = 0;

    const formatted = history.map((w) => {
      const amt = w.amount || 0;
      const converted = w.convertedAmount || Number((amt * 0.95 * 0.00002).toFixed(4));
      
      if (w.status === 'pending') {
        totalPendingFc += amt;
        totalPendingUsdt += converted;
      } else if (w.status === 'approved') {
        totalApprovedFc += amt;
        totalApprovedUsdt += converted;
      }

      return {
        method: w.method || 'tonkeeper',
        amount: amt,
        netFruitCoin: w.netFruitCoin || Math.round(amt * 0.95),
        convertedAmount: converted,
        address: w.address || '',
        status: w.status || 'pending',
        createdAt: w.createdAt,
      };
    });

    return res.status(200).json({
      success: true,
      totalPendingFc,
      totalPendingUsdt: Number(totalPendingUsdt.toFixed(4)),
      totalApprovedFc,
      totalApprovedUsdt: Number(totalApprovedUsdt.toFixed(4)),
      history: formatted,
    });
  } catch (err) {
    console.error('withdraw_history error:', err);
    return res.status(500).json({ success: false });
  }
};
