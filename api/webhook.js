import admin from "firebase-admin";

// ✅ Firebase init (once)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
    databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`
  });
}

const db = admin.database();

export default async function handler(req, res) {
  try {
    const TOKEN = process.env.BOT_TOKEN;

    if (req.method !== "POST") {
      return res.status(200).json({ ok: true });
    }

    const body = req.body;
    const chatId = body?.message?.chat?.id;
    const text = body?.message?.text;

    if (!chatId) {
      return res.status(200).json({ ok: true });
    }

    if (text === "/start") {

      // 🔥 Firebase এ user save
      await db.ref("users/" + chatId).set({
        chat_id: chatId,
        balance: 0,
        joinedAt: Date.now()
      });

      // ✅ Telegram message
      await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: "🍉 Welcome to Fruit Cut Play Bot!\n\n🎮 Slice fruits & enjoy addictive gameplay!\n💰 Earn USDT & TON by playing simple games\n⚡ Fast, fun & rewarding Play-To-Earn experience\n\n🚀 Start playing now and turn your time into earnings!\n👇 Join our official channel",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📢 Official Channel",
                  url: "https://t.me/fruit_cut_play"
                }
              ]
            ]
          }
        })
      });
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("ERROR:", err);
    return res.status(200).json({ ok: true });
  }
}
