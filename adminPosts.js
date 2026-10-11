// lib/adminPosts.js
// Admin-bot flows that POST TO THE TELEGRAM CHANNEL:
//   1) Promo codes  : how it works -> FC per code -> users per code -> validity ->
//                     post text -> preview -> ONE tap posts photo + codes + button.
//   2) Channel Post : templates (Bot Update / Event / Maintenance / Custom),
//                     photo choice, up to 3 buttons, pin + silent toggles, preview,
//                     recent posts with delete.
//
// Kept in lib/ (not api/) because the Vercel Hobby plan allows only 12 functions.
// api/bot.js calls handleCallback() / handleMessage() with a ctx object.
//
// Banner photo — never depends on one fragile thing. Order tried:
//   saved Telegram file_id  ->  assets/promo_banner.jpg upload  ->  site URL  ->  text only.
// (The previous version crashed with "Something went wrong" when the jpg was not
// deployed.) The admin can also set the banner from the bot: Promo Codes -> Set Banner.

const fs = require('fs');
const path = require('path');

const CHANNEL = '@fruit_cut_chennel';
const CHANNEL_LINK = 'https://t.me/fruit_cut_chennel';
const SITE_URL = 'https://fruit-cut-eight.vercel.app';
const BANNER_FILE = path.join(process.cwd(), 'assets', 'promo_banner.jpg');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => Number(n).toLocaleString('en-US');
const hoursLabel = (h) => (h >= 48 && h % 24 === 0 ? `${h / 24} days` : `${h} hours`);
const cancelRow = (cb) => [{ text: '❌ Cancel', callback_data: cb }];

// ── Banner / sending ────────────────────────────────────────────────
async function getBannerFileId(ctx) {
  const col = await ctx.getCollection('settings');
  const d = await col.findOne({ _id: 'promo_banner' });
  return (d && d.fileId) || null;
}
async function saveBannerFileId(ctx, fileId) {
  const col = await ctx.getCollection('settings');
  if (fileId) await col.updateOne({ _id: 'promo_banner' }, { $set: { fileId, updatedAt: new Date() } }, { upsert: true });
  else await col.deleteOne({ _id: 'promo_banner' });
}
const fileIdFromResult = (r) => {
  const p = r && r.result && r.result.photo;
  return p && p.length ? p[p.length - 1].file_id : null;
};
// Errors where trying another photo source is pointless (the text/target itself is wrong).
const FATAL = /parse entities|too long|Forbidden|chat not found|not enough rights|kicked|bot was blocked|have no rights/i;

async function uploadBannerFile(chatId, caption, markup, silent) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  if (markup) form.append('reply_markup', JSON.stringify(markup));
  if (silent) form.append('disable_notification', 'true');
  form.append('photo', new Blob([fs.readFileSync(BANNER_FILE)], { type: 'image/jpeg' }), 'promo_banner.jpg');
  const res = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form });
  return res.json();
}

// o: { noPhoto, photoFileId, silent }
async function sendWithBanner(ctx, chatId, caption, markup, o = {}) {
  const base = { chat_id: chatId, parse_mode: 'HTML' };
  if (markup) base.reply_markup = markup;
  if (o.silent) base.disable_notification = true;

  if (o.noPhoto || caption.length > 1024) {
    const r = await ctx.tgApi('sendMessage', { ...base, text: caption, disable_web_page_preview: true });
    return { ...r, mode: 'text', tooLongForPhoto: !o.noPhoto };
  }

  const remember = async (r) => {
    if (r && r.ok && !o.photoFileId) {
      const id = fileIdFromResult(r);
      if (id) await saveBannerFileId(ctx, id).catch(() => {});
    }
  };

  // 1) a specific photo (post-only) or the saved banner file_id
  const fid = o.photoFileId || (await getBannerFileId(ctx).catch(() => null));
  if (fid) {
    const r = await ctx.tgApi('sendPhoto', { ...base, photo: fid, caption });
    if (r.ok) return { ...r, mode: 'photo' };
    if (FATAL.test(r.description || '')) return r;
  }
  // 2) bundled file (only if it actually exists in the deployment)
  if (!o.photoFileId && fs.existsSync(BANNER_FILE)) {
    try {
      const r = await uploadBannerFile(chatId, caption, markup, o.silent);
      if (r.ok) { await remember(r); return { ...r, mode: 'photo' }; }
      if (FATAL.test(r.description || '')) return r;
    } catch (e) { console.error('banner upload failed:', e.message); }
  }
  // 3) public URL of the deployed site
  if (!o.photoFileId) {
    const r = await ctx.tgApi('sendPhoto', { ...base, photo: `${SITE_URL}/assets/promo_banner.jpg`, caption });
    if (r.ok) { await remember(r); return { ...r, mode: 'photo' }; }
    if (FATAL.test(r.description || '')) return r;
  }
  // 4) last resort: text only — the post must never fail just because of a picture
  const r = await ctx.tgApi('sendMessage', { ...base, text: caption, disable_web_page_preview: true });
  return { ...r, mode: 'text', bannerMissing: true };
}

