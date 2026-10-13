// lib/sponsor.js
// "Sponsor & Post Task": a user buys a package with TON and gets a task in the Tasks window.
//
// FLOW
//   1. createOrder()   -> order saved as 'awaiting_payment' with a unique memo (comment), e.g. FC7K2M9QXA
//   2. user sends the exact TON amount to TON_DEPOSIT_ADDRESS with that memo as the comment
//   3. scanDeposits()  -> reads the wallet's recent incoming transfers (toncenter), matches the memo,
//                         adds the amount to the order, and when paid >= price the task goes live.
//      It is called by the cron (GET /api/cron_ton_deposits, external scheduler) AND by the
//      "Check payment" button in the app, so users usually don't even wait for the cron.
//
// ENV (Vercel):
//   TON_DEPOSIT_ADDRESS  required  - the TON wallet that receives the money
//   TONCENTER_API_KEY    optional  - free key from @tonapibot (raises toncenter's rate limit)
//   BOT_TOKEN            already set

const crypto = require('crypto');
const { getCollection } = require('./db');
const { SPONSOR_TASK } = require('./constants');
const { sendTelegramMessage } = require('./notify');

const toNano = (ton) => BigInt(Math.round(Number(ton) * 1e9));

// ── tiny Telegram helper ────────────────────────────────────────────
async function tg(method, params) {
  const token = process.env.BOT_TOKEN;
  try {
    const qs = new URLSearchParams(params).toString();
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}?${qs}`, { signal: AbortSignal.timeout(6000) });
    return await r.json();
  } catch (e) {
    return { ok: false, description: String(e && e.message) };
  }
}
const botId = () => String(process.env.BOT_TOKEN || '').split(':')[0];

function normalizeUsername(input) {
  let s = String(input || '').trim();
  s = s.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '').replace(/^@/, '').split(/[/?#]/)[0];
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(s) ? s : null;
}

function cleanTitle(input) {
  return String(input || '').replace(/[<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function cleanUrl(input) {
  const s = String(input || '').trim();
  if (s.length > 250 || !/^https:\/\/[^\s]+$/i.test(s)) return null;
  try { const u = new URL(s); return u.protocol === 'https:' ? u.toString() : null; } catch (e) { return null; }
}

// ── "Verify Bot": is our bot an admin there, and is the poster an admin/owner too? ──
async function verifyBotAdmin(usernameInput, posterTelegramId) {
  const username = normalizeUsername(usernameInput);
  if (!username) return { ok: false, error: 'bad_username' };

  const chat = await tg('getChat', { chat_id: '@' + username });
  if (!chat.ok || !chat.result) return { ok: false, error: 'chat_not_found' };
  const c = chat.result;
  if (!['channel', 'supergroup', 'group'].includes(c.type)) return { ok: false, error: 'not_channel_or_group' };

  const me = await tg('getChatMember', { chat_id: c.id, user_id: botId() });
  if (!me.ok || !me.result || me.result.status !== 'administrator') return { ok: false, error: 'bot_not_admin' };

  const poster = await tg('getChatMember', { chat_id: c.id, user_id: posterTelegramId });
  if (!poster.ok || !poster.result || !['creator', 'administrator'].includes(poster.result.status)) {
    return { ok: false, error: 'user_not_admin' };
  }
  return { ok: true, chatId: String(c.id), username, title: String(c.title || username).slice(0, 60) };
}

// ── Orders ──────────────────────────────────────────────────────────
let idxDone = false;
async function ordersCol() {
  const c = await getCollection('sponsorOrders');
  if (!idxDone) {
    idxDone = true;
    c.createIndex({ memo: 1 }, { unique: true }).catch(() => {});
    c.createIndex({ telegramId: 1, createdAt: -1 }).catch(() => {});
  }
  return c;
}

const newMemo = () => 'FC' + crypto.randomBytes(8).toString('hex').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

const isConfigured = () => !!String(process.env.TON_DEPOSIT_ADDRESS || '').trim();
const depositAddress = () => String(process.env.TON_DEPOSIT_ADDRESS || '').trim();

function publicOrder(o, task) {
  const total = o.users;
  const done = task ? (task.completedCount || 0) : 0;
  let status = o.status;
  if (status === 'active' && task && (!task.active || done >= total)) status = 'completed';
  if (status === 'awaiting_payment' && o.expiresAt && new Date(o.expiresAt) < new Date()) status = 'expired';
  return {
    id: o.memo, title: o.title, kind: o.kind, users: total, ton: o.ton, status,
    done, total, createdAt: o.createdAt, memo: o.memo,
    ...(status === 'awaiting_payment' ? paymentInfo(o) : {}),
  };
}

function paymentInfo(o) {
  const nano = String(o.priceNano);
  const addr = depositAddress();
  const missing = (BigInt(o.priceNano) - BigInt(o.paidNano || 0)).toString();
  const tonAmt = (Number(missing) / 1e9).toFixed(2);
  return {
    pay: {
      address: addr, memo: o.memo, amountTon: tonAmt, amountNano: missing,
      tonkeeper: `https://app.tonkeeper.com/transfer/${addr}?amount=${missing}&text=${o.memo}`,
      deeplink: `ton://transfer/${addr}?amount=${missing}&text=${o.memo}`,
    },
  };
}

