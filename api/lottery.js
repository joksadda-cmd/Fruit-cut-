const { db, admin } = require('./utils/firebase');

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    const { telegramId, prizeType, prizeVal } = req.body;

    try {
        const userRef = db.collection('users').doc(String(telegramId));
        let updates = {
            lotteryDailySpins: admin.firestore.FieldValue.increment(1),
            lotteryTotalSpins: admin.firestore.FieldValue.increment(1)
        };

        if (prizeType === 'gem') {
            updates.gems = admin.firestore.FieldValue.increment(prizeVal);
            updates.lotteryDiamondsEarned = admin.firestore.FieldValue.increment(prizeVal);
        } else if (prizeType === 'token') {
            updates.tokens = admin.firestore.FieldValue.increment(prizeVal);
        } else if (prizeType === 'coin') {
            updates.coins = admin.firestore.FieldValue.increment(prizeVal);
        }

        await userRef.update(updates);
        const updatedDoc = await userRef.get();
        res.status(200).json({ success: true, user: updatedDoc.data() });
    } catch (error) {
        res.status(500).json({ error: 'Server Error' });
    }
}
