// api/verify_task.js
// GET  /api/verify_task           -> list active tasks (for the Task section)
// POST /api/verify_task  { taskId } -> claim/verify a task
//
// NOTE: task LISTING lives in this same file (not a separate api/tasks.js)
// on purpose — Vercel's Hobby plan caps a project at 12 Serverless
// Functions, and this project is already at exactly 12. Same domain
// (tasks), one file, routed by HTTP method.
//
// This also fixes a real bug: the frontend was calling
// `https://fruit-cut-eight.vercel.app/api/tasks` (GET) for the task list,
// but no api/tasks.js ever existed in this repo — so the Task section was
// always empty/broken. It now calls /api/verify_task (GET) instead.
//
// - type 'api'    -> must actually be a member of task.chatId (checked via
//                    Telegram's getChatMember, same mechanism as the
//                    join-gate) before the reward is credited.
// - type 'nonapi' -> trust-based (website visits, other bots, socials that
//                    can't be verified via API) — credited on claim.

const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { ObjectId } = require('mongodb');
const { maybeTriggerValidReferral } = require('../lib/referral');

const JOINED_STATUSES = ['creator', 'administrator', 'member', 'restricted'];

async function isMemberOf(chatId, telegramId) {
  const token = process.env.BOT_TOKEN;
  try {
    const url = `https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${telegramId}`;
    const r = await fetch(url);
    const data = await r.json();
    const status = data && data.ok && data.result ? data.result.status : null;
    return JOINED_STATUSES.includes(status);
  } catch (err) {
    console.error('verify_task membership check failed:', err);
    return false;
  }
}

// ── GET: list active tasks, grouped by category ──────────────────────
async function handleList(req, res) {
  const tasksCol = await getCollection('tasks');
  const tasks = await tasksCol
    .find({ active: true })
    .sort({ createdAt: -1 })
    .toArray();

  // Only public-safe fields — chatId is used server-side for verification
  // only and isn't needed by the client.
  const out = tasks.map((t) => ({
    id: String(t._id),
    title: t.title,
    description: t.description || '',
    category: t.category || 'social', // daily | social | exclusive | partner
    type: t.type,                     // 'api' | 'nonapi'
    icon: t.icon || (t.type === 'api' ? '📢' : '⚡'),
    url: t.url || '',
    reward: t.reward || 0,
    rewardFc: t.rewardFc || 0,
  }));

  return res.status(200).json({ success: true, tasks: out });
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    try {
      return await handleList(req, res);
    } catch (err) {
      console.error('verify_task list error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const initData = req.headers['x-telegram-init-data'] || '';
    const verify = verifyTelegramInitData(initData, process.env.BOT_TOKEN);
    if (!verify.valid) {
      return res.status(401).json({ success: false, message: 'invalid_auth' });
    }
    const telegramId = verify.user.id;

    const { taskId } = req.body || {};
    if (!taskId || !ObjectId.isValid(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid task' });
    }

    const tasksCol = await getCollection('tasks');
    const task = await tasksCol.findOne({ _id: new ObjectId(taskId), active: true });
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    const usersCol = await getCollection('users');
    const user = await findUserByTelegramId(usersCol, telegramId);
    if (!user) return res.status(404).json({ success: false, message: 'user_not_found' });
    if (user.banned) return res.status(403).json({ success: false, message: 'Account suspended' });

    // Already claimed? (idempotent — no double rewards)
    if ((user.completedTasks || []).includes(taskId)) {
      return res.status(200).json({ success: false, message: 'Task already completed' });
    }

    // Real verification for API (channel/group) tasks — non-API tasks are
    // trust-based since there's no API to check an Instagram/YouTube follow.
    if (task.type === 'api') {
      const joined = await isMemberOf(task.chatId, telegramId);
      if (!joined) {
        return res.status(200).json({ success: false, message: 'Please join first, then try again' });
      }
    }

    const coinsReward = task.reward || 0;
    const gemsReward = task.rewardFc || 0;

    // Driver v6+: findOneAndUpdate returns the document directly, not { value }.
    const updatedUser = await usersCol.findOneAndUpdate(
      { _id: user._id, completedTasks: { $ne: taskId } }, // re-check atomically (race guard)
      {
        $inc: { gold: coinsReward, fruitCoin: gemsReward },
        $addToSet: { completedTasks: taskId },
        $set: { lastActive: new Date() },
      },
      { returnDocument: 'after' }
    );

    if (!updatedUser) {
      return res.status(200).json({ success: false, message: 'Task already completed' });
    }

    maybeTriggerValidReferral(updatedUser); // fire-and-forget

    const txCol = await getCollection('transactions');
    await txCol.insertOne({
      telegramId,
      type: 'task_reward',
      amount: coinsReward,
      balanceAfter: updatedUser.gold,
      meta: { taskId, taskType: task.type, title: task.title },
      createdAt: new Date(),
    });

    return res.status(200).json({
      success: true,
      coinsReward,
      gemsReward,
      user: {
        coins: updatedUser.gold,
        gems: updatedUser.fruitCoin,
        completedTasks: updatedUser.completedTasks,
      },
    });
  } catch (err) {
    console.error('verify_task error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
