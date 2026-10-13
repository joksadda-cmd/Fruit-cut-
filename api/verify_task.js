// api/verify_task.js
// GET  /api/verify_task              -> list active tasks (no auth; public list)
// POST /api/verify_task { taskId }   -> verify + claim a task's reward
//
// IMPORTANT HISTORY: this file previously contained a stray copy of
// api/slash.js's code (same slash-game logic, wrong file). That meant:
//   - GET requests 405'd, so the mini app's task list always failed to
//     load and admin-added tasks never appeared.
//   - POST requests silently fell through to the slash game's 'status'
//     branch (no 'action' in the task-claim body), which never touched
//     completedTasks/fruitCoin/xp at all, so "claiming" a task did nothing.
// This is a full rewrite of the actual task feature.

const { ObjectId } = require('mongodb');
const { verifyTelegramInitData } = require('../lib/telegramAuth');
const { rateGuard } = require('../lib/rateLimit');
const { getCollection, findUserByTelegramId } = require('../lib/db');
const { TRANSACTION_TYPES } = require('../lib/constants');
const { getLevelForXp, getLevelProgress, LEVELS } = require('../lib/levelSystem');
const { checkReferralStep2 } = require('../lib/referral');
const { getSettings } = require('../lib/settings');
const sponsorApi = require('../lib/sponsorApi');

// "Sponsor & Post Task" calls share this endpoint (Vercel Hobby = max 12 functions). They carry an `action`.
const SPONSOR_ACTIONS = ['config', 'verify_bot', 'create', 'list', 'check'];

// XP granted per completed task (see lib/levelSystem.js header comment).
const TASK_XP_REWARD = 2;

// Statuses that count as "joined" for a Telegram channel/group task —
// same set lib/joinGate.js uses for the official-channels gate.
const JOINED_STATUSES = ['creator', 'administrator', 'member', 'restricted'];