const appMarkup = (ctx) => ({ inline_keyboard: [[{ text: '🎮 Open Mini App', url: ctx.MINI_APP_URL }]] });
const postLink = (messageId) => `${CHANNEL_LINK}/${messageId}`;

// ══════════════════════════════════════════════════════════════════
// 1) PROMO CODES
// ══════════════════════════════════════════════════════════════════
function buildPromoPost(st, codes) {
  const intro = st.introText || '🎁 <b>NEW PROMO CODES!</b> 🎁';
  const uses = st.maxUses > 0 ? `👥 First <b>${st.maxUses}</b> user(s) per code` : '👥 Open to everyone';
  return (
    `${intro}\n\n` +
    `🎟️ Code 1: <code>${codes[0]}</code>\n` +
    `🎟️ Code 2: <code>${codes[1]}</code>\n\n` +
    `🍎 Reward: <b>${fmt(st.rewardFc)} Fruit Coin</b> each\n` +
    `${uses}\n` +
    `⏳ Valid for <b>${hoursLabel(st.hours)}</b>\n\n` +
    `👉 Open the Mini App → Profile → <b>Redeem Promo Code</b>\n` +
    `Tap a code to copy it. Hurry up! 🔥`
  );
}

const promoMenu = {
  inline_keyboard: [
    [{ text: '➕ Generate 2 Codes', callback_data: 'a_promo_gen' }],
    [{ text: '📜 Active Codes', callback_data: 'a_promo_list' }],
    [{ text: '🖼 Set Banner Photo', callback_data: 'pr_banner' }],
    [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }],
  ],
};

async function promoAskFc(ctx) {
  await ctx.setAdminState(ctx.fromId, { step: 'pr_fc' });
  await ctx.edit(ctx.chatId, ctx.msgId, '🎟️ <b>Step 1/4 — Fruit Coin</b>\n\nHow much <b>Fruit Coin</b> should EACH code give?\nTap a quick amount or type any number:', {
    reply_markup: { inline_keyboard: [
      [{ text: '50', callback_data: 'pr_fc_50' }, { text: '100', callback_data: 'pr_fc_100' }, { text: '200', callback_data: 'pr_fc_200' }],
      [{ text: '500', callback_data: 'pr_fc_500' }, { text: '1000', callback_data: 'pr_fc_1000' }],
      cancelRow('pr_cancel'),
    ] },
  });
}
async function promoAskUses(ctx, st) {
  await ctx.setAdminState(ctx.fromId, { ...st, step: 'pr_uses' });
  const text = `🍎 Fruit Coin: ✅ <b>${fmt(st.rewardFc)}</b> per code\n\n<b>Step 2/4 — Users</b>\n\nHow many users can claim EACH code?\nTap a quick number or type any number:`;
  const extra = { reply_markup: { inline_keyboard: [
    [{ text: '10', callback_data: 'pr_uses_10' }, { text: '50', callback_data: 'pr_uses_50' }, { text: '100', callback_data: 'pr_uses_100' }],
    [{ text: '500', callback_data: 'pr_uses_500' }, { text: '♾ Unlimited', callback_data: 'pr_uses_0' }],
    cancelRow('pr_cancel'),
  ] } };
  return ctx.viaButton ? ctx.edit(ctx.chatId, ctx.msgId, text, extra) : ctx.send(ctx.chatId, text, extra);
}
async function promoAskHours(ctx, st) {
  await ctx.setAdminState(ctx.fromId, { ...st, step: 'pr_hrs' });
  const text = `👥 Users per code: ✅ <b>${st.maxUses > 0 ? st.maxUses : 'Unlimited'}</b>\n\n<b>Step 3/4 — Validity</b>\n\nHow long should the codes stay valid?`;
  const extra = { reply_markup: { inline_keyboard: [
    [{ text: '6 h', callback_data: 'pr_hrs_6' }, { text: '12 h', callback_data: 'pr_hrs_12' }, { text: '24 h', callback_data: 'pr_hrs_24' }],
    [{ text: '48 h', callback_data: 'pr_hrs_48' }, { text: '72 h', callback_data: 'pr_hrs_72' }],
    cancelRow('pr_cancel'),
  ] } };
  return ctx.viaButton ? ctx.edit(ctx.chatId, ctx.msgId, text, extra) : ctx.send(ctx.chatId, text, extra);
}
async function promoAskText(ctx, st) {
  await ctx.setAdminState(ctx.fromId, { ...st, step: 'pr_text' });
  await ctx.edit(ctx.chatId, ctx.msgId, `⏳ Validity: ✅ <b>${hoursLabel(st.hours)}</b>\n\n<b>Step 4/4 — Post text</b>\n\nWhat should be written at the top of the channel post?\n(The codes, reward, users, validity and "how to redeem" lines are added automatically.)`, {
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Use default text', callback_data: 'pr_text_default' }],
      [{ text: '✍️ Write my own text', callback_data: 'pr_text_custom' }],
      cancelRow('pr_cancel'),
    ] },
  });
}

