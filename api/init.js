const { db, admin } = require('./utils/firebase');

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    
    const { telegramId, username, referredBy } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'Missing Telegram ID' });

    const userRef = db.collection('users').doc(String(telegramId));
    const doc = await userRef.get();

    let userData;
    const today = new Date().toDateString();

    if (!doc.exists) {
        // নতুন একাউন্ট
        if (referredBy) {
            // যে রেফার করেছে তাকে ১ টোকেন দেওয়া
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
    } else {
        // পুরানো একাউন্ট (Daily Reset চেক)
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

    res.status(200).json({ success: true, user: userData });
}
