const { db } = require('../utils/firebase');
const fetch = require('node-fetch'); // আপনার আগের কোডে এটা ছিল, তাই রাখলাম

export default async function handler(req, res) {
    // --- CORS Headers ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method Not Allowed' });
    
    const { secret, message, btnText, btnUrl } = req.body;

    // ১. Secret Key চেক
    if (secret !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ success: false, error: 'Unauthorized! Wrong Secret Key.' });
    }

    if (!message) return res.status(400).json({ success: false, error: 'Message is required' });

    // ২. Bot Token চেক
    const botToken = process.env.BOT_TOKEN;
    if (!botToken) return res.status(500).json({ success: false, error: 'BOT_TOKEN is missing in Vercel' });

    try {
        // ৩. মাত্র ১টি Read খরচ করে সবার আইডি Array থেকে নিয়ে আসা!
        const broadcastDoc = await db.collection('system').doc('broadcast_list').get();
        
        if (!broadcastDoc.exists) {
            return res.status(400).json({ success: false, error: 'No users found in broadcast list' });
        }

        const userIds = broadcastDoc.data().ids || [];

        if (userIds.length === 0) {
            return res.status(400).json({ success: false, error: 'User list is empty' });
        }

        let replyMarkup = {};
        if (btnText && btnUrl) {
            replyMarkup = {
                inline_keyboard: [[{ text: btnText, url: btnUrl }]]
            };
        }

        let sentCount = 0;

        // ৪. লুপ করে মেসেজ পাঠানো (Rate Limit Protection সহ)
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
                console.error(`Failed to send to ${userId}`);
            }
        }

        // ৫. সফলভাবে পাঠানো মেসেজের সংখ্যা রিটার্ন করা
        return res.status(200).json({ success: true, sentCount });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
                            }