async function promoPreview(ctx, st) {
  const codes = st.codes && st.codes.length === 2 ? st.codes : [ctx.generateCode(), ctx.generateCode()];
  const state = { ...st, codes, step: 'pr_confirm' };
  await ctx.setAdminState(ctx.fromId, state);
  const post = buildPromoPost(state, codes);
  const r = await sendWithBanner(ctx, ctx.chatId, post, appMarkup(ctx));
  if (!r.ok) {
    await ctx.send(ctx.chatId, `⚠️ Telegram rejected this post:\n<code>${esc(r.description || 'unknown error')}</code>\n\nIf you used HTML tags, check they are closed. Please write the text again.`, {
      reply_markup: { inline_keyboard: [[{ text: '✍️ Write text again', callback_data: 'pr_text_custom' }], cancelRow('pr_cancel')] },
    });
    return;
  }
  await ctx.send(ctx.chatId,
    `👆 <b>This is exactly how the post will look in ${CHANNEL}.</b>\n` +
      (r.bannerMissing ? `⚠️ No banner photo is available, so it will be posted as text. Use Promo Codes → Set Banner Photo.\n` : '') +
      `\nThe codes become active (timer starts) only when you tap Confirm.`,
    { reply_markup: { inline_keyboard: [
      [{ text: '✅ Confirm & Post to Channel', callback_data: 'pr_confirm' }],
      [{ text: '✏️ Edit Text', callback_data: 'pr_edit_text' }, { text: '🔄 New Codes', callback_data: 'pr_newcodes' }],
      cancelRow('pr_cancel'),
    ] } });
}

async function promoConfirm(ctx) {
  const st = await ctx.getAdminState(ctx.fromId);
  if (!st || st.step !== 'pr_confirm' || !st.codes) return;
  await ctx.clearAdminState(ctx.fromId);

  const created = [];
  for (const code of st.codes) {
    created.push(await ctx.createPromoCode({ rewardFc: st.rewardFc, maxUses: st.maxUses, createdBy: ctx.fromId, code, ttlHours: st.hours }));
  }
  const posted = await sendWithBanner(ctx, CHANNEL, buildPromoPost(st, created.map((c) => c.code)), appMarkup(ctx));

  if (posted.ok) {
    const link = posted.result && posted.result.message_id ? postLink(posted.result.message_id) : CHANNEL_LINK;
    await ctx.send(ctx.chatId,
      `✅ <b>Posted to ${CHANNEL}!</b>\n\n🎟️ <code>${created[0].code}</code>\n🎟️ <code>${created[1].code}</code>\n\n🍎 ${fmt(st.rewardFc)} FC each · 👥 ${st.maxUses > 0 ? st.maxUses + ' users' : 'unlimited'} · ⏳ ${hoursLabel(st.hours)}\n🔗 ${link}` +
        (posted.bannerMissing ? `\n\n⚠️ Posted as text (no banner photo found). Set one: Promo Codes → Set Banner Photo.` : ''),
      { reply_markup: promoMenu, disable_web_page_preview: true });
    await recordPost(ctx, { kind: 'promo', text: 'Promo codes ' + created.map((c) => c.code).join(', '), messageId: posted.result && posted.result.message_id });
  } else {
    const col = await ctx.getCollection('promoCodes');
    await col.deleteMany({ code: { $in: created.map((c) => c.code) } });
    await ctx.send(ctx.chatId,
      `❌ <b>Channel post failed</b> — codes were NOT created.\n\nTelegram says: <code>${esc(posted.description || 'unknown error')}</code>\n\nMake sure the bot is an <b>admin</b> of ${CHANNEL} with permission to post messages.`,
      { reply_markup: promoMenu });
  }
}

