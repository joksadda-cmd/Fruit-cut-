const { db, admin } = require('./utils/firebase');
const { verifyTelegramData } = require('./utils/verifyTelegram');

const MAX_TOKENS         = 10;
const TOKEN_COST_GOLD    = 50;   // 1 token = 50 gold
const GOLD_PER_DIAMOND   = 1000; // 1000 gold = 1 diamond
const MAX_DAILY_TOKENS_BUY = 10;
const MAX_EXCHANGE_GOLD  = 100000;
const MIN_EXCHANGE_GOLD  = 1000;

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-telegram-init-data');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')   return res.status(405).send('Method Not Allowed');

    // ── Security ─────────────────────────────────────────────────────
    const initData  = req.headers['x-telegram-init-data'] || '';
    const BOT_TOKEN = process.env.BOT_TOKEN || '';
    if (BOT_TOKEN && !verifyTelegramData(initData, BOT_TOKEN)) {
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
        const amount    = Number(qty) || 1;
        const cost      = amount * TOKEN_COST_GOLD;
        const curCoins  = userData.coins  || 0;
        const curTokens = userData.tokens || 0;
        const bought    = userData.shopTokenBought || 0;

        if (bought + amount > MAX_DAILY_TOKENS_BUY) {
            return res.status(400).json({ error: 'Daily purchase limit reached (10/day)' });
        }
        if (curCoins < cost) {
            return res.status(400).json({ error: `Not enough Gold (need ${cost})` });
        }

        // Cap: tokens cannot exceed MAX_TOKENS
        const newTokens = Math.min(MAX_TOKENS, curTokens + amount);

        await userRef.update({
            coins:            curCoins - cost,
            tokens:           newTokens,
            shopTokenBought:  admin.firestore.FieldValue.increment(amount),
        });
        const updated = await userRef.get();
        return res.status(200).json({ success: true, user: updated.data() });
    }

    // ── Gold → Diamond Exchange ───────────────────────────────────────
    if (type === 'gold_to_diamond') {
        const gold     = Number(goldAmount) || 0;
        const curCoins = userData.coins || 0;

        if (gold < MIN_EXCHANGE_GOLD) {
            return res.status(400).json({ error: `Minimum ${MIN_EXCHANGE_GOLD} Gold` });
        }
        if (gold > MAX_EXCHANGE_GOLD) {
            return res.status(400).json({ error: `Maximum ${MAX_EXCHANGE_GOLD} Gold per exchange` });
        }
        if (curCoins < gold) {
            return res.status(400).json({ error: 'Not enough Gold' });
        }

        const diamonds = Math.floor(gold / GOLD_PER_DIAMOND);

        await userRef.update({
            coins:               curCoins - gold,
            gems:                admin.firestore.FieldValue.increment(diamonds),
            shopDiamondExchanged: admin.firestore.FieldValue.increment(diamonds),
        });
        const updated = await userRef.get();
        return res.status(200).json({ success: true, user: updated.data() });
    }

    return res.status(400).json({ error: 'Unknown shop action' });
}
