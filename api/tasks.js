/**
 * api/tasks.js — Unified task API
 *
 * GET  /api/tasks            → returns verified channel tasks (tasks collection)
 * GET  /api/tasks?type=quick → returns quick tasks (quick_tasks collection)
 *
 * This replaces both tasks.js + quick_tasks.js to stay within Vercel's 12-function free limit.
 */

const { db } = require('./utils/firebase');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET')    return res.status(405).send('Method Not Allowed');

    const type = req.query?.type || 'channel'; // 'channel' or 'quick'
    const col  = type === 'quick' ? 'quick_tasks' : 'tasks';

    try {
        const snap  = await db.collection(col).orderBy('order', 'asc').get();
        const tasks = [];
        snap.forEach(d => tasks.push({ id: d.id, ...d.data() }));
        return res.status(200).json(tasks);
    } catch(e) {
        return res.status(500).json({ error: e.message });
    }
};
