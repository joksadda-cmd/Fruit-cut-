const { db, admin } = require('./utils/firebase');
const crypto = require('crypto');

const MAX_TOKENS       = 10;
const REFILL_MS        = 60 * 60 * 1000; // 1 hour
const MAX_DAILY_TOKENS = 24;

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

    // Security check — skip if BOT_TOKEN not set yet
    const BOT_TOKEN = process.env.BOT_TOKEN || '';
    const initData  = req.headers['x-telegram-init-data'] || '';
    if (BOT_TOKEN && initData && !verifyTelegram(initData, BOT_TOKEN)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { telegramId, username, referredBy } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'Missing Telegram ID' });

    const userRef = db.collection('users').doc(String(telegramId));
    const doc     = await userRef.get();
    const today   = new Date().toDateString();
    const now     = Date.now();
    let userData;

    if (!doc.exists) {
        // ── Refer reward ─────────────────────────────────────────────
        if (referredBy) {
            const refRef = db.collection('users').doc(String(referredBy));
            const refDoc = await refRef.get();
            if (refDoc.exists) {
                const rd = refDoc.data();
                // +1 game token capped at 10, +1 lottery token
                const newTok = Math.min(MAX_TOKENS, (rd.tokens || 0) + 1);
                await refRef.update({
                    referCount:    admin.firestore.FieldValue.increment(1),
                    tokens:        newTok,
                    lotteryTokens: admin.firestore.FieldValue.increment(1),
                });
            }
        }

        // ── New user ──────────────────────────────────────────────────
        userData = {
            telegramId: String(telegramId), username: username || 'unknown',
            coins: 0, gems: 0, gemsFraction: 0, stage: 1,
            tokens: 3, tokenRefill: now, tokensDailyGiven: 3, tokensDayStamp: today,
            referCode: `FC${telegramId}`, referCount: 0,
            referredBy: referredBy || null, validReferRewardGiven: false, referDiamonds: 0,
            adsDayStamp: today,
            adsgramCount: 0, adsgramDailyCount: 0, monetagCount: 0, gigapubCount: 0,
            lootboxPoints: 0, gamesPlayed: 0,
            lotteryDailySpins: 0, lotteryTotalSpins: 0, lotteryDiamondsEarned: 0, lotteryTokens: 0,
            shopTokenBought: 0, shopDiamondExchanged: 0,
            completedTasks: [],
        };
        await userRef.set(userData);

    } else {
        userData = doc.data();
        const updates = {};

        // ── Daily reset ───────────────────────────────────────────────
        if (userData.adsDayStamp !== today) {
            Object.assign(updates, {
                adsDayStamp: today,
                adsgramCount: 0, adsgramDailyCount: 0, monetagCount: 0, gigapubCount: 0,
                lotteryDailySpins: 0, shopTokenBought: 0, shopDiamondExchanged: 0,
                tokensDailyGiven: userData.tokens || 0, tokensDayStamp: today,
            });
        }

        // ── Hourly token refill: +1/hr, max 10, max 24/day ───────────
        let curTok     = userData.tokens          ?? 3;
        let lastRefill = userData.tokenRefill      || now;
        let dayStamp   = userData.tokensDayStamp   || today;
        let dailyGiven = userData.tokensDailyGiven || 0;

        if (dayStamp !== today) {
            dailyGiven = curTok;
            updates.tokensDayStamp   = today;
            updates.tokensDailyGiven = dailyGiven;
        }

        if (curTok < MAX_TOKENS) {
            const hrs   = Math.floor((now - lastRefill) / REFILL_MS);
            const allow = Math.max(0, MAX_DAILY_TOKENS - dailyGiven);
            const add   = Math.min(hrs, MAX_TOKENS - curTok, allow);
            if (add > 0) {
                curTok     += add;
                dailyGiven += add;
                updates.tokens           = curTok;
                updates.tokensDailyGiven = dailyGiven;
                updates.tokenRefill      = lastRefill + hrs * REFILL_MS;
            }
        } else {
            updates.tokenRefill = now; // reset clock when at max
        }

        if (Object.keys(updates).length > 0) {
            await userRef.update(updates);
            userData = (await userRef.get()).data();
        }
    }

    // ── Broadcast list ────────────────────────────────────────────────
    try {
        await db.collection('system').doc('broadcast_list').set(
            { ids: admin.firestore.FieldValue.arrayUnion(String(telegramId)) },
            { merge: true }
        );
    } catch(e) {}

    return res.status(200).json({ success: true, user: userData });
};
