const { db, admin } = require('./utils/firebase');

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    const { telegramId, username, method, address, amount } = req.body;

    if (amount < 100) return res.status(400).json({ error: 'Minimum 100 Diamonds required' });

    const userRef = db.collection('users').doc(String(telegramId));

    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (doc.data().gems < amount) throw new Error("Not enough Diamonds");

            // ডায়মন্ড কাটা
            t.update(userRef, { gems: admin.firestore.FieldValue.increment(-amount) });
            
            // রিকোয়েস্ট সেভ করা
            const withdrawRef = db.collection('withdrawals').doc();
            t.set(withdrawRef, {
                userId: String(telegramId),
                username: username || 'Unknown',
                method, address, amount,
                status: 'pending',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        const updatedDoc = await userRef.get();
        res.status(200).json({ success: true, user: updatedDoc.data() });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
}
