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

  // "/start" অথবা "/start refer_id" দিয়ে শুরু হলে কাজ করবে
  if (text && text.startsWith("/start")) {

    // 🔥 Firebase Database URL (Project ID: fruit-cut-477ab)
    const firebaseUrl = `https://fruit-cut-477ab-default-rtdb.firebaseio.com/users/${chatId}.json`;

    await fetch(firebaseUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        joinedAt: Date.now()
      })
    });

    // 🔗 Telegram Mini App Link with Refer System
    const miniAppUrl = `https://t.me/Fruit_cut_bot/PlayTo_Earn?startapp=${chatId}`;
    
    // 🎁 Share Link Generation
    const shareMessage = "🍓 Play Fruit Cut & Earn! Join using my link and win TON & USDT:";
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(miniAppUrl)}&text=${encodeURIComponent(shareMessage)}`;

    // 📝 Beautiful Game Description (HTML Format)
    const welcomeDescription = `🍉 <b>Welcome to Fruit Cut Play-To-Earn!</b> 🥷⚔️

Get ready to slice, dice, and EARN! 🍓🍍
Play our fun fruit-cutting game and convert your skills into real crypto rewards. 💰

💸 <b>Earn Crypto:</b> Win <b>TON</b> & <b>USDT</b> directly to your wallet!
🎮 <b>Play to Earn:</b> The more fruits you slice, the more you earn.
🎁 <b>Refer & Earn:</b> Invite friends and get huge bonuses!

Are you ready to become the ultimate Fruit Master? 🏆👇
Click <b>"🎮 Play & Earn"</b> below to start your journey!`;

    // ✅ Welcome Message + New Buttons
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: welcomeDescription,
        parse_mode: "HTML", // লেখাগুলো সুন্দর ও বোল্ড দেখানোর জন্য
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🎮 Play & Earn",
                url: miniAppUrl
              }
            ],
            [
              {
                text: "📢 Official Channel",
                url: "https://t.me/fruit_cut_play"
              }
            ],
            [
              {
                text: "🎁 Share Refer Link",
                url: shareUrl
              }
            ]
          ]
        }
      })
    });

  }

  return res.status(200).json({ ok: true });
}