async function checkTaskChannelMembership(chatId, telegramId) {
  const token = process.env.BOT_TOKEN;
  try {
    const url = `https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${telegramId}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const status = data && data.ok && data.result ? data.result.status : null;
    return JOINED_STATUSES.includes(status);
  } catch (err) {
    console.error(`checkTaskChannelMembership failed for ${chatId}:`, err);
    return false;
  }
}

// Public task list is the same for everybody, so keep it in memory for a few seconds on each
// warm server AND let Vercel's edge cache serve it (see Cache-Control below). Opening the Tasks
// window no longer waits for a cold start + MongoDB query every single time.
const TASKS_CACHE_MS = 20 * 1000;
let tasksCache = { at: 0, tasks: null, adsgram: null };

async function loadActiveTasks() {
  if (tasksCache.tasks && Date.now() - tasksCache.at < TASKS_CACHE_MS) return tasksCache;

  const tasksCol = await getCollection('tasks');
  const now = new Date();
  const all = await tasksCol
    .find({ active: true, $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }] })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
  // Hide tasks whose quantity limit is already used up.
  const visible = all.filter((t) => !(t.maxCompletions > 0 && (t.completedCount || 0) >= t.maxCompletions));

  const tasks = visible.map((t) => ({
    id: String(t._id),
    title: t.title,
    category: t.category || 'daily',
    type: t.type,
    icon: t.icon || '📋',
    url: t.url || '',
    chatId: t.chatId || null,
    reward: t.reward || t.rewardFc || 0,
    rewardFc: t.rewardFc || t.reward || 0,
    maxCompletions: t.maxCompletions || 0,
    completedCount: t.completedCount || 0,
    expiresAt: t.expiresAt || null,
    minLevel: t.minLevel || 0,
  }));
  // Adsgram Task block card (Tasks > Daily): reward + daily cap come from the economy settings.
  const settings = await getSettings();
  const adsgram = {
    rewardFc: (settings.adRewardFc && settings.adRewardFc.adsgramTask) || 50,
    dailyLimit: (settings.adDailyLimits && settings.adDailyLimits.adsgramTask) || 5,
  };
  tasksCache = { at: Date.now(), tasks, adsgram };
  return tasksCache;
}

async function handleList(req, res) {
  const { tasks, adsgram } = await loadActiveTasks();
  // Edge-cache 20s, and serve a slightly stale list instantly while it refreshes in the background.
  res.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=120');
  return res.status(200).json({ success: true, tasks, adsgram });
}

async function handleClaim(req, res) {
  const initData = req.headers['x-telegram-init-data'] || '';
  const verify = verifyTelegramInitData(initData, process.env.BOT_TOKEN);
  if (await rateGuard(req, res, verify, 'verify_task')) return; // flood protection (lib/rateLimit.js)
  if (!verify.valid) {
    return res.status(401).json({ success: false, error: 'invalid_auth' });
  }

  const telegramId = verify.user.id;
  const { taskId } = req.body || {};
  if (!taskId || !ObjectId.isValid(taskId)) {
    return res.status(400).json({ success: false, error: 'invalid_task' });
  }

  const usersCol = await getCollection('users');
  const user = await findUserByTelegramId(usersCol, telegramId);
  if (!user) {
    return res.status(404).json({ success: false, error: 'user_not_found' });
  }
  if (user.banned) {
    return res.status(403).json({ success: false, error: 'Account suspended' });
  }

  const taskIdStr = String(taskId);
  if ((user.completedTasks || []).includes(taskIdStr)) {
    return res.status(200).json({ success: false, error: 'already_completed' });
  }

  const tasksCol = await getCollection('tasks');
  const task = await tasksCol.findOne({ _id: new ObjectId(taskId), active: true });
  if (!task) {
    return res.status(404).json({ success: false, error: 'task_not_found' });
  }

  // ── Task options: expiry / quantity / minimum level ─────────────
  if (task.expiresAt && new Date(task.expiresAt) <= new Date()) {
    return res.status(200).json({ success: false, error: 'task_expired', message: 'This task has expired.' });
  }
  if (task.maxCompletions > 0 && (task.completedCount || 0) >= task.maxCompletions) {
    return res.status(200).json({ success: false, error: 'task_full', message: 'This task is full — all slots were taken.' });
  }
  if (task.minLevel > 0 && getLevelForXp(user.xp || 0) < task.minLevel) {
    return res.status(200).json({ success: false, error: 'level_too_low', message: `You need Level ${task.minLevel} for this task.` });
  }

  // ── Verification ────────────────────────────────────────────────
  // 'api' tasks (Telegram channel/group) are checked live against
  // Telegram's getChatMember. 'nonapi' tasks (website/other bot/social)
  // are trust-based by design (see api/bot.js's add-task flow) — there's
  // no API to verify those, so completion is accepted on click.
  if (task.type === 'api') {
    const joined = await checkTaskChannelMembership(task.chatId, telegramId);
    if (!joined) {
      return res.status(200).json({
        success: false,
        error: 'not_joined',
        message: 'Please join the channel/group first, then tap Claim again.',
      });
    }
  }

  const baseReward = task.reward || task.rewardFc || 0;
  const oldXp = user.xp || 0;
  const newXp = oldXp + TASK_XP_REWARD;
  const oldLevel = getLevelForXp(oldXp);
  const newLevel = getLevelForXp(newXp);

  let levelReward = 0;
  let isLevelUp = false;
  if (newLevel > oldLevel) {
    isLevelUp = true;
    const targetLevelConfig = LEVELS.find((l) => l.level === newLevel);
    if (targetLevelConfig) levelReward = targetLevelConfig.rewardFc || 0;
  }

  const totalReward = baseReward + levelReward;
  const now = new Date();

  // Reserve one slot atomically BEFORE paying, so two users can never both take
  // the last slot. Rolled back below if the user-credit step doesn't happen.
  let reservedLast = false;
  if (task.maxCompletions > 0) {
    const reserved = await tasksCol.findOneAndUpdate(
      { _id: task._id, active: true, $expr: { $lt: [{ $ifNull: ['$completedCount', 0] }, '$maxCompletions'] } },
      { $inc: { completedCount: 1 } },
      { returnDocument: 'after' }
    );
    if (!reserved) {
      return res.status(200).json({ success: false, error: 'task_full', message: 'This task is full — all slots were taken.' });
    }
    if (reserved.completedCount >= reserved.maxCompletions) {
      reservedLast = true;
      await tasksCol.updateOne({ _id: task._id }, { $set: { active: false, filledAt: new Date() } });
    }
  } else {
    await tasksCol.updateOne({ _id: task._id }, { $inc: { completedCount: 1 } });
  }

  // Atomic: only credits if this task isn't already in completedTasks —
  // closes the double-claim race (two rapid taps / two requests in-flight).
  const updatedUser = await usersCol.findOneAndUpdate(
    { _id: user._id, completedTasks: { $ne: taskIdStr } },
    {
      $addToSet: { completedTasks: taskIdStr },
      $inc: { fruitCoin: totalReward, xp: TASK_XP_REWARD },
      $set: { level: newLevel, lastActive: now },
    },
    { returnDocument: 'after' }
  );

  if (!updatedUser) {
    // Give the reserved slot back (user had already completed it in a parallel request).
    await tasksCol.updateOne(
      { _id: task._id },
      { $inc: { completedCount: -1 }, ...(reservedLast ? { $set: { active: true }, $unset: { filledAt: '' } } : {}) }
    );
    return res.status(200).json({ success: false, error: 'already_completed' });
  }

  const txCol = await getCollection('transactions');
  await txCol.insertOne({
    telegramId: user.telegramId,
    type: TRANSACTION_TYPES.TASK_REWARD,
    amount: totalReward,
    balanceAfter: updatedUser.fruitCoin,
    meta: {
      taskId: taskIdStr,
      title: task.title,
      category: task.category,
      baseReward,
      levelReward,
      isLevelUp,
      level: newLevel,
    },
    createdAt: now,
  });

  // Referral Step 2 (10 completed tasks -> referrer gets 80 FC + 5 XP).
  checkReferralStep2(updatedUser).catch(() => {});

  tasksCache = { at: 0, tasks: null, adsgram: null }; // completedCount changed -> next list is rebuilt fresh

  const updatedProgress = getLevelProgress(updatedUser.xp || newXp);

  return res.status(200).json({
    success: true,
    rewardFc: totalReward,
    levelReward,
    isLevelUp,
    newLevel,
    user: {
      fruitCoin: updatedUser.fruitCoin,
      xp: updatedUser.xp,
      level: updatedProgress.level,
      levelProgress: updatedProgress,
      completedTasks: updatedUser.completedTasks || [],
    },
  });
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      return await handleList(req, res);
    }
    if (req.method === 'POST') {
      if (req.body && SPONSOR_ACTIONS.includes(req.body.action)) return await sponsorApi(req, res);
      return await handleClaim(req, res);
    }
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('api/verify_task error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};
