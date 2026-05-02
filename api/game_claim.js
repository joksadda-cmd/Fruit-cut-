const { db, admin } = require('./utils/firebase');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method Not Allowed' });

    // টোকেন এবং রিফিল ডাটা রিসিভ করা
    const { telegramId, reward, tokenSpent, refillToken } = req.body;
    if (!telegramId) return res.status(400).json({ success: false, error: 'Missing data' });

    try {
        const userRef = db.collection('users').doc(String(telegramId));
        const doc = await userRef.get();

        if (!doc.exists) return res.status(404).json({ success: false, error: 'User not found' });
        const userData = doc.data();

        let updateData = {};

        // ১. গেম জেতার গোল্ড যোগ করা
        if (reward && reward > 0) {
            updateData.coins = admin.firestore.FieldValue.increment(Number(reward));
        }

        // ২. গেম খেলার জন্য টোকেন কেটে নেওয়া
        if (tokenSpent) {
            updateData.tokens = admin.firestore.FieldValue.increment(-1);
            updateData.gamesPlayed = admin.firestore.FieldValue.increment(1);
        }

        // ৩. ১ ঘন্টা পর অটোমেটিক টোকেন রিফিল ডাটাবেসে সেভ করা
        if (refillToken && userData.tokens < 10) {
            updateData.tokens = admin.firestore.FieldValue.increment(1);
            updateData.tokenRefill = Date.now();
        }

        // ডাটাবেস আপডেট করা
        if (Object.keys(updateData).length > 0) {
            await userRef.update(updateData);
        }

        const updatedUser = (await userRef.get()).data();
        return res.status(200).json({ success: true, user: updatedUser });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
}