// ══════════════════════════════════════════════════════════════════
// 2) CHANNEL POST
// ══════════════════════════════════════════════════════════════════
const KINDS = {
  update: { label: '🚀 Bot Update', ask: 'Send the update points, <b>one per line</b>.\nExample:\n<i>Withdraw history icon added\nNew All Games section</i>' },
  event: { label: '🎁 Event / Giveaway', ask: 'Send the event text.\n<b>First line = title</b>, the next lines = details (one per line).\nExample:\n<i>Weekend Giveaway\nTop 10 slashers win 500 FC\nEnds Sunday 12 PM</i>' },
  maintenance: { label: '🛠 Maintenance', ask: 'Send the notice points, <b>one per line</b>.\nExample:\n<i>Server upgrade today 10 PM - 11 PM\nWithdrawals paused during this time</i>' },
  custom: { label: '✍️ Custom', ask: 'Send the full post text. HTML works: &lt;b&gt;bold&lt;/b&gt;, &lt;i&gt;italic&lt;/i&gt;, &lt;code&gt;code&lt;/code&gt;.' },
};
const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);

function buildChannelText(st) {
  const L = lines(st.text);
  if (st.kind === 'update') return `🚀 <b>BOT UPDATE</b> 🚀\n\n${L.map((l) => `✅ ${esc(l)}`).join('\n')}\n\n🍎 Open the Mini App and enjoy!`;
  if (st.kind === 'event') {
    const title = L.shift() || 'Special Event';
    return `🎁 <b>${esc(title)}</b> 🎁\n\n${L.map((l) => `🔥 ${esc(l)}`).join('\n')}${L.length ? '\n\n' : ''}👇 Join now in the Mini App!`;
  }
  if (st.kind === 'maintenance') return `🛠 <b>MAINTENANCE NOTICE</b> 🛠\n\n${L.map((l) => `⚠️ ${esc(l)}`).join('\n')}\n\nThank you for your patience! 🙏`;
  return String(st.text || '');
}
const buttonsMarkup = (st) => (st.buttons && st.buttons.length ? { inline_keyboard: st.buttons.map((b) => [{ text: b.text, url: b.url }]) } : undefined);
const photoOpts = (st) => ({ noPhoto: st.photoMode === 'none', photoFileId: st.photoMode === 'custom' ? st.photoFileId : undefined });

async function recordPost(ctx, doc) {
  try { await (await ctx.getCollection('channelPosts')).insertOne({ ...doc, createdAt: new Date() }); } catch (e) { /* history only */ }
}

