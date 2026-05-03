const { db, admin } = require('./utils/firebase');

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { telegramId, reward, isAdWatched } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'Missing Telegram ID' });

    const userRef = db.collection('users').doc(String(telegramId));
    const doc = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });

    const userData = doc.data();

    // ── Token deduction ──────────────────────────────────────────────
    // Token was already decremented on frontend; here we sync to server.
    // We deduct 1 token (unless forceStart / ad play — in that case reward=0 skip deduct)
    let currentTokens = userData.tokens !== undefined ? userData.tokens : 0;

    // Only deduct if tokens > 0 (safety check — frontend already decremented visually)
    const tokenCost = 1;
    if (currentTokens >= tokenCost) {
        currentTokens -= tokenCost;
    }
    // If they somehow have 0 but are calling this (ad-play / forceStart), allow it
    if (currentTokens < 0) currentTokens = 0;

    // ── Reward calculation ───────────────────────────────────────────
    const baseReward = Number(reward) || 0;
    const finalReward = isAdWatched ? baseReward * 2 : baseReward;

    // ── Stage progression ────────────────────────────────────────────
    const newStage = (userData.stage || 1) + 1;

    // ── Hourly refill: set tokenRefill timestamp if token was at max and now it's not ──
    const now = Date.now();
    let tokenRefill = userData.tokenRefill || now;
    // If user was at MAX before, start the refill clock now
    if (userData.tokens >= 10 && currentTokens < 10) {
        tokenRefill = now;
    }

    const updates = {
        coins:       admin.firestore.FieldValue.increment(finalReward),
        gamesPlayed: admin.firestore.FieldValue.increment(1),
        stage:       newStage,
        tokens:      currentTokens,
        tokenRefill: tokenRefill,
    };

    await userRef.update(updates);
    const updated = await userRef.get();

    return res.status(200).json({ success: true, user: updated.data() });
}
