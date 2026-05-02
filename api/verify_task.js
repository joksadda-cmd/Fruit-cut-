const { db, admin } = require('./utils/firebase');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { telegramId, taskId } = req.body;
    const botToken = process.env.BOT_TOKEN;

    try {
        const userRef = db.collection('users').doc(String(telegramId));
        const userDoc = await userRef.get();
        if (!userDoc.exists) return res.status(404).json({ success: false, error: 'User not found' });

        const userData = userDoc.data();
        const completedTasks = userData.completedTasks || [];
        if (completedTasks.includes(String(taskId))) {
            return res.status(400).json({ success: false, error: 'Task already completed' });
        }

        const taskRef = db.collection('tasks').doc(String(taskId));
        const taskDoc = await taskRef.get();
        if (!taskDoc.exists) return res.status(404).json({ success: false, error: 'Task not found' });

        const taskData = taskDoc.data();

        if (taskData.verifyChannelId) {
            const tgUrl = `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=@${taskData.verifyChannelId}&user_id=${telegramId}`;
            const tgRes = await fetch(tgUrl);
            const tgData = await tgRes.json();
            
            const isMember = tgData.ok && ['member', 'administrator', 'creator'].includes(tgData.result.status);
            
            if (!isMember) {
                return res.status(400).json({ success: false, error: 'Not joined channel' });
            }
        }

        await userRef.update({
            coins: admin.firestore.FieldValue.increment(Number(taskData.coins || 0)),
            gems: admin.firestore.FieldValue.increment(Number(taskData.gems || 0)),
            completedTasks: admin.firestore.FieldValue.arrayUnion(String(taskId))
        });

        const updatedUser = (await userRef.get()).data();
        return res.status(200).json({ success: true, user: updatedUser });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
}