async function createOrder(user, body) {
  if (!isConfigured()) return { ok: false, error: 'payments_not_configured' };
  const telegramId = String(user.telegramId);

  const pkg = SPONSOR_TASK.PACKAGES.find((p) => p.users === Number(body.users));
  if (!pkg) return { ok: false, error: 'bad_package' };

  const kind = body.kind === 'normal' ? 'normal' : 'bot';
  const title = cleanTitle(body.title);
  if (title.length < 3) return { ok: false, error: 'bad_title' };

  const col = await ordersCol();
  const open = await col.countDocuments({ telegramId, status: 'awaiting_payment', expiresAt: { $gt: new Date() } });
  if (open >= SPONSOR_TASK.MAX_OPEN_ORDERS) return { ok: false, error: 'too_many_open_orders' };

  let chatId = null, url = '', username = null;
  if (kind === 'bot') {
    const v = await verifyBotAdmin(body.username, telegramId);
    if (!v.ok) return v;
    chatId = v.chatId; username = v.username; url = `https://t.me/${v.username}`;
  } else {
    url = cleanUrl(body.url);
    if (!url) return { ok: false, error: 'bad_url' };
  }

  const now = new Date();
  const order = {
    memo: newMemo(), telegramId, kind, title, chatId, username, url,
    users: pkg.users, ton: pkg.ton, priceNano: toNano(pkg.ton).toString(), paidNano: '0',
    rewardFc: SPONSOR_TASK.REWARD_FC,
    status: 'awaiting_payment', createdAt: now, expiresAt: new Date(now.getTime() + SPONSOR_TASK.ORDER_TTL_MS),
  };
  await col.insertOne(order);
  return { ok: true, order: publicOrder(order, null) };
}

async function listOrders(telegramId) {
  const col = await ordersCol();
  const orders = await col.find({ telegramId: String(telegramId) }).sort({ createdAt: -1 }).limit(30).toArray();
  const taskIds = orders.map((o) => o.taskId).filter(Boolean);
  const tasks = taskIds.length ? await (await getCollection('tasks')).find({ _id: { $in: taskIds } }).toArray() : [];
  const byId = new Map(tasks.map((t) => [String(t._id), t]));
  return orders.map((o) => publicOrder(o, o.taskId ? byId.get(String(o.taskId)) : null));
}

async function getOrder(telegramId, memo) {
  const col = await ordersCol();
  const o = await col.findOne({ memo: String(memo || ''), telegramId: String(telegramId) });
  if (!o) return null;
  const task = o.taskId ? await (await getCollection('tasks')).findOne({ _id: o.taskId }) : null;
  return publicOrder(o, task);
}

