const { db, admin } = require('./utils/firebase');
const { verifyTelegramData } = require('./utils/verifyTelegram');

const MAX_DAILY_AD_SPINS = 10;
const MAX_TOKENS         = 10;

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

    const { telegramId, prizeType, prizeVal, usedToken } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'Missing Telegram ID' });

    const userRef = db.collection('users').doc(String(telegramId));
    const doc     = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });

    const userData = doc.data();

    // ── Validate spin eligibility ─────────────────────────────────────
    if (usedToken) {
        const lotTokens = userData.lotteryTokens || 0;
        if (lotTokens <= 0) {
            return res.status(400).json({ error: 'No lottery tokens' });
        }
    } else {
        const dailySpins = userData.lotteryDailySpins || 0;
        if (dailySpins >= MAX_DAILY_AD_SPINS) {
            return res.status(400).json({ error: 'Daily ad spin limit reached' });
        }
    }

    // ── Build update ──────────────────────────────────────────────────
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
        updates.lotteryDiamondsEarned = userData.lotteryDiamondsEarned || 0; // no change
    } else if (prizeType === 'diamond') {
        // fractional diamonds stored as float — accumulate until >= 1
        const curGems   = userData.gems || 0;
        const curFrac   = userData.gemsFraction || 0;
        const newFrac   = curFrac + val;
        const wholePart = Math.floor(newFrac);
        updates.gems          = admin.firestore.FieldValue.increment(wholePart);
        updates.gemsFraction  = newFrac - wholePart;
        updates.lotteryDiamondsEarned = admin.firestore.FieldValue.increment(val);
    } else if (prizeType === 'token') {
        // Game token from lottery — capped at MAX_TOKENS
        const curTok  = userData.tokens || 0;
        const newTok  = Math.min(MAX_TOKENS, curTok + val);
        updates.tokens = newTok;
    } else if (prizeType === 'lottoken') {
        // Free lottery spin token
        updates.lotteryTokens = admin.firestore.FieldValue.increment(1);
    } else if (prizeType === 'freespin') {
        updates.lotteryTokens = admin.firestore.FieldValue.increment(1);
    }

    await userRef.update(updates);
    const updated = await userRef.get();
    return res.status(200).json({ success: true, user: updated.data() });
}
