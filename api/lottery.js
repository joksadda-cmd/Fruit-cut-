const { db, admin } = require('./utils/firebase');
const crypto = require('crypto');

const MAX_TOKENS = 10;

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

    const { telegramId, prizeType, prizeVal, usedToken } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'Missing Telegram ID' });

    const userRef = db.collection('users').doc(String(telegramId));
    const doc     = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });

    const userData = doc.data();

    // ── Spin eligibility ──────────────────────────────────────────────
    if (usedToken) {
        if ((userData.lotteryTokens || 0) <= 0) {
            return res.status(400).json({ error: 'No lottery tokens' });
        }
    } else {
        if ((userData.lotteryDailySpins || 0) >= 10) {
            return res.status(400).json({ error: 'Daily ad spin limit reached (10/day)' });
        }
    }

    const updates = {
        lotteryTotalSpins: admin.firestore.FieldValue.increment(1),
    };
    if (usedToken) {
        updates.lotteryTokens = admin.firestore.FieldValue.increment(-1);
    } else {
        updates.lotteryDailySpins = admin.firestore.FieldValue.increment(1);
    }

    const val = Number(prizeVal) || 0;

    if (prizeType === 'coin') {
        updates.coins = admin.firestore.FieldValue.increment(val);
    } else if (prizeType === 'diamond') {
        // Fractional diamond support (e.g. 0.3 + 0.3 + 0.4 = 1 full diamond)
        const curFrac   = userData.gemsFraction || 0;
        const newFrac   = curFrac + val;
        const whole     = Math.floor(newFrac);
        updates.gems         = admin.firestore.FieldValue.increment(whole);
        updates.gemsFraction = newFrac - whole;
        updates.lotteryDiamondsEarned = admin.firestore.FieldValue.increment(val);
    } else if (prizeType === 'token') {
        // Game token — capped at MAX_TOKENS
        const newTok = Math.min(MAX_TOKENS, (userData.tokens || 0) + val);
        updates.tokens = newTok;
    } else if (prizeType === 'lottoken' || prizeType === 'freespin') {
        updates.lotteryTokens = admin.firestore.FieldValue.increment(1);
    }

    await userRef.update(updates);
    return res.status(200).json({ success: true, user: (await userRef.get()).data() });
};
