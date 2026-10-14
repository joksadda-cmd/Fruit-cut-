// lib/withdrawInfo.js
// Extra facts about the user, shown to the admin under every withdrawal request
// (admin bot: 💰 Withdrawals + the instant "New withdrawal request" message), so a cheater is easy to spot.

const { getCollection, idVariants } = require('./db');
const { getLevelForXp } = require('./levelSystem');

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n = (v) => Number(v || 0).toLocaleString('en-US');

function when(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '—';
  try {
    return dt.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) + ' (BD)';
  } catch (e) { return dt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
}

function ago(d) {
  if (!d) return '—';
  const ms = Date.now() - new Date(d).getTime();
  if (!(ms >= 0)) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

// Returns an HTML block (string). Never throws — on any problem it returns '' so the card still shows.
async function userReport(w) {
  try {
    const usersCol = await getCollection('users');
    const wdCol = await getCollection('withdrawals');
    const ids = idVariants(w.telegramId);
    const user = await usersCol.findOne({ telegramId: { $in: ids } });
    if (!user) return '\n\n⚠️ <i>User record not found.</i>';

    // ── withdrawal history of this user ──
    const all = await wdCol.find({ telegramId: { $in: ids } }, { projection: { status: 1, amount: 1, convertedAmount: 1, createdAt: 1, paidAt: 1, processedAt: 1, address: 1 } }).toArray();
    const others = all.filter((x) => String(x._id) !== String(w._id));
    const paid = others.filter((x) => x.status === 'approved');
    const rejected = others.filter((x) => /^rejected|wrong_address/.test(String(x.status))).length;
    const pendingOther = others.filter((x) => ['pending', 'paying', 'payout_check'].includes(x.status)).length;
    const paidUsd = paid.reduce((s, x) => s + (parseFloat(x.convertedAmount) || 0), 0);
    const paidFc = paid.reduce((s, x) => s + (x.amount || 0), 0);
    const lastPaid = paid.map((x) => x.paidAt || x.processedAt || x.createdAt).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0];

    // ── other accounts sharing the wallet / device / IP ──
    const myIdStr = String(user.telegramId);
    const sameWallet = w.address ? await usersCol.countDocuments({ withdrawWalletAddress: w.address, telegramId: { $nin: ids } }) : 0;
    const sameDevice = user.deviceId ? await usersCol.countDocuments({ deviceId: user.deviceId, telegramId: { $nin: ids } }) : 0;
    const sameIp = user.signupIp ? await usersCol.countDocuments({ signupIp: user.signupIp, telegramId: { $nin: ids } }) : 0;

    // ── earning speed ──
    const joined = user.joinedAt ? new Date(user.joinedAt) : null;
    const days = joined ? Math.max(1, (Date.now() - joined.getTime()) / 86400000) : null;
    const totalEarned = (user.fruitCoin || 0) + (w.amount || 0) + paidFc; // balance after request + this request + already paid out
    const perDay = days ? Math.round(totalEarned / days) : null;
    const lvl = getLevelForXp(user.xp || 0);

    // ── referrals ──
    const refCount = user.referralCount || 0;
    const refEarned = user.referralFruitCoinEarned || 0;
    let referrerLine = '';
    if (user.referredBy) referrerLine = `\n🔗 Joined via: <code>${esc(user.referredBy)}</code>`;

    // ── red flags ──
    const flags = [];
    if (user.accountLocked) flags.push('🔒 account is LOCKED');
    if (sameWallet > 0) flags.push(`👛 same wallet used by ${sameWallet} other account(s)`);
    if (sameDevice > 0) flags.push(`📱 same device as ${sameDevice} other account(s)`);
    if (sameIp > 2) flags.push(`🌐 same signup IP as ${sameIp} other account(s)`);
    if (days !== null && days < 1 && totalEarned >= 3000) flags.push('⏱ new account (<1 day) with big balance');
    if (perDay !== null && perDay > 4000) flags.push(`⚡ very fast earning (~${n(perDay)} FC/day)`);
    if (paid.length === 0 && (w.amount || 0) >= 50000) flags.push('💰 big FIRST withdrawal');

    return (
      `\n\n📊 <b>User report</b>\n` +
      `🕒 Requested: ${when(w.createdAt)} · ${ago(w.createdAt)}\n` +
      `📅 Joined: ${when(joined)} · ${ago(joined)}\n` +
      `⭐ Level ${lvl} · ${n(user.xp)} XP\n` +
      `🍎 Balance now: <b>${n(user.fruitCoin)} FC</b>\n` +
      `💸 Withdrawals: <b>${paid.length}</b> paid (${paidUsd.toFixed(2)} USDT) · ${rejected} rejected/refunded${pendingOther ? ` · ${pendingOther} other open` : ''}\n` +
      `⏮ Last paid: ${paid.length ? when(lastPaid) + ' · ' + ago(lastPaid) : '<b>none — first withdrawal 🆕</b>'}\n` +
      `👥 Referrals: <b>${n(refCount)}</b> invited · ${n(refEarned)} FC earned from them${referrerLine}\n` +
      `🎮 Activity: ${(user.completedTasks || []).length} tasks · ${n(user.totalAdsWatched)} ads · ${n(user.totalSlices)} slashes\n` +
      `📈 Total earned (est.): ${n(totalEarned)} FC${perDay !== null ? ` (~${n(perDay)} FC/day)` : ''}\n` +
      (flags.length ? `\n🚩 <b>Check carefully:</b>\n${flags.map((f) => '• ' + f).join('\n')}` : `\n✅ No red flags found`)
    );
  } catch (e) {
    console.error('withdrawInfo.userReport failed:', e);
    return '';
  }
}

module.exports = { userReport };
