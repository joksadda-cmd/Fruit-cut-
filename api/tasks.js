const { db } = require('./utils/firebase');

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

    try {
        const snapshot = await db.collection('tasks').orderBy('order', 'asc').get();
        let tasks = [];
        
        snapshot.forEach(doc => {
            tasks.push({ id: doc.id, ...doc.data() });
        });

        // যদি ডাটাবেসে কোনো টাস্ক অ্যাড না করে থাকেন, তাহলে ডিফল্টভাবে এই দুটো দেখাবে
        if (tasks.length === 0) {
            tasks = [
                { id: 'task1', icon: '📢', name: 'Join Official Channel', link: 'https://t.me/yourchannel', coins: 200, gems: 0, order: 1 },
                { id: 'task2', icon: '💬', name: 'Join Discussion Group', link: 'https://t.me/yourgroup', coins: 150, gems: 0, order: 2 }
            ];
        }

        res.status(200).json(tasks);
    } catch (error) {
        res.status(500).json({ error: 'Server Error' });
    }
}
