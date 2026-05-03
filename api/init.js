const { db, admin } = require('./utils/firebase');
const { verifyTelegramData } = require('./utils/verifyTelegram');

const MAX_TOKENS        = 10;
const REFILL_MS         = 60 * 60 * 1000;  // 1 hour
const MAX_DAILY_TOKENS  = 24;               // max tokens via refill per day

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-telegram-init-data');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')   return res.status(405).send('Method Not Allowed');

    // ── Security: verify Telegram initData ───────────────────────────
    const initData  = req.headers['x-telegram-init-data'] || '';
    const BOT_TOKEN = process.env.BOT_TOKEN || '';
    if (BOT_TOKEN && !verifyTelegramData(initData, BOT_TOKEN)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { telegramId, username, referredBy } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'Missing Telegram ID' });

    const userRef = db.collection('users').doc(String(telegramId));
    const doc     = await userRef.get();
    const today   = new Date().toDateString();
    const now     = Date.now();
    let userData;

    // ════════════════════════════════════════════════════════════════
    //  NEW USER
    // ════════════════════════════════════════════════════════════════
    if (!doc.exists) {

        // ── Refer reward for referrer ────────────────────────────────
        if (referredBy) {
            const refRef = db.collection('users').doc(String(referredBy));
            const refDoc = await refRef.get();
            if (refDoc.exists) {
                const refData = refDoc.data();
                const curTok  = refData.tokens        || 0;
                const curLot  = refData.lotteryTokens || 0;

                // +1 Game Token — CAPPED at MAX_TOKENS (10), never exceeds
                const newTok = Math.min(MAX_TOKENS, curTok + 1);

                // +1 Lottery Token — no hard cap
                const newLot = curLot + 1;

                await refRef.update({
                    referCount:    admin.firestore.FieldValue.increment(1),
                    tokens:        newTok,   // safe: capped
                    lotteryTokens: newLot,
                });
            }
        }

        // ── Create new user ──────────────────────────────────────────
        userData = {
            telegramId:            String(telegramId),
            username:              username || 'unknown',
            coins:                 0,
            gems:                  0,
            stage:                 1,
            tokens:                3,
            tokenRefill:           now,
            tokensDailyGiven:      3,
            tokensDayStamp:        today,
            referCode:             `FC${telegramId}`,
            referCount:            0,
            referredBy:            referredBy || null,
            validReferRewardGiven: false,
            referDiamonds:         0,
            adsDayStamp:           today,
            adsgramCount:          0,
            adsgramDailyCount:     0,
            monetagCount:          0,
            gigapubCount:          0,
            lootboxPoints:         0,
            gamesPlayed:           0,
            lotteryDailySpins:     0,
            lotteryTotalSpins:     0,
            lotteryDiamondsEarned: 0,
            lotteryTokens:         0,
            shopTokenBought:       0,
            shopDiamondExchanged:  0,
            completedTasks:        [],
        };
        await userRef.set(userData);

    // ════════════════════════════════════════════════════════════════
    //  EXISTING USER
    // ════════════════════════════════════════════════════════════════
    } else {
        userData = doc.data();
        const updates = {};

        // ── Daily reset ──────────────────────────────────────────────
        if (userData.adsDayStamp !== today) {
            Object.assign(updates, {
                adsDayStamp:          today,
                adsgramCount:         0,
                adsgramDailyCount:    0,
                monetagCount:         0,
                gigapubCount:         0,
                lotteryDailySpins:    0,
                shopTokenBought:      0,
                shopDiamondExchanged: 0,
                tokensDailyGiven:     userData.tokens || 0,
                tokensDayStamp:       today,
            });
        }

        // ── Hourly token refill: +1/hr, max 10, max 24/day ──────────
        let curTokens  = userData.tokens          !== undefined ? userData.tokens          : 3;
        let lastRefill = userData.tokenRefill      || now;
        let dayStamp   = userData.tokensDayStamp   || today;
        let dailyGiven = userData.tokensDailyGiven || 0;

        if (dayStamp !== today) {
            dailyGiven               = curTokens;
            updates.tokensDayStamp   = today;
            updates.tokensDailyGiven = dailyGiven;
        }

        if (curTokens < MAX_TOKENS) {
            const hoursElapsed       = Math.floor((now - lastRefill) / REFILL_MS);
            const remainingAllowance = Math.max(0, MAX_DAILY_TOKENS - dailyGiven);
            const tokensToAdd        = Math.min(hoursElapsed, MAX_TOKENS - curTokens, remainingAllowance);

            if (tokensToAdd > 0) {
                curTokens               += tokensToAdd;
                dailyGiven              += tokensToAdd;
                updates.tokens           = curTokens;
                updates.tokensDailyGiven = dailyGiven;
                updates.tokenRefill      = lastRefill + hoursElapsed * REFILL_MS;
            }
        } else {
            // Already at max — reset clock so countdown is fresh on next use
            updates.tokenRefill = now;
        }

        if (Object.keys(updates).length > 0) {
            await userRef.update(updates);
            const refreshed = await userRef.get();
            userData        = refreshed.data();
        }
    }

    // ── Broadcast list ───────────────────────────────────────────────
    try {
        await db.collection('system').doc('broadcast_list').set(
            { ids: admin.firestore.FieldValue.arrayUnion(String(telegramId)) },
            { merge: true }
        );
    } catch (e) {
        console.error('Broadcast error:', e);
    }

    return res.status(200).json({ success: true, user: userData });
}
