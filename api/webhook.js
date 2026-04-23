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
      await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: "🚀 Welcome to NEWTUBE TON BOT\n\nJoin our official channel 👇",
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
