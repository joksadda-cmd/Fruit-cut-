const { db, admin } = require('./utils/firebase');

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    const { telegramId, action, coinsToAdd, lootboxPointsToAdd } = req.body; 

    try {
        const userRef = db.collection('users').doc(String(telegramId));
        let updates = {
            coins: admin.firestore.FieldValue.increment(coinsToAdd || 0),
            lootboxPoints: admin.firestore.FieldValue.increment(lootboxPointsToAdd || 0)
        };

        // কোন অ্যাড দেখেছে তার কাউন্ট বাড়ানো
        if (action === 'adsgram') updates.adsgramCount = admin.firestore.FieldValue.increment(1);
        if (action === 'adsgramDaily') updates.adsgramDailyCount = admin.firestore.FieldValue.increment(1);
        if (action === 'gigapub') updates.gigapubCount = admin.firestore.FieldValue.increment(1);
        if (action === 'monetag') updates.monetagCount = admin.firestore.FieldValue.increment(1);
        if (action === 'claim_lootbox') {
            updates.lootboxPoints = 0; // পয়েন্ট জিরো করে দেওয়া
            updates.gems = admin.firestore.FieldValue.increment(coinsToAdd); // এখানে coinsToAdd মূলত ডায়মন্ড
            delete updates.coins;
        }

        await userRef.update(updates);
        const updatedDoc = await userRef.get();
        res.status(200).json({ success: true, user: updatedDoc.data() });
    } catch (error) {
        res.status(500).json({ error: 'Server Error' });
    }
}
