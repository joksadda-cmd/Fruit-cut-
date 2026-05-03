const { db, admin } = require('./utils/firebase');
const { verifyTelegramData } = require('./utils/verifyTelegram');

const MAX_TOKENS   = 10;
const MIN_REWARD   = 40;    // minimum gold per game (matches frontend)
const MAX_REWARD   = 120;   // maximum gold per game (matches frontend)

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

    const { telegramId, reward, isAdWatched } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'Missing Telegram ID' });

    const userRef = db.collection('users').doc(String(telegramId));
    const doc     = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });

    const userData = doc.data();
    const now      = Date.now();

    // ── Validate reward amount server-side ────────────────────────────
    // Client sends the reward; we clamp it to prevent cheating
    let baseReward = Number(reward) || 0;
    baseReward = Math.max(MIN_REWARD, Math.min(MAX_REWARD, baseReward));

    // Double if ad was watched
    const finalReward = isAdWatched ? baseReward * 2 : baseReward;

    // ── Token deduction ───────────────────────────────────────────────
    let curTokens  = userData.tokens !== undefined ? userData.tokens : 0;
    let tokenRefill = userData.tokenRefill || now;

    // Deduct 1 token (forceStart / ad plays also call this — still deduct)
    if (curTokens > 0) {
        curTokens -= 1;
        // If this brings them below MAX, start the refill clock
        if (curTokens < MAX_TOKENS) {
            tokenRefill = now;
        }
    }
    if (curTokens < 0) curTokens = 0;

    // ── Stage progression ─────────────────────────────────────────────
    const newStage = (userData.stage || 1) + 1;

    const updates = {
        coins:        admin.firestore.FieldValue.increment(finalReward),
        gamesPlayed:  admin.firestore.FieldValue.increment(1),
        stage:        newStage,
        tokens:       curTokens,
        tokenRefill:  tokenRefill,
    };

    await userRef.update(updates);
    const updated = await userRef.get();

    return res.status(200).json({ success: true, user: updated.data() });
}
