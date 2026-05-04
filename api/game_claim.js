const { db, admin } = require('./utils/firebase');
const crypto = require('crypto');

const MAX_TOKENS = 10;
const MIN_REWARD = 40;
const MAX_REWARD = 240; // 120 * 2 (ad watched)

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

    const { telegramId, reward, isAdWatched } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'Missing Telegram ID' });

    const userRef = db.collection('users').doc(String(telegramId));
    const doc     = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });

    const userData = doc.data();
    const now      = Date.now();

    // ── Server-side reward validation (prevent cheating) ─────────────
    let baseReward = Math.max(MIN_REWARD, Math.min(120, Number(reward) || MIN_REWARD));
    const finalReward = isAdWatched ? baseReward * 2 : baseReward;

    // ── Token deduction ───────────────────────────────────────────────
    let curTok     = userData.tokens ?? 0;
    let tokenRefill = userData.tokenRefill || now;

    if (curTok > 0) {
        curTok -= 1;
        // Start refill clock when dropping below max
        if (curTok < MAX_TOKENS) tokenRefill = now;
    }
    if (curTok < 0) curTok = 0;

    const updates = {
        coins:        admin.firestore.FieldValue.increment(finalReward),
        gamesPlayed:  admin.firestore.FieldValue.increment(1),
        stage:        (userData.stage || 1) + 1,
        tokens:       curTok,
        tokenRefill:  tokenRefill,
    };

    await userRef.update(updates);
    const updated = await userRef.get();
    return res.status(200).json({ success: true, user: updated.data() });
};
