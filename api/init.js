const { db, admin } = require('./utils/firebase');

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { telegramId, username, referredBy, syncOnly } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'Missing Telegram ID' });

    const userRef = db.collection('users').doc(String(telegramId));
    const doc = await userRef.get();

    let userData;
    const today = new Date().toDateString();
    const now = Date.now();

    if (!doc.exists) {
        // New user
        if (referredBy) {
            const refUser = db.collection('users').doc(String(referredBy));
            await refUser.update({
                referCount: admin.firestore.FieldValue.increment(1),
                tokens: admin.firestore.FieldValue.increment(1)
            }).catch(() => {});
        }

        userData = {
            telegramId: String(telegramId),
            username: username || 'unknown',
            coins: 0, gems: 0, stage: 1,
            tokens: 3,                      // Start with 3 tokens
            tokenRefill: now,               // Refill timer starts now
            tokensDailyGiven: 3,            // Track how many given today
            tokensDayStamp: today,
            referCode: `FC${telegramId}`,
            referCount: 0,
            referredBy: referredBy || null,
            adsDayStamp: today,
            adsgramCount: 0, adsgramDailyCount: 0, monetagCount: 0, gigapubCount: 0,
            lootboxPoints: 0, gamesPlayed: 0, lotteryDailySpins: 0,
            lotteryTokens: 0, lotteryTotalSpins: 0, lotteryDiamondsEarned: 0,
            shopTokenBought: 0, shopDiamondExchanged: 0,
            completedTasks: [], referDiamonds: 0,
            validReferRewardGiven: false
        };
        await userRef.set(userData);

    } else {
        userData = doc.data();
        const updates = {};

        // ── Daily reset ──────────────────────────────────────────────
        if (userData.adsDayStamp !== today) {
            updates.adsDayStamp       = today;
            updates.adsgramCount      = 0;
            updates.adsgramDailyCount = 0;
            updates.monetagCount      = 0;
            updates.gigapubCount      = 0;
            updates.lotteryDailySpins = 0;
            updates.shopTokenBought   = 0;
            updates.shopDiamondExchanged = 0;
            updates.tokensDailyGiven  = userData.tokens || 0; // reset daily counter
            updates.tokensDayStamp    = today;
        }

        // ── Hourly token refill: +1 per hour, max 10 ─────────────────
        // User gets 24 tokens per day (1 per hour × 24 hours)
        // But max held at once = 10
        const MAX_TOKENS = 10;
        const REFILL_INTERVAL = 60 * 60 * 1000; // 1 hour in ms

        let currentTokens = userData.tokens !== undefined ? userData.tokens : 3;
        let lastRefill     = userData.tokenRefill || now;
        let dailyGiven     = userData.tokensDailyGiven || 0;
        let dayStamp       = userData.tokensDayStamp || today;

        // Reset daily counter on new day
        if (dayStamp !== today) {
            dailyGiven = currentTokens; // reset: only count current tokens
            updates.tokensDayStamp   = today;
            updates.tokensDailyGiven = dailyGiven;
        }

        if (currentTokens < MAX_TOKENS) {
            const elapsed   = now - lastRefill;
            const hoursElapsed = Math.floor(elapsed / REFILL_INTERVAL);

            if (hoursElapsed >= 1) {
                // How many tokens can still be given today (max 24)
                const remainingDailyAllowance = Math.max(0, 24 - dailyGiven);
                const tokensToAdd = Math.min(hoursElapsed, MAX_TOKENS - currentTokens, remainingDailyAllowance);

                if (tokensToAdd > 0) {
                    currentTokens += tokensToAdd;
                    dailyGiven    += tokensToAdd;
                    updates.tokens           = currentTokens;
                    updates.tokensDailyGiven = dailyGiven;
                    // Advance refill timer by the hours consumed
                    updates.tokenRefill = lastRefill + (hoursElapsed * REFILL_INTERVAL);
                }
            }
        } else {
            // Already at max — reset refill timer so countdown is fresh when they dip below
            if (!updates.tokenRefill) {
                updates.tokenRefill = now;
            }
        }

        // Apply updates if any
        if (Object.keys(updates).length > 0) {
            await userRef.update(updates);
            const refreshed = await userRef.get();
            userData = refreshed.data();
        }
    }

    // ── Broadcast list ───────────────────────────────────────────────
    try {
        await db.collection('system').doc('broadcast_list').set({
            ids: admin.firestore.FieldValue.arrayUnion(String(telegramId))
        }, { merge: true });
    } catch (e) {
        console.error('Broadcast error:', e);
    }

    return res.status(200).json({ success: true, user: userData });
}
