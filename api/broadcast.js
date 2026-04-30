const { db } = require('./utils/firebase');

export default async function handler(req, res) {
    // শুধুমাত্র GET রিকোয়েস্ট অ্যালাউ করা হবে
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // ডাটাবেসের 'settings' কালেকশন থেকে 'admin' ডকুমেন্টটি চেক করবে
        const doc = await db.collection('settings').doc('admin').get();
        
        // যদি মেসেজ থাকে, তবে সেটি গেমের ফ্রন্টএন্ডে পাঠিয়ে দেবে
        if (doc.exists && doc.data().broadcastMessage) {
            return res.status(200).json({ message: doc.data().broadcastMessage });
        }
        
        // ডাটাবেসে কিছু না থাকলে ডিফল্ট মেসেজ দেখাবে
        return res.status(200).json({ message: "Welcome to Fruit Cut! Slice fruits and earn real rewards! 🍉" });
        
    } catch (error) {
        // কোনো এরর হলে গেম যেন ক্র্যাশ না করে, তাই ডিফল্ট মেসেজ পাঠিয়ে দেওয়া হবে
        return res.status(200).json({ message: "Welcome to Fruit Cut! Slice fruits and earn real rewards! 🍉" });
    }
}
