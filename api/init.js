const { db, admin } = require('./utils/firebase');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    
    const { telegramId, username, referredBy } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'Missing Telegram ID' });

    const userRef = db.collection('users').doc(String(telegramId));
    const doc = await userRef.get();

    let userData;
    const today = new Date().toDateString();

    if (!doc.exists) {
        if (referredBy) {
            const refUser = db.collection('users').doc(String(referredBy));
            await refUser.update({ referCount: admin.firestore.FieldValue.increment(1), tokens: admin.firestore.FieldValue.increment(1) }).catch(()=>{});
        }

        userData = {
            telegramId: String(telegramId), username: username || 'unknown',
            coins: 0, gems: 0, stage: 1, tokens: 3,
            referCode: `FC${telegramId}`, referCount: 0, referredBy: referredBy || null,
            adsDayStamp: today,
            adsgramCount: 0, adsgramDailyCount: 0, monetagCount: 0, gigapubCount: 0,
            lootboxPoints: 0, gamesPlayed: 0, lotteryDailySpins: 0,
            shopTokenBought: 0, shopDiamondExchanged: 0
        };
        await userRef.set(userData);

        // ফায়ারবেসে নতুন ইউজারের আইডি লিস্টে সেভ করা
        try {
            await db.collection('system').doc('broadcast_list').set({
                ids: admin.firestore.FieldValue.arrayUnion(String(telegramId))
            }, { merge: true });
        } catch (error) {
            console.error("Broadcast array update error:", error);
        }

    } else {
        userData = doc.data();
        if (userData.adsDayStamp !== today) {
            await userRef.update({
                adsDayStamp: today,
                adsgramCount: 0, adsgramDailyCount: 0, monetagCount: 0, gigapubCount: 0,
                lotteryDailySpins: 0, shopTokenBought: 0, shopDiamondExchanged: 0
            });
            const updated = await userRef.get();
            userData = updated.data();
        }
    }

    return res.status(200).json({ success: true, user: userData });
}
