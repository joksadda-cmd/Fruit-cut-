const { db, admin } = require('../utils/firebase');

export default async function handler(req, res) {
    // শুধুমাত্র POST রিকোয়েস্ট অ্যালাউ করবো
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // Frontend থেকে এই ডাটাগুলো রিসিভ করবো
    const { telegramId, reward, isAdWatched } = req.body;

    if (!telegramId || !reward) {
        return res.status(400).json({ error: 'Missing data' });
    }

    // সিকিউরিটি: কেউ হ্যাক করে একবারে ১০০ এর বেশি কয়েন নিতে পারবে না
    if (reward > 100) {
        return res.status(400).json({ error: 'Hack detected!' });
    }

    let finalReward = isAdWatched ? reward * 2 : reward;

    try {
        const userRef = db.collection('users').doc(String(telegramId));
        
        // ডাটাবেসে কয়েন আপডেট করা
        await userRef.update({
            coins: admin.firestore.FieldValue.increment(finalReward),
            stage: admin.firestore.FieldValue.increment(1) // লেভেল আপ
        });

        // আপডেট হওয়া নতুন ডাটা ফ্রন্টএন্ডে পাঠানো
        const updatedDoc = await userRef.get();
        res.status(200).json({ success: true, user: updatedDoc.data() });

    } catch (error) {
        res.status(500).json({ error: 'Server Error' });
    }
}
