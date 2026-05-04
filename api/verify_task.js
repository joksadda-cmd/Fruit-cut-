const { db, admin } = require('./utils/firebase');
const crypto = require('crypto');

function verifyTelegram(initData, botToken) {
    if (!initData || !botToken) return false;
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return false;
        params.delete('hash');
        const checkStr = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
        const secret = crypto.createHmac('sha256','WebAppData').update(botToken).digest();
        const expected = crypto.createHmac('sha256', secret).update(checkStr).digest('hex');
        return hash === expected;
    } catch(e) { return false; }
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-telegram-init-data');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const BOT_TOKEN = process.env.BOT_TOKEN || '';
    const initData  = req.headers['x-telegram-init-data'] || '';
    if (BOT_TOKEN && initData && !verifyTelegram(initData, BOT_TOKEN)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { telegramId, taskId, skipVerify } = req.body;
    if (!telegramId || !taskId) return res.status(400).json({ error: 'Missing fields' });

    const userRef = db.collection('users').doc(String(telegramId));
    const doc     = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });

    const userData       = doc.data();
    const completedTasks = userData.completedTasks || [];

    if (completedTasks.includes(String(taskId))) {
        return res.status(400).json({ error: 'Task already completed' });
    }

    await userRef.update({
        coins:          admin.firestore.FieldValue.increment(200),
        completedTasks: admin.firestore.FieldValue.arrayUnion(String(taskId)),
    });
    return res.status(200).json({ success: true, user: (await userRef.get()).data() });
};
