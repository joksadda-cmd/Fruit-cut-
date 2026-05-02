const { db, admin } = require('./utils/firebase');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { telegramId, prizeType, prizeVal, usedToken } = req.body;

    try {
        const userRef = db.collection('users').doc(String(telegramId));
        const doc = await userRef.get();
        if (!doc.exists) return res.status(404).json({ success: false });

        let updateData = {
            lotteryTotalSpins: admin.firestore.FieldValue.increment(1)
        };

        if (usedToken) {
            updateData.lotteryTokens = admin.firestore.FieldValue.increment(-1);
        } else {
            updateData.lotteryDailySpins = admin.firestore.FieldValue.increment(1);
        }

        if (prizeType === 'coin') {
            updateData.coins = admin.firestore.FieldValue.increment(Number(prizeVal));
        } else if (prizeType === 'diamond') {
            updateData.gems = admin.firestore.FieldValue.increment(Number(prizeVal));
            updateData.lotteryDiamondsEarned = admin.firestore.FieldValue.increment(Number(prizeVal));
        } else if (prizeType === 'token') {
            updateData.tokens = admin.firestore.FieldValue.increment(Number(prizeVal));
        } else if (prizeType === 'lottoken' || prizeType === 'freespin') {
            updateData.lotteryTokens = admin.firestore.FieldValue.increment(1);
        }

        await userRef.update(updateData);
        const updatedUser = (await userRef.get()).data();
        
        return res.status(200).json({ success: true, user: updatedUser });
    } catch (error) {
        return res.status(500).json({ success: false });
    }
}