// Paid in full -> create the live task (idempotent: only the first caller flips the order).
async function activateOrder(memo) {
  const col = await ordersCol();
  const o = await col.findOneAndUpdate(
    { memo, status: { $in: ['awaiting_payment', 'expired'] } },
    { $set: { status: 'activating', paidAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!o) return false;

  const tasksCol = await getCollection('tasks');
  const r = await tasksCol.insertOne({
    title: o.title,
    category: SPONSOR_TASK.CATEGORY,
    type: o.kind === 'bot' ? 'api' : 'nonapi',
    chatId: o.chatId || null,
    url: o.url,
    icon: o.kind === 'bot' ? '📢' : '⚡',
    reward: o.rewardFc, rewardFc: o.rewardFc,
    maxCompletions: o.users, completedCount: 0,
    expiresAt: null, minLevel: 0, active: true, createdAt: new Date(),
    sponsored: true, ownerTelegramId: String(o.telegramId), orderId: o.memo,
  });
  await col.updateOne({ memo }, { $set: { status: 'active', taskId: r.insertedId } });

  sendTelegramMessage(o.telegramId, `✅ <b>Payment received!</b>\n\nYour task <b>${o.title}</b> is now live for <b>${o.users}</b> users.`).catch(() => {});
  return true;
}

// ── Deposit scanner ─────────────────────────────────────────────────
function commentOf(msg) {
  if (!msg) return '';
  if (typeof msg.message === 'string' && msg.message) return msg.message;
  const d = msg.msg_data;
  if (d && d.text) { try { return Buffer.from(d.text, 'base64').toString('utf8'); } catch (e) {} }
  return '';
}

let lastScanAt = 0;
async function scanDeposits(opts) {
  const force = opts && opts.force;
  if (!isConfigured()) return { ok: false, error: 'payments_not_configured' };
  // Many users pressing "Check payment" must not hammer toncenter: share one scan per 4s per server.
  if (!force && Date.now() - lastScanAt < 4000) return { ok: true, skipped: true };
  lastScanAt = Date.now();

  const headers = process.env.TONCENTER_API_KEY ? { 'X-API-Key': process.env.TONCENTER_API_KEY } : {};
  let txs;
  try {
    const url = `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(depositAddress())}&limit=100`;
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (!j.ok || !Array.isArray(j.result)) return { ok: false, error: 'toncenter_error' };
    txs = j.result;
  } catch (e) {
    return { ok: false, error: 'toncenter_unreachable' };
  }

  const col = await ordersCol();
  const seen = await getCollection('tonTxProcessed');
  seen.createIndex({ at: 1 }, { expireAfterSeconds: 60 * 24 * 3600 }).catch(() => {});

  let matched = 0, activated = 0;
  for (const tx of txs) {
    const inMsg = tx.in_msg;
    if (!inMsg || !inMsg.source) continue;                 // only incoming transfers from a wallet
    const m = /FC[A-Z0-9]{8}/.exec(commentOf(inMsg).toUpperCase());
    if (!m) continue;
    const memo = m[0];
    let value; try { value = BigInt(inMsg.value || '0'); } catch (e) { continue; }
    if (value <= 0n) continue;
    const hash = tx.transaction_id && tx.transaction_id.hash;
    if (!hash) continue;

    const order = await col.findOne({ memo });
    if (!order) continue;

    try { await seen.insertOne({ _id: hash, memo, value: value.toString(), at: new Date() }); }
    catch (e) { continue; }                                // already counted

    matched++;
    try {
      const upd = await col.findOneAndUpdate({ memo }, [{ $set: { paidNano: { $toString: { $add: [{ $toLong: '$paidNano' }, { $toLong: value.toString() }] } } } }], { returnDocument: 'after' });
      if (upd && BigInt(upd.paidNano) >= BigInt(upd.priceNano)) {
        if (await activateOrder(memo)) activated++;
      }
    } catch (e) {
      // Money safety: if crediting failed (DB hiccup), forget this tx so the next scan counts it again.
      console.error('scanDeposits credit failed, will retry next scan:', memo, e);
      await seen.deleteOne({ _id: hash }).catch(() => {});
      matched--;
    }
  }

  // Tidy: unpaid orders older than 7 days are removed.
  col.deleteMany({ status: { $in: ['awaiting_payment', 'expired'] }, paidNano: '0', createdAt: { $lt: new Date(Date.now() - 7 * 86400000) } }).catch(() => {});

  return { ok: true, scanned: txs.length, matched, activated };
}

module.exports = { verifyBotAdmin, createOrder, listOrders, getOrder, scanDeposits, isConfigured, normalizeUsername };
