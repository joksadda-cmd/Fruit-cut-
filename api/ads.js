const { db, admin } = require('./utils/firebase');
const crypto = require('crypto');

const LIMITS  = { adsgram: 5, adsgramDaily: 5, gigapub: 20, monetag: 20 };
const REWARDS = { adsgram: 250, adsgramDaily: 120, gigapub: 120, monetag: 120 };
const FIELDS  = { adsgram: 'adsgramCount', adsgramDaily: 'adsgramDailyCount', gigapub: 'gigapubCount', monetag: 'monetagCount' };

function verifyTelegram(initData, botToken) {
    if (!initData || !botToken) return false;
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return false;
        params.delete('hash');
        const checkStr = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
        const secret = crypto.createHmac('sha256','WebAppData').update(botToken).digest();
        const expected = crypto.createHmac('sha256', secret).update(checkStr).digest('hex');
        return hash === expected;
    } catch(e) { return false; }
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-telegram-init-data');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const BOT_TOKEN = process.env.BOT_TOKEN || '';
    const initData  = req.headers['x-telegram-init-data'] || '';
    if (BOT_TOKEN && initData && !verifyTelegram(initData, BOT_TOKEN)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { telegramId, action } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'Missing Telegram ID' });

    const userRef = db.collection('users').doc(String(telegramId));
    const doc     = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });

    const userData = doc.data();

    // ── Lootbox claim ─────────────────────────────────────────────────
    if (action === 'claim_lootbox') {
        const pts = userData.lootboxPoints || 0;
        if (pts < 500) return res.status(400).json({ error: 'Not enough points (need 500)' });
        const goldReward = Math.floor(pts / 2);
        await userRef.update({ coins: admin.firestore.FieldValue.increment(goldReward), lootboxPoints: 0 });
        return res.status(200).json({ success: true, user: (await userRef.get()).data() });
    }

    // ── Ad reward ─────────────────────────────────────────────────────
    const field  = FIELDS[action];
    const limit  = LIMITS[action];
    const reward = REWARDS[action];
    if (!field) return res.status(400).json({ error: 'Unknown ad action' });

    const count = userData[field] || 0;
    if (count >= limit) return res.status(400).json({ error: 'Daily limit reached' });

    await userRef.update({
        [field]:       count + 1,
        coins:         admin.firestore.FieldValue.increment(reward),
        lootboxPoints: admin.firestore.FieldValue.increment(reward),
    });
    return res.status(200).json({ success: true, user: (await userRef.get()).data() });
};
