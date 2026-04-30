const { db, admin } = require('./utils/firebase');
const fetch = require('node-fetch'); // Node 18+ এ ডিফল্ট থাকে, তবুও সিকিউরিটির জন্য

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    const { telegramId, taskId } = req.body;

    if(!telegramId || !taskId) return res.status(400).json({ error: 'Missing data' });

    try {
        const userRef = db.collection('users').doc(String(telegramId));
        const userDoc = await userRef.get();
        if ((userDoc.data()?.completedTasks || []).includes(String(taskId))) {
            return res.status(400).json({ success: false, error: 'Task already completed!' });
        }

        // ডাটাবেস থেকে টাস্কের ডিটেইলস আনা
        let taskDoc = await db.collection('tasks').doc(String(taskId)).get();
        if(!taskDoc.exists) return res.status(400).json({ success: false, error: 'Task not found' });
        
        let taskData = taskDoc.data();
        let taskRewardCoins = taskData.coins || 0; 
        let taskRewardGems = taskData.gems || 0;
        let channelId = taskData.verifyChannelId; // e.g. "mychannel"

        // টেলিগ্রাম ভেরিফিকেশন (যদি অ্যাডমিন প্যানেল থেকে channel username দেওয়া থাকে)
        if (channelId) {
            const botToken = process.env.BOT_TOKEN;
            // Channel ID এর আগে @ বসাতে হবে
            const formattedChannel = channelId.startsWith('@') ? channelId : `@${channelId}`;
            
            const tgApiUrl = `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${formattedChannel}&user_id=${telegramId}`;
            
            const tgRes = await fetch(tgApiUrl);
            const tgData = await tgRes.json();

            if (!tgData.ok) {
                return res.status(400).json({ success: false, error: 'Bot is not admin in channel, or channel is wrong.' });
            }

            const status = tgData.result.status;
            if (status === 'left' || status === 'kicked') {
                return res.status(400).json({ success: false, error: 'You have not joined the channel yet!' });
            }
        }

        // ভেরিফাই পাস হলে বা ভেরিফিকেশন না থাকলে রিওয়ার্ড দেওয়া
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
