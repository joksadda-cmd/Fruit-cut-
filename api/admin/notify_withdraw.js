const { db } = require('../../utils/firebase');

const RATES = {
    bkash:     { label: 'bKash',        sym: '৳', unit: 'BDT',  rate: 0.12    },
    binance:   { label: 'Binance USDT', sym: '$', unit: 'USDT', rate: 0.001   },
    tonkeeper: { label: 'TON Wallet',   sym: '',  unit: 'TON',  rate: 0.00075 },
};

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')   return res.status(405).end();

    const { secret, userId, action, amount, method, address } = req.body;

    // Verify admin secret
    if (!secret || secret !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const BOT_TOKEN = process.env.BOT_TOKEN;
    if (!BOT_TOKEN || !userId) {
        return res.status(400).json({ error: 'Missing config' });
    }

    const r    = RATES[method] || RATES.bkash;
    const conv = (Number(amount) * r.rate).toFixed(method === 'bkash' ? 2 : 4);

    let msg = '';
    if (action === 'approve') {
        msg = `✅ Withdrawal Approved!\n\n` +
              `💎 Amount: ${amount} Diamonds\n` +
              `💳 Method: ${r.label}\n` +
              `💵 Amount Sent: ${r.sym}${conv} ${r.unit}\n` +
              `📬 Address: ${address}\n\n` +
              `🎉 Your payment has been processed!\n` +
              `Thank you for playing Fruit Cut! 🍉`;
    } else {
        msg = `❌ Withdrawal Rejected\n\n` +
              `💎 Amount: ${amount} Diamonds\n` +
              `💳 Method: ${r.label}\n\n` +
              `♻️ Your ${amount} Diamonds have been refunded.\n\n` +
              `If you have questions, contact support. 💬`;
    }

    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: userId,
                text:    msg,
                reply_markup: JSON.stringify({
                    inline_keyboard: [[{
                        text:    '🎮 Open Game',
                        web_app: { url: 'https://fruit-cut-eight.vercel.app' }
                    }]]
                })
            })
        });
        return res.status(200).json({ success: true });
    } catch(e) {
        return res.status(500).json({ error: e.message });
    }
};
