const { db } = require('../utils/firebase');
const fetch = require('node-fetch');

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    
    const { secret, message, btnText, btnUrl } = req.body;

    // সিকিউরিটি চেক: অ্যাডমিন প্যানেল থেকে পাঠানো সিক্রেট কি মিলছে কিনা
    if (secret !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ success: false, error: 'Unauthorized! Wrong Secret Key.' });
    }

    if (!message) return res.status(400).json({ success: false, error: 'Message is required' });

    const botToken = process.env.BOT_TOKEN;
    if (!botToken) return res.status(500).json({ success: false, error: 'BOT_TOKEN is missing in Vercel settings' });

    try {
        // Firebase থেকে সব ইউজারের আইডি নিয়ে আসা
        const usersSnap = await db.collection('users').get();
        let userIds = [];
        usersSnap.forEach(doc => { userIds.push(doc.id); });

        if (userIds.length === 0) return res.status(400).json({ success: false, error: 'No users found in database' });

        // Telegram Button Markup তৈরি
        let replyMarkup = {};
        if (btnText && btnUrl) {
            replyMarkup = {
                inline_keyboard: [[{ text: btnText, url: btnUrl }]]
            };
        }

        let sentCount = 0;

        // সবার কাছে মেসেজ পাঠানো
        const sendPromises = userIds.map(async (userId) => {
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
                if (data.ok) sentCount++;
            } catch (err) {
                // ইগনোর এরর (যদি কোনো ইউজার বট ব্লক করে থাকে)
            }
        });

        // সব মেসেজ যাওয়া পর্যন্ত অপেক্ষা করা
        await Promise.all(sendPromises);

        res.status(200).json({ success: true, sentCount });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
            }
