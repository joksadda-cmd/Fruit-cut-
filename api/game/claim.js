const { db, admin } = require('./utils/firebase');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method Not Allowed' });

    const { telegramId, reward } = req.body;
    if (!telegramId || reward === undefined) return res.status(400).json({ success: false, error: 'Missing data' });

    try {
        const userRef = db.collection('users').doc(String(telegramId));
        const doc = await userRef.get();

        if (!doc.exists) return res.status(404).json({ success: false, error: 'User not found' });

        await userRef.update({
            coins: admin.firestore.FieldValue.increment(Number(reward)),
            gamesPlayed: admin.firestore.FieldValue.increment(1)
        });

        const updatedUser = (await userRef.get()).data();
        return res.status(200).json({ success: true, user: updatedUser });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
}
