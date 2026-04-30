const { db, admin } = require('./utils/firebase');

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    const { telegramId, type, qty, goldAmount } = req.body; 

    const userRef = db.collection('users').doc(String(telegramId));
    
    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            let user = doc.data();

            if (type === 'token') {
                let cost = qty * 50;
                if (user.coins < cost) throw new Error("Not enough Gold");
                t.update(userRef, {
                    coins: admin.firestore.FieldValue.increment(-cost),
                    tokens: admin.firestore.FieldValue.increment(qty),
                    shopTokenBought: admin.firestore.FieldValue.increment(qty)
                });
            } 
            else if (type === 'gold_to_diamond') {
                if (goldAmount < 1000 || goldAmount > 100000) throw new Error("Invalid amount");
                if (user.coins < goldAmount) throw new Error("Not enough Gold");
                
                let diamonds = Math.floor(goldAmount / 1000);
                t.update(userRef, {
                    coins: admin.firestore.FieldValue.increment(-goldAmount),
                    gems: admin.firestore.FieldValue.increment(diamonds),
                    shopDiamondExchanged: admin.firestore.FieldValue.increment(diamonds)
                });
            }
        });

        const updatedDoc = await userRef.get();
        res.status(200).json({ success: true, user: updatedDoc.data() });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
}
