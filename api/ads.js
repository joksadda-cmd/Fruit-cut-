const { db, admin } = require('./utils/firebase');
const { verifyTelegramData } = require('./utils/verifyTelegram');

// Daily limits per ad type
const LIMITS = {
    adsgram:      5,
    adsgramDaily: 5,
    gigapub:      20,
    monetag:      20,
};

// Gold reward per ad type
const REWARDS = {
    adsgram:      250,
    adsgramDaily: 120,
    gigapub:      120,
    monetag:      120,
};

// Firestore field name for each action
const COUNT_FIELDS = {
    adsgram:      'adsgramCount',
    adsgramDaily: 'adsgramDailyCount',
    gigapub:      'gigapubCount',
    monetag:      'monetagCount',
};

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

    const { telegramId, action } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'Missing Telegram ID' });

    const userRef = db.collection('users').doc(String(telegramId));
    const doc     = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });

    const userData = doc.data();

    // ── Lootbox claim ─────────────────────────────────────────────────
    if (action === 'claim_lootbox') {
        const pts = userData.lootboxPoints || 0;
        if (pts < 500) return res.status(400).json({ error: 'Not enough points' });
        const goldReward = Math.floor(pts / 2);
        await userRef.update({
            coins:         admin.firestore.FieldValue.increment(goldReward),
            lootboxPoints: 0,
        });
        const updated = await userRef.get();
        return res.status(200).json({ success: true, user: updated.data() });
    }

    // ── Ad reward ─────────────────────────────────────────────────────
    const countField = COUNT_FIELDS[action];
    const limit      = LIMITS[action];
    const reward     = REWARDS[action];

    if (!countField || limit === undefined) {
        return res.status(400).json({ error: 'Unknown ad action' });
    }

    const currentCount = userData[countField] || 0;
    if (currentCount >= limit) {
        return res.status(400).json({ error: 'Daily limit reached' });
    }

    const updates = {
        [countField]:  currentCount + 1,
        coins:         admin.firestore.FieldValue.increment(reward),
        lootboxPoints: admin.firestore.FieldValue.increment(reward),
    };

    await userRef.update(updates);
    const updated = await userRef.get();
    return res.status(200).json({ success: true, user: updated.data() });
}
