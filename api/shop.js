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

    const { telegramId, type, qty, goldAmount } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'Missing Telegram ID' });

    const userRef = db.collection('users').doc(String(telegramId));
    const doc     = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });

    const userData = doc.data();

    // ── Buy Game Tokens with Gold ─────────────────────────────────────
    if (type === 'token') {
        const amount   = Number(qty) || 1;
        const cost     = amount * 50; // 50 gold per token
        const curCoins = userData.coins  || 0;
        const curTok   = userData.tokens || 0;
        const bought   = userData.shopTokenBought || 0;

        if (bought + amount > 10) return res.status(400).json({ error: 'Daily buy limit: 10 tokens/day' });
        if (curCoins < cost)      return res.status(400).json({ error: `Need ${cost} Gold` });

        const newTok = Math.min(MAX_TOKENS, curTok + amount); // cap at 10

        await userRef.update({
            coins:           curCoins - cost,
            tokens:          newTok,
            shopTokenBought: admin.firestore.FieldValue.increment(amount),
        });
        return res.status(200).json({ success: true, user: (await userRef.get()).data() });
    }

    // ── Gold → Diamond Exchange ───────────────────────────────────────
    if (type === 'gold_to_diamond') {
        const gold     = Number(goldAmount) || 0;
        const curCoins = userData.coins || 0;

        if (gold < 1000)     return res.status(400).json({ error: 'Minimum 1,000 Gold' });
        if (gold > 100000)   return res.status(400).json({ error: 'Maximum 100,000 Gold per exchange' });
        if (curCoins < gold) return res.status(400).json({ error: 'Not enough Gold' });

        const diamonds = Math.floor(gold / 1000);
        await userRef.update({
            coins:                curCoins - gold,
            gems:                 admin.firestore.FieldValue.increment(diamonds),
            shopDiamondExchanged: admin.firestore.FieldValue.increment(diamonds),
        });
        return res.status(200).json({ success: true, user: (await userRef.get()).data() });
    }

    return res.status(400).json({ error: 'Unknown shop action' });
};
