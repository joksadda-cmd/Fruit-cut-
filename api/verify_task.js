const { db, admin } = require('./utils/firebase');

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    const { telegramId, taskId } = req.body;

    if(!telegramId || !taskId) return res.status(400).json({ error: 'Missing data' });

    try {
        const userRef = db.collection('users').doc(String(telegramId));
        const userDoc = await userRef.get();
        let userData = userDoc.data();
        
        // চেক করবে ইউজার আগেই টাস্ক করেছে কিনা
        if ((userData.completedTasks || []).includes(String(taskId))) {
            return res.status(400).json({ success: false, error: 'Task already completed!' });
        }

        // টাস্কের রিওয়ার্ড ডাটাবেস থেকে চেক করা (ডিফল্ট 200 Gold)
        let taskDoc = await db.collection('tasks').doc(String(taskId)).get();
        let taskRewardCoins = 200; 
        let taskRewardGems = 0;
        
        if(taskDoc.exists) {
            taskRewardCoins = taskDoc.data().coins || 0;
            taskRewardGems = taskDoc.data().gems || 0;
        }

        // রিওয়ার্ড দেওয়া এবং টাস্ক লিস্টে আইডি সেভ করা
        await userRef.update({
            completedTasks: admin.firestore.FieldValue.arrayUnion(String(taskId)),
            coins: admin.firestore.FieldValue.increment(taskRewardCoins),
            gems: admin.firestore.FieldValue.increment(taskRewardGems)
        });

        const updatedDoc = await userRef.get();
        res.status(200).json({ success: true, user: updatedDoc.data() });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Server Error' });
    }
}
