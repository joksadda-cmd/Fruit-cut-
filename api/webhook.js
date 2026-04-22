import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Firebase Admin init (once)
let app;
if (!global.firebaseApp) {
  app = initializeApp({
    credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
  global.firebaseApp = app;
} else {
  app = global.firebaseApp;
}

const db = getFirestore(app);

export default async function handler(req, res) {
  const TOKEN = process.env.BOT_TOKEN;

  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  const body = req.body;
  const chatId = body.message?.chat?.id;
  const text = body.message?.text;

  if (!chatId) {
    return res.status(200).json({ ok: true });
  }

  // /start command with referral
  if (text?.startsWith("/start")) {
    const args = text.split(" ");
    const refId = args[1]; // referral id

    // user save
    const userRef = db.collection("users").doc(String(chatId));
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      await userRef.set({
        userId: chatId,
        referredBy: refId || null,
        createdAt: Date.now()
      });

      // referral reward logic (simple)
      if (refId && refId !== String(chatId)) {
        const refUser = db.collection("users").doc(refId);
        await refUser.set({
          points: 10
        }, { merge: true });
      }
    }

    // generate referral link
    const botUsername = "PlayAdse_Bot"; // change if needed
    const referralLink = `https://t.me/${botUsername}?start=${chatId}`;

    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🚀 Welcome to Fruit Cut Play BOT

🎮 Play & Earn TON easily!

👥 Your Referral Link:
${referralLink}

Share and earn rewards 💰`,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🎮 Play Game",
                web_app: {
                  url: "https://your-mini-app-link.vercel.app"
                }
              }
            ],
            [
              {
                text: "📢 Join Channel",
                url: "https://t.me/fruit_cut_play"
              }
            ],
            [
              {
                text: "🔗 Share & Earn",
                url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=Play this game & earn TON 🚀`
              }
            ]
          ]
        }
      })
    });
  }

  return res.status(200).json({ ok: true });
}