async function cpMenu(ctx) {
  await ctx.clearAdminState(ctx.fromId);
  await ctx.edit(ctx.chatId, ctx.msgId, `📣 <b>Channel Post</b>\n\nPost to ${CHANNEL} any time. Pick a template:`, {
    reply_markup: { inline_keyboard: [
      [{ text: KINDS.update.label, callback_data: 'cp_kind_update' }, { text: KINDS.event.label, callback_data: 'cp_kind_event' }],
      [{ text: KINDS.maintenance.label, callback_data: 'cp_kind_maintenance' }, { text: KINDS.custom.label, callback_data: 'cp_kind_custom' }],
      [{ text: '🕘 Recent Posts / Delete', callback_data: 'cp_recent' }],
      [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }],
    ] },
  });
}
async function cpAskPhoto(ctx, st, viaEdit = true) {
  await ctx.setAdminState(ctx.fromId, { ...st, step: 'cp_photo' });
  const text = `📣 <b>${KINDS[st.kind].label} — Step 1/3: Photo</b>\n\nWhich photo should the post have?`;
  const extra = { reply_markup: { inline_keyboard: [
    [{ text: '🖼 Default banner', callback_data: 'cp_photo_default' }],
    [{ text: '📤 Send my own photo', callback_data: 'cp_photo_send' }],
    [{ text: '⏭ No photo (text only)', callback_data: 'cp_photo_none' }],
    cancelRow('cp_cancel'),
  ] } };
  return viaEdit ? ctx.edit(ctx.chatId, ctx.msgId, text, extra) : ctx.send(ctx.chatId, text, extra);
}
async function cpAskText(ctx, st, viaEdit = true) {
  await ctx.setAdminState(ctx.fromId, { ...st, step: 'cp_text' });
  const text = `📣 <b>${KINDS[st.kind].label} — Step 2/3: Text</b>\n\n${KINDS[st.kind].ask}`;
  const extra = { reply_markup: { inline_keyboard: [cancelRow('cp_cancel')] } };
  return viaEdit ? ctx.edit(ctx.chatId, ctx.msgId, text, extra) : ctx.send(ctx.chatId, text, extra);
}
async function cpAskButtons(ctx, st, viaEdit = true) {
  await ctx.setAdminState(ctx.fromId, { ...st, step: 'cp_buttons' });
  const hasApp = (st.buttons || []).some((b) => b.url === ctx.MINI_APP_URL);
  const list = (st.buttons || []).map((b, i) => `${i + 1}. ${esc(b.text)} → ${esc(b.url)}`).join('\n') || '— none —';
  const text = `📣 <b>${KINDS[st.kind].label} — Step 3/3: Buttons</b>\n\nButtons under the post (max 3):\n${list}`;
  const extra = { disable_web_page_preview: true, reply_markup: { inline_keyboard: [
    [{ text: hasApp ? '🎮 Mini App button: ✅ ON' : '🎮 Mini App button: ❌ OFF', callback_data: 'cp_btn_app' }],
    [{ text: '➕ Add custom button', callback_data: 'cp_btn_add' }, { text: '🧹 Clear custom', callback_data: 'cp_btn_clear' }],
    [{ text: '👀 Preview →', callback_data: 'cp_btn_done' }],
    cancelRow('cp_cancel'),
  ] } };
  return viaEdit ? ctx.edit(ctx.chatId, ctx.msgId, text, extra) : ctx.send(ctx.chatId, text, extra);
}
function cpControlKb(st) {
  return { inline_keyboard: [
    [{ text: '✅ Post Now', callback_data: 'cp_post' }],
    [{ text: st.pin ? '📌 Pin: ON' : '📌 Pin: OFF', callback_data: 'cp_pin' }, { text: st.silent ? '🔕 Silent: ON' : '🔔 Silent: OFF', callback_data: 'cp_silent' }],
    [{ text: '✏️ Edit Text', callback_data: 'cp_edit' }, { text: '🔘 Edit Buttons', callback_data: 'cp_btn_back' }],
    cancelRow('cp_cancel'),
  ] };
}
async function cpPreview(ctx, st) {
  const state = { ...st, step: 'cp_confirm' };
  await ctx.setAdminState(ctx.fromId, state);
  const r = await sendWithBanner(ctx, ctx.chatId, buildChannelText(state), buttonsMarkup(state), photoOpts(state));
  if (!r.ok) {
    await ctx.send(ctx.chatId, `⚠️ Telegram rejected this post:\n<code>${esc(r.description || 'unknown error')}</code>\n\nIf you used HTML tags, check they are closed.`, {
      reply_markup: { inline_keyboard: [[{ text: '✏️ Edit Text', callback_data: 'cp_edit' }], cancelRow('cp_cancel')] },
    });
    return;
  }
  await ctx.send(ctx.chatId,
    `👆 <b>This is exactly how the post will look in ${CHANNEL}.</b>` +
      (r.mode === 'text' && state.photoMode !== 'none' ? `\n⚠️ No photo available — it will be posted as text.` : '') +
      `\n\nPin it? Send silently (no notification sound)?`,
    { reply_markup: cpControlKb(state) });
}
async function cpPost(ctx) {
  const st = await ctx.getAdminState(ctx.fromId);
  if (!st || st.step !== 'cp_confirm') return;
  await ctx.clearAdminState(ctx.fromId);
  const r = await sendWithBanner(ctx, CHANNEL, buildChannelText(st), buttonsMarkup(st), { ...photoOpts(st), silent: !!st.silent });
  if (!r.ok) {
    await ctx.send(ctx.chatId, `❌ <b>Post failed</b>\n\nTelegram says: <code>${esc(r.description || 'unknown error')}</code>\n\nMake sure the bot is an admin of ${CHANNEL} and can post messages.`, { reply_markup: ctx.adminKb });
    return;
  }
  const mid = r.result && r.result.message_id;
  let pinNote = '';
  if (st.pin && mid) {
    const p = await ctx.tgApi('pinChatMessage', { chat_id: CHANNEL, message_id: mid, disable_notification: true });
    pinNote = p.ok ? '\n📌 Pinned.' : `\n⚠️ Could not pin (give the bot the "Pin messages" right): ${esc(p.description || '')}`;
  }
  await recordPost(ctx, { kind: st.kind, text: lines(st.text)[0] || buildChannelText(st).slice(0, 60), messageId: mid });
  await ctx.send(ctx.chatId, `✅ <b>Posted to ${CHANNEL}!</b>${pinNote}${mid ? `\n🔗 ${postLink(mid)}` : ''}`, { reply_markup: ctx.adminKb, disable_web_page_preview: true });
}
async function cpRecent(ctx) {
  const col = await ctx.getCollection('channelPosts');
  const list = await col.find({ messageId: { $exists: true } }).sort({ createdAt: -1 }).limit(6).toArray();
  if (!list.length) {
    await ctx.edit(ctx.chatId, ctx.msgId, '🕘 No posts recorded yet.', { reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'a_chpost' }]] } });
    return;
  }
  const rows = list.map((p) => [
    { text: `🔗 ${String(p.text || p.kind).slice(0, 22)}`, url: postLink(p.messageId) },
    { text: '🗑 Delete', callback_data: `cp_del_${p._id}` },
  ]);
  rows.push([{ text: '◀️ Back', callback_data: 'a_chpost' }]);
  await ctx.edit(ctx.chatId, ctx.msgId, `🕘 <b>Recent channel posts</b>\n\n🗑 Delete removes the post from ${CHANNEL} too.`, { reply_markup: { inline_keyboard: rows } });
}

