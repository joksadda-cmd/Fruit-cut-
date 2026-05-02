const { db, admin } = require('./utils/firebase');

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method Not Allowed' });

    const { telegramId, username, method, address, amount } = req.body;

    if (!telegramId || !method || !address || !amount) {
        return res.status(400).json({ success: false, error: 'Missing information' });
    }

    try {
        const userRef = db.collection('users').doc(String(telegramId));
        
        // Transaction ব্যবহার করা হয়েছে যাতে কেউ হ্যাক করে একসাথে ডাবল উইথড্র দিতে না পারে
        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) throw new Error('User not found');

            const userData = userDoc.data();
            
            // রিকোয়ারমেন্ট চেক (৫ টাস্ক + ২ রেফার)
            const completedTasks = userData.completedTasks || [];
            const refers = userData.referCount || 0;

            if (completedTasks.length < 5 || refers < 2) {
                throw new Error('Withdrawal requirements not met (Need 5 tasks & 2 refers)');
            }

            if (userData.gems < amount) {
                throw new Error('Not enough Diamonds');
            }

            if (amount < 100) {
                throw new Error('Minimum withdraw is 100 Diamonds');
            }
            if (method === 'binance' && amount < 500) {
                throw new Error('Minimum for Binance is 500 Diamonds');
            }

            // ইউজারের ব্যালেন্স থেকে ডায়মন্ড কাটা
            t.update(userRef, { gems: admin.firestore.FieldValue.increment(-amount) });
            
            // উইথড্র লিস্টে রিকোয়েস্ট জমা করা
            const withdrawRef = db.collection('withdrawals').doc();
            t.set(withdrawRef, {
                userId: String(telegramId),
                username: username || 'unknown',
                method: method,
                address: address,
                amount: Number(amount),
                status: 'pending',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        // আপডেটেড ডাটা রিটার্ন করা
        const updatedUser = (await userRef.get()).data();
        return res.status(200).json({ success: true, user: updatedUser });

    } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
    }
}
