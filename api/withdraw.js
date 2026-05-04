const { db, admin } = require('./utils/firebase');
const crypto = require('crypto');

// ── Telegram initData verification ───────────────────────────────────
function verifyTelegram(initData, botToken) {
    if (!initData || !botToken) return false;
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return false;
        params.delete('hash');
        const checkStr = [...params.entries()]
            .sort(([a],[b]) => a.localeCompare(b))
            .map(([k,v]) => `${k}=${v}`)
            .join('\n');
        const secret   = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const expected = crypto.createHmac('sha256', secret).update(checkStr).digest('hex');
        return hash === expected;
    } catch(e) { return false; }
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-telegram-init-data');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')   return res.status(405).json({ success: false, error: 'Method Not Allowed' });

    // ── Security: Telegram initData verify ───────────────────────────
    const BOT_TOKEN = process.env.BOT_TOKEN || '';
    const initData  = req.headers['x-telegram-init-data'] || '';
    if (BOT_TOKEN && initData && !verifyTelegram(initData, BOT_TOKEN)) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { telegramId, username, method, address, amount } = req.body;

    if (!telegramId || !method || !address || !amount) {
        return res.status(400).json({ success: false, error: 'Missing information' });
    }

    // ── Input validation ──────────────────────────────────────────────
    const validMethods = ['bkash', 'binance', 'tonkeeper'];
    if (!validMethods.includes(method)) {
        return res.status(400).json({ success: false, error: 'Invalid withdrawal method' });
    }

    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    try {
        const userRef = db.collection('users').doc(String(telegramId));

        // ── Transaction: atomic check + deduct + record ───────────────
        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) throw new Error('User not found');

            const userData = userDoc.data();

            // Ban check
            if (userData.isBanned) {
                throw new Error('Your account has been banned');
            }

            // Requirements check (5 tasks + 2 refers)
            const completedTasks = userData.completedTasks || [];
            const refers         = userData.referCount     || 0;
            if (completedTasks.length < 5 || refers < 2) {
                throw new Error('Requirement not met: Need 5 completed tasks & 2 refers');
            }

            // Balance check
            const currentGems = userData.gems || 0;
            if (currentGems < amountNum) {
                throw new Error('Not enough Diamonds');
            }

            // Minimum withdrawal limits
            if (amountNum < 100) {
                throw new Error('Minimum withdrawal is 100 Diamonds');
            }
            if (method === 'binance' && amountNum < 500) {
                throw new Error('Minimum for Binance USDT is 500 Diamonds');
            }

            // Deduct diamonds from user
            t.update(userRef, {
                gems: admin.firestore.FieldValue.increment(-amountNum)
            });

            // Record withdrawal request
            const withdrawRef = db.collection('withdrawals').doc();
            t.set(withdrawRef, {
                userId:      String(telegramId),
                username:    username || 'unknown',
                method:      method,
                address:     address,
                amount:      amountNum,
                status:      'pending',
                requestedAt: admin.firestore.FieldValue.serverTimestamp(),
                // Keep createdAt for backward compatibility
                createdAt:   admin.firestore.FieldValue.serverTimestamp(),
            });
        });

        // Return updated user data
        const updatedUser = (await userRef.get()).data();
        return res.status(200).json({ success: true, user: updatedUser });

    } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
    }
};