// ══════════════════════════════════════════════════════════════════
// ENTRY POINTS used by api/bot.js
// ══════════════════════════════════════════════════════════════════
// Returns true when the callback was handled here.
async function handleCallback(data, ctx0) {
  const ctx = { ...ctx0, viaButton: true };
  const st = async () => (await ctx.getAdminState(ctx.fromId)) || {};

  // ── promo codes ──
  if (data === 'a_promo_gen') {
    await ctx.clearAdminState(ctx.fromId);
    await ctx.edit(ctx.chatId, ctx.msgId,
      `🎟️ <b>Generate Promo Codes — how it works</b>\n\n` +
        `Every time you generate, the bot creates <b>2 codes</b> at once.\n\n` +
        `1️⃣ Choose how much Fruit Coin each code gives\n` +
        `2️⃣ Choose how many users can claim each code\n` +
        `3️⃣ Choose how long the codes stay valid\n` +
        `4️⃣ Choose the text written in the channel post\n\n` +
        `Then you see a <b>preview</b> (photo + codes + Open Mini App button). Tap <b>Confirm</b> and it is posted to ${CHANNEL} instantly.`,
      { reply_markup: { inline_keyboard: [[{ text: '▶️ Start', callback_data: 'pr_start' }], [{ text: '◀️ Back', callback_data: 'a_promo' }]] } });
    return true;
  }
  if (data === 'pr_start') { await promoAskFc(ctx); return true; }
  if (data === 'pr_cancel') {
    await ctx.clearAdminState(ctx.fromId);
    await ctx.edit(ctx.chatId, ctx.msgId, '❌ Promo code creation cancelled.', { reply_markup: promoMenu });
    return true;
  }
  if (data.startsWith('pr_fc_')) { const s = await st(); if (s.step !== 'pr_fc') return true; await promoAskUses(ctx, { rewardFc: parseInt(data.slice(6), 10) }); return true; }
  if (data.startsWith('pr_uses_')) { const s = await st(); if (s.step !== 'pr_uses') return true; await promoAskHours(ctx, { ...s, maxUses: parseInt(data.slice(8), 10) }); return true; }
  if (data.startsWith('pr_hrs_')) { const s = await st(); if (s.step !== 'pr_hrs') return true; await promoAskText(ctx, { ...s, hours: parseInt(data.slice(7), 10) }); return true; }
  if (data === 'pr_text_default') { const s = await st(); if (s.step !== 'pr_text') return true; await promoPreview(ctx, { ...s, introText: '' }); return true; }
  if (data === 'pr_text_custom') {
    const s = await st();
    if (!s.rewardFc) return true;
    await ctx.setAdminState(ctx.fromId, { ...s, step: 'pr_text_wait' });
    await ctx.send(ctx.chatId, '✍️ Send the text for the top of the post (HTML works, e.g. <code>&lt;b&gt;Weekend Bonus!&lt;/b&gt;</code>).\nThe codes and details are added automatically.', { reply_markup: { inline_keyboard: [cancelRow('pr_cancel')] } });
    return true;
  }
  if (data === 'pr_edit_text') { const s = await st(); if (!s.rewardFc) return true; await promoAskText(ctx, s); return true; }
  if (data === 'pr_newcodes') { const s = await st(); if (!s.rewardFc) return true; await promoPreview(ctx, { ...s, codes: null }); return true; }
  if (data === 'pr_confirm') { await promoConfirm(ctx); return true; }
  if (data === 'pr_banner') {
    await ctx.setAdminState(ctx.fromId, { step: 'pr_banner_wait' });
    await ctx.edit(ctx.chatId, ctx.msgId, '🖼 <b>Banner photo</b>\n\nSend the photo that should appear on promo posts (and on channel posts that use the default banner).', {
      reply_markup: { inline_keyboard: [[{ text: '♻️ Reset to bundled default', callback_data: 'pr_banner_reset' }], cancelRow('pr_cancel')] },
    });
    return true;
  }
  if (data === 'pr_banner_reset') {
    await saveBannerFileId(ctx, null);
    await ctx.clearAdminState(ctx.fromId);
    await ctx.edit(ctx.chatId, ctx.msgId, '♻️ Banner reset. The bundled image is used again.', { reply_markup: promoMenu });
    return true;
  }

  // ── channel post ──
  if (data === 'a_chpost') { await cpMenu(ctx); return true; }
  if (data.startsWith('cp_kind_')) {
    const kind = data.slice(8);
    if (!KINDS[kind]) return true;
    await cpAskPhoto(ctx, { kind, buttons: [{ text: '🎮 Open Mini App', url: ctx.MINI_APP_URL }], pin: false, silent: false, photoMode: 'default' });
    return true;
  }
  if (data === 'cp_cancel') {
    await ctx.clearAdminState(ctx.fromId);
    await ctx.edit(ctx.chatId, ctx.msgId, '❌ Channel post cancelled.', { reply_markup: ctx.backKb });
    return true;
  }
  if (data === 'cp_photo_default' || data === 'cp_photo_none') {
    const s = await st(); if (!s.kind) return true;
    await cpAskText(ctx, { ...s, photoMode: data === 'cp_photo_none' ? 'none' : 'default' });
    return true;
  }
  if (data === 'cp_photo_send') {
    const s = await st(); if (!s.kind) return true;
    await ctx.setAdminState(ctx.fromId, { ...s, step: 'cp_photo_wait' });
    await ctx.edit(ctx.chatId, ctx.msgId, '📤 Send the photo for this post now:', { reply_markup: { inline_keyboard: [cancelRow('cp_cancel')] } });
    return true;
  }
  if (data === 'cp_btn_app') {
    const s = await st(); if (!s.kind) return true;
    const has = (s.buttons || []).some((b) => b.url === ctx.MINI_APP_URL);
    const buttons = has ? s.buttons.filter((b) => b.url !== ctx.MINI_APP_URL) : [{ text: '🎮 Open Mini App', url: ctx.MINI_APP_URL }, ...(s.buttons || [])].slice(0, 3);
    await cpAskButtons(ctx, { ...s, buttons });
    return true;
  }
  if (data === 'cp_btn_add') {
    const s = await st(); if (!s.kind) return true;
    if ((s.buttons || []).length >= 3) { await ctx.answer(ctx.cbId, 'Max 3 buttons'); return true; }
    await ctx.setAdminState(ctx.fromId, { ...s, step: 'cp_btn_wait' });
    await ctx.edit(ctx.chatId, ctx.msgId, 'Send the button as:\n<code>Button text | https://link</code>', { reply_markup: { inline_keyboard: [cancelRow('cp_cancel')] } });
    return true;
  }
  if (data === 'cp_btn_clear') {
    const s = await st(); if (!s.kind) return true;
    await cpAskButtons(ctx, { ...s, buttons: (s.buttons || []).filter((b) => b.url === ctx.MINI_APP_URL) });
    return true;
  }
  if (data === 'cp_btn_done') { const s = await st(); if (!s.kind) return true; await cpPreview(ctx, s); return true; }
  if (data === 'cp_btn_back') { const s = await st(); if (!s.kind) return true; await cpAskButtons(ctx, s, false); return true; }
  if (data === 'cp_edit') { const s = await st(); if (!s.kind) return true; await cpAskText(ctx, s, false); return true; }
  if (data === 'cp_pin' || data === 'cp_silent') {
    const s = await st(); if (s.step !== 'cp_confirm') return true;
    const ns = data === 'cp_pin' ? { ...s, pin: !s.pin } : { ...s, silent: !s.silent };
    await ctx.setAdminState(ctx.fromId, ns);
    await ctx.tgApi('editMessageReplyMarkup', { chat_id: ctx.chatId, message_id: ctx.msgId, reply_markup: cpControlKb(ns) });
    return true;
  }
  if (data === 'cp_post') { await cpPost(ctx); return true; }
  if (data === 'cp_recent') { await cpRecent(ctx); return true; }
  if (data.startsWith('cp_del_')) {
    const col = await ctx.getCollection('channelPosts');
    try {
      const doc = await col.findOne({ _id: new ctx.ObjectId(data.slice(7)) });
      if (doc && doc.messageId) {
        const d = await ctx.tgApi('deleteMessage', { chat_id: CHANNEL, message_id: doc.messageId });
        await col.deleteOne({ _id: doc._id });
        await ctx.answer(ctx.cbId, d.ok ? '🗑 Deleted from channel' : 'Removed from list (Telegram: ' + (d.description || 'could not delete') + ')');
      }
    } catch (e) { console.error('cp_del failed:', e); }
    await cpRecent(ctx);
    return true;
  }
  return false;
}

