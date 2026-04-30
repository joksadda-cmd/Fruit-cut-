const { db } = require('./utils/firebase');

export default async function handler(req, res) {
    // এটি GET রিকোয়েস্ট হবে
    if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

    try {
        // Firebase এর 'settings' কালেকশন থেকে 'admin' ডকুমেন্ট খুঁজবে
        const doc = await db.collection('settings').doc('admin').get();
        
        if (doc.exists && doc.data().broadcastMessage) {
            return res.status(200).json({ message: doc.data().broadcastMessage });
        }
        
        // ডাটাবেসে কিছু না থাকলে এই ডিফল্ট মেসেজটা দেখাবে
        return res.status(200).json({ message: "Welcome to Fruit Cut! Slice fruits and earn real rewards! 🍉" });
    } catch (error) {
        return res.status(200).json({ message: "Welcome to Fruit Cut! Slice fruits and earn real rewards! 🍉" });
    }
}
