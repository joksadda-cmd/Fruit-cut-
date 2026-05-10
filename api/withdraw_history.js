const { db } = require('./utils/firebase');
const crypto  = require('crypto');

const RATES = {
    bkash:     { label:'bKash',        sym:'৳', unit:'BDT',  rate:0.12    },
    binance:   { label:'Binance USDT', sym:'$', unit:'USDT', rate:0.001   },
    tonkeeper: { label:'TON Wallet',   sym:'',  unit:'TON',  rate:0.00075 },
};

function verifyTelegram(initData, botToken) {
    if (!initData || !botToken) return false;
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return false;
        params.delete('hash');
        const checkStr = [...params.entries()]
            .sort(([a],[b]) => a.localeCompare(b))
            .map(([k,v]) => `${k}=${v}`).join('\n');
        const secret   = crypto.createHmac('sha256','WebAppData').update(botToken).digest();
        const expected = crypto.createHmac('sha256', secret).update(checkStr).digest('hex');
        return hash === expected;
    } catch(e) { return false; }
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-telegram-init-data');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')   return res.status(405).json({ success: false });

    const BOT_TOKEN = process.env.BOT_TOKEN || '';
    const { action, telegramId, secret, userId, amount, method, address } = req.body;

    // ── Action: notify_withdraw (called from admin panel) ─────────────
    if (action === 'notify') {
        // Verify admin secret
        if (!secret || secret !== process.env.ADMIN_SECRET) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        if (!BOT_TOKEN || !userId) {
            return res.status(400).json({ error: 'Missing config' });
        }

        const r    = RATES[method] || RATES.bkash;
        const conv = (Number(amount) * r.rate).toFixed(method === 'bkash' ? 2 : 4);
        const isApprove = req.body.wdAction === 'approve';

        const msg = isApprove
            ? `✅ Withdrawal Approved!\n\n💎 Amount: ${amount} Diamonds\n💳 Method: ${r.label}\n💵 Amount Sent: ${r.sym}${conv} ${r.unit}\n📬 Address: ${address}\n\n🎉 Your payment has been processed!\nThank you for playing Fruit Cut! 🍉`
            : `❌ Withdrawal Rejected\n\n💎 Amount: ${amount} Diamonds\n💳 Method: ${r.label}\n\n♻️ Your ${amount} Diamonds have been refunded.\n\nIf you have questions, contact support. 💬`;

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
    }

    // ── Action: history (called from mini app) ────────────────────────
    const initData = req.headers['x-telegram-init-data'] || '';
    if (BOT_TOKEN && initData && !verifyTelegram(initData, BOT_TOKEN)) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    if (!telegramId) return res.status(400).json({ success: false, error: 'Missing ID' });

    try {
        const snap = await db.collection('withdrawals')
            .where('userId', '==', String(telegramId))
            .limit(20)
            .get();

        const history = [];
        snap.forEach(d => history.push({ id: d.id, ...d.data() }));

        history.sort((a, b) => {
            const ta = a.requestedAt?._seconds || a.createdAt?._seconds || 0;
            const tb = b.requestedAt?._seconds || b.createdAt?._seconds || 0;
            return tb - ta;
        });

        return res.status(200).json({ success: true, history });
    } catch(e) {
        return res.status(500).json({ success: false, error: e.message });
    }
};
