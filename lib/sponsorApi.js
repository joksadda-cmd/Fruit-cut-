// lib/sponsorApi.js (called from api/verify_task.js — merged there to stay under Vercel Hobby's 12-function limit)
// POST /api/verify_task   (Telegram initData required)
//   { action: 'config' }                       -> { packages, rewardFc, configured }
//   { action: 'verify_bot', username }         -> checks our bot (and the poster) is admin of that channel/group
//   { action: 'create', kind, title, users, username|url }  -> creates an order, returns payment details
//   { action: 'list' }                         -> the user's orders (My History)
//   { action: 'check', memo }                  -> scans the TON wallet right now, returns the order's fresh status
//
// All the logic lives in lib/sponsor.js. Deposits are ALSO picked up automatically by
// GET /api/cron_notify?job=ton_deposits (external scheduler), so the user doesn't have to press anything.

const { verifyTelegramInitData } = require('./telegramAuth');
const { rateGuard } = require('./rateLimit');
const { getCollection, findUserByTelegramId } = require('./db');
const { SPONSOR_TASK } = require('./constants');
const sponsor = require('./sponsor');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const verify = verifyTelegramInitData(req.headers['x-telegram-init-data'] || '', process.env.BOT_TOKEN);
  if (await rateGuard(req, res, verify, 'sponsor')) return;
  if (!verify.valid) return res.status(401).json({ success: false, error: 'invalid_auth' });
  const telegramId = verify.user.id;

  const body = req.body || {};
  const action = body.action;

  try {
    const usersCol = await getCollection('users');
    const user = await findUserByTelegramId(usersCol, telegramId);
    if (!user) return res.status(404).json({ success: false, error: 'user_not_found' });
    if (user.banned) return res.status(403).json({ success: false, error: 'account_suspended' });

    if (action === 'config') {
      return res.status(200).json({
        success: true,
        configured: sponsor.isConfigured(),
        rewardFc: SPONSOR_TASK.REWARD_FC,
        packages: SPONSOR_TASK.PACKAGES,
      });
    }

    if (action === 'verify_bot') {
      const v = await sponsor.verifyBotAdmin(body.username, telegramId);
      if (!v.ok) return res.status(200).json({ success: false, error: v.error });
      return res.status(200).json({ success: true, username: v.username, title: v.title });
    }

    if (action === 'create') {
      const r = await sponsor.createOrder(user, body);
      if (!r.ok) return res.status(200).json({ success: false, error: r.error });
      return res.status(200).json({ success: true, order: r.order });
    }

    if (action === 'list') {
      // Fresh payment status without waiting for the cron (shared 4s throttle inside scanDeposits).
      if (sponsor.isConfigured()) await sponsor.scanDeposits().catch(() => {});
      return res.status(200).json({ success: true, orders: await sponsor.listOrders(telegramId) });
    }

    if (action === 'check') {
      if (!body.memo) return res.status(400).json({ success: false, error: 'missing_memo' });
      const scan = await sponsor.scanDeposits();
      const order = await sponsor.getOrder(telegramId, body.memo);
      if (!order) return res.status(404).json({ success: false, error: 'order_not_found' });
      return res.status(200).json({ success: true, order, scanError: scan && scan.ok === false ? scan.error : null });
    }

    return res.status(400).json({ success: false, error: 'unknown_action' });
  } catch (err) {
    console.error('api/sponsor error:', err);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
};
