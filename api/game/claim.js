const { db, admin } = require('./utils/firebase');

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    const { telegramId, reward, isAdWatched } = req.body;

    let finalReward = isAdWatched ? reward * 2 : reward;

    try {
        const userRef = db.collection('users').doc(String(telegramId));
        await userRef.update({
            coins: admin.firestore.FieldValue.increment(finalReward),
            stage: admin.firestore.FieldValue.increment(1)
        });
        
        const updatedDoc = await userRef.get();
        res.status(200).json({ success: true, user: updatedDoc.data() });
    } catch (error) {
        res.status(500).json({ error: 'Server Error' });
    }
}
