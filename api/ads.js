const { db, admin } = require('./utils/firebase');
const crypto = require('crypto');

// ── Ad reward config ──────────────────────────────────────────────────────
const LIMITS  = { adsgram: 5, adsgramDaily: 5, gigapub: 20, monetag: 20 };
const REWARDS = { adsgram: 250, adsgramDaily: 120, gigapub: 120, monetag: 120 };
const FIELDS  = {
    adsgram:      'adsgramCount',
    adsgramDaily: 'adsgramDailyCount',
    gigapub:      'gigapubCount',
    monetag:      'monetagCount',
};

// ── Shop: Earn Game Token via Ads ────────────────────────────────────────
const AD_TOKEN_DAILY_LIMIT = 10;       // max 10 ads per day
const AD_TOKEN_FIELD       = 'shopAdTokenClaimed'; // stored on user doc

function verifyTelegram(initData, botToken) {
    if (!initData || !botToken) return false;
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return false;
        params.delete('hash');
        const checkStr = [...params.entries()]
            .sort(([a],[b]) => a.localeCompare(b))
            .map(([k,v]) => `${k}=${v}`)
            .join('\n');
        const secret = crypto.createHmac('sha256','WebAppData').update(botToken).digest();
        const expected = crypto.createHmac('sha256', secret).update(checkStr).digest('hex');
        return hash === expected;
    } catch(e) { return false; }
}

// ── Helper: today's date string (UTC) for daily reset ───────────────────
function todayStamp() {
    return new Date().toISOString().slice(0, 10); // "2026-05-15"
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

    const { telegramId, action, coinsToAdd } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'Missing Telegram ID' });

    const userRef = db.collection('users').doc(String(telegramId));
    const doc     = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });

    const userData = doc.data();
    const today    = todayStamp();

    // ────────────────────────────────────────────────────────────────────
    // 1. Lootbox claim
    // ────────────────────────────────────────────────────────────────────
    if (action === 'claim_lootbox') {
        const pts = userData.lootboxPoints || 0;
        if (pts < 500) return res.status(400).json({ error: 'Not enough points (need 500)' });
        const goldReward = Math.floor(pts / 2);
        await userRef.update({
            coins:         admin.firestore.FieldValue.increment(goldReward),
            lootboxPoints: 0,
        });
        return res.status(200).json({ success: true, user: (await userRef.get()).data() });
    }

    // ────────────────────────────────────────────────────────────────────
    // 2. Shop: Earn Game Token via Adsgram ad (max 10/day)
    // ────────────────────────────────────────────────────────────────────
    if (action === 'claim_game_token_by_ad') {
        // Daily reset: if adsDayStamp changed, reset counter
        const lastDay = userData.adsDayStamp || '';
        let claimed   = userData[AD_TOKEN_FIELD] || 0;

        if (lastDay !== today) {
            // New day — reset counter
            claimed = 0;
        }

        if (claimed >= AD_TOKEN_DAILY_LIMIT) {
            return res.status(400).json({ error: 'Daily token ad limit reached (10/10)' });
        }

        const newClaimed = claimed + 1;
        const newTokens  = Math.min(10, (userData.tokens ?? 0) + 1);

        await userRef.update({
            [AD_TOKEN_FIELD]: newClaimed,
            adsDayStamp:      today,
            tokens:           newTokens,
        });

        return res.status(200).json({ success: true, user: (await userRef.get()).data() });
    }

    // ────────────────────────────────────────────────────────────────────
    // 3. Regular ad rewards (adsgram, adsgramDaily, gigapub, monetag)
    // ────────────────────────────────────────────────────────────────────
    const field  = FIELDS[action];
    const limit  = LIMITS[action];
    const reward = REWARDS[action];
    if (!field) return res.status(400).json({ error: 'Unknown ad action' });

    // Daily reset for all ad counters
    const lastDay = userData.adsDayStamp || '';
    let count = userData[field] || 0;
    if (lastDay !== today) {
        // New day — reset this counter
        count = 0;
    }

    if (count >= limit) return res.status(400).json({ error: 'Daily limit reached' });

    await userRef.update({
        [field]:       count + 1,
        adsDayStamp:   today,
        coins:         admin.firestore.FieldValue.increment(reward),
        lootboxPoints: admin.firestore.FieldValue.increment(reward),
    });

    return res.status(200).json({ success: true, user: (await userRef.get()).data() });
};