// Returns true when the message was consumed by one of these flows.
async function handleMessage(s, text, msg, ctx0) {
  const ctx = { ...ctx0, viaButton: false };
  if (!s || !s.step) return false;
  const photo = msg && msg.photo && msg.photo.length ? msg.photo[msg.photo.length - 1].file_id : null;

  if (s.step === 'pr_fc') {
    const fc = parseInt(text, 10);
    if (isNaN(fc) || fc <= 0) { await ctx.send(ctx.chatId, '❌ Enter a valid positive number (e.g. 100):'); return true; }
    await promoAskUses(ctx, { rewardFc: fc });
    return true;
  }
  if (s.step === 'pr_uses') {
    const n = parseInt(text, 10);
    if (isNaN(n) || n < 0) { await ctx.send(ctx.chatId, '❌ Enter 0 (unlimited) or a positive number:'); return true; }
    await promoAskHours(ctx, { ...s, maxUses: n });
    return true;
  }
  if (s.step === 'pr_text_wait') {
    if (!text) { await ctx.send(ctx.chatId, '⚠️ Send the text as a normal message.'); return true; }
    await promoPreview(ctx, { ...s, introText: text });
    return true;
  }
  if (s.step === 'pr_banner_wait') {
    if (!photo) { await ctx.send(ctx.chatId, '⚠️ Please send a photo.'); return true; }
    await saveBannerFileId(ctx, photo);
    await ctx.clearAdminState(ctx.fromId);
    await ctx.send(ctx.chatId, '✅ Banner saved. It will be used for promo posts and default-banner channel posts.', { reply_markup: promoMenu });
    return true;
  }
  if (s.step === 'cp_photo_wait') {
    if (!photo) { await ctx.send(ctx.chatId, '⚠️ Please send a photo.'); return true; }
    await cpAskText(ctx, { ...s, photoMode: 'custom', photoFileId: photo }, false);
    return true;
  }
  if (s.step === 'cp_text') {
    if (!text) { await ctx.send(ctx.chatId, '⚠️ Send the text as a normal message.'); return true; }
    await cpAskButtons(ctx, { ...s, text }, false);
    return true;
  }
  if (s.step === 'cp_btn_wait') {
    const parts = text.split('|').map((x) => x.trim());
    if (parts.length !== 2 || !parts[0] || !/^https?:\/\//i.test(parts[1])) { await ctx.send(ctx.chatId, '❌ Format: <code>Button text | https://link</code>'); return true; }
    await cpAskButtons(ctx, { ...s, buttons: [...(s.buttons || []), { text: parts[0].slice(0, 40), url: parts[1] }].slice(0, 3) }, false);
    return true;
  }
  return false;
}

module.exports = { handleCallback, handleMessage, promoMenu, CHANNEL };
