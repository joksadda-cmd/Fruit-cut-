const { db, admin } = require('./utils/firebase');

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    const { telegramId, type, qty } = req.body; // type: 'token' or 'diamond'

    const userRef = db.collection('users').doc(String(telegramId));
    
    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            let user = doc.data();

            if (type === 'token') {
                let cost = qty * 50;
                if (user.coins < cost) throw new Error("Not enough coins");
                t.update(userRef, {
                    coins: admin.firestore.FieldValue.increment(-cost),
                    tokens: admin.firestore.FieldValue.increment(qty),
                    shopTokenBought: admin.firestore.FieldValue.increment(qty)
                });
            } 
            else if (type === 'diamond') {
                let cost = qty * 1000;
                if (user.coins < cost) throw new Error("Not enough coins");
                t.update(userRef, {
                    coins: admin.firestore.FieldValue.increment(-cost),
                    gems: admin.firestore.FieldValue.increment(qty),
                    shopDiamondExchanged: admin.firestore.FieldValue.increment(qty)
                });
            }
        });

        const updatedDoc = await userRef.get();
        res.status(200).json({ success: true, user: updatedDoc.data() });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
}
