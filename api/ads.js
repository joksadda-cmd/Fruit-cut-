const { db, admin } = require('./utils/firebase');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { telegramId, action, coinsToAdd } = req.body;
    if (!telegramId) return res.status(400).json({ success: false, error: 'Missing Telegram ID' });

    try {
        const userRef = db.collection('users').doc(String(telegramId));
        const doc = await userRef.get();
        if (!doc.exists) return res.status(404).json({ success: false, error: 'User not found' });

        const userData = doc.data();

        if (action === 'claim_lootbox') {
            if (userData.lootboxPoints < 500) return res.status(400).json({ success: false, error: 'Not enough points' });
            
            await userRef.update({
                coins: admin.firestore.FieldValue.increment(Number(coinsToAdd)),
                lootboxPoints: 0 
            });
        } 
        else {
            const updateData = {
                coins: admin.firestore.FieldValue.increment(Number(coinsToAdd)),
                lootboxPoints: admin.firestore.FieldValue.increment(Number(coinsToAdd)) 
            };

            if (action === 'adsgram') updateData.adsgramCount = admin.firestore.FieldValue.increment(1);
            if (action === 'adsgramDaily') updateData.adsgramDailyCount = admin.firestore.FieldValue.increment(1);
            if (action === 'gigapub') updateData.gigapubCount = admin.firestore.FieldValue.increment(1);
            if (action === 'monetag') updateData.monetagCount = admin.firestore.FieldValue.increment(1);

            await userRef.update(updateData);
        }

        const updatedUser = (await userRef.get()).data();
        return res.status(200).json({ success: true, user: updatedUser });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
}
