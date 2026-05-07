const { db } = require('./utils/firebase');
const crypto = require('crypto');

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
    const initData  = req.headers['x-telegram-init-data'] || '';
    if (BOT_TOKEN && initData && !verifyTelegram(initData, BOT_TOKEN)) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { telegramId } = req.body;
    if (!telegramId) return res.status(400).json({ success: false, error: 'Missing ID' });

    try {
        // No orderBy — avoids Firebase composite index requirement
        const snap = await db.collection('withdrawals')
            .where('userId', '==', String(telegramId))
            .limit(20)
            .get();

        const history = [];
        snap.forEach(d => history.push({ id: d.id, ...d.data() }));

        // Sort by requestedAt descending (client-side)
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
