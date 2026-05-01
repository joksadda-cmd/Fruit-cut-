const { db } = require('../utils/firebase');

module.exports = async function handler(req, res) {
    // --- CORS Headers ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    // -------------------

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    const { secret, message, btnText, btnUrl } = req.body;

    // ১. Secret Key চেক
    if (secret !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ success: false, error: 'Unauthorized! Wrong Secret Key.' });
    }

    if (!message) return res.status(400).json({ success: false, error: 'Message is required' });

    // ২. Bot Token চেক
    const botToken = process.env.BOT_TOKEN;
    if (!botToken) return res.status(500).json({ success: false, error: 'BOT_TOKEN is missing in Vercel settings' });

    try {
        const usersSnap = await db.collection('users').get();
        let userIds = [];
        
        // আমি ধরে নিচ্ছি আপনার ডাটাবেসে doc.id টাই হলো ইউজারের টেলিগ্রাম আইডি
        usersSnap.forEach(doc => { userIds.push(doc.id); });

        if (userIds.length === 0) return res.status(400).json({ success: false, error: 'No users found in database' });

        let replyMarkup = {};
        if (btnText && btnUrl) {
            replyMarkup = {
                inline_keyboard: [[{ text: btnText, url: btnUrl }]]
            };
        }

        let sentCount = 0;

        // ৩. Promise.all এর বদলে For Loop ব্যবহার (যাতে Rate Limit ক্রস না করে)
        for (const userId of userIds) {
            try {
                const tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
                const response = await fetch(tgUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: userId,
                        text: message,
                        reply_markup: Object.keys(replyMarkup).length > 0 ? replyMarkup : undefined,
                        parse_mode: "HTML"
                    })
                });
                
                const data = await response.json();
                if (data.ok) {
                    sentCount++;
                }

                // টেলিগ্রামের লিমিটেশন এড়াতে প্রতি মেসেজের পর 40 মিলি-সেকেন্ড অপেক্ষা করবে
                await new Promise(resolve => setTimeout(resolve, 40));

            } catch (err) {
                console.error(`Failed to send message to ${userId}:`, err);
            }
        }

        return res.status(200).json({ success: true, sentCount });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
}
}
