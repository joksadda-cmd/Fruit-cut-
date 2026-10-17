// lib/withdrawInfo.js
// Facts about the user, shown to the admin under every withdrawal request
// (the instant "New withdrawal request" message + admin bot: 💰 Withdrawals), so a cheater is easy to spot
// and a real user is easy to recognise.
//
// Numbers for the CURRENT PERIOD (since signup, or since the last APPROVED withdrawal) come from lib/wdProfile.js.

const { getCollection, idVariants } = require('./db');
const { getLevelForXp } = require('./levelSystem');
const { getProfile, hoursActive } = require('./wdProfile');
const { getReferrals } = require('./referralReport');

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n = (v) => Number(v || 0).toLocaleString('en-US');
const DAY = 86400000;

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

const SUB_LABEL = { adsgramDaily: 'Adsgram', adsgramTask: 'Adsgram task', monetag: 'Monetag', gigapub: 'GigaPub' };

// Returns { text, refCount }. `text` is an HTML block. Never throws — on any problem it returns an empty text so the card still shows.
async function userReportFull(w) {
  try {
    const usersCol = await getCollection('users');
    const wdCol = await getCollection('withdrawals');
    const ids = idVariants(w.telegramId);
    const user = await usersCol.findOne({ telegramId: { $in: ids } });
    if (!user) return { text: '\n\n⚠️ <i>User record not found.</i>', refCount: 0 };

    // ── withdrawal history of this user ──
    const all = await wdCol.find({ telegramId: { $in: ids } }, { projection: { status: 1, amount: 1, convertedAmount: 1, unit: 1, createdAt: 1, paidAt: 1, processedAt: 1, address: 1 } }).toArray();
    const others = all.filter((x) => String(x._id) !== String(w._id));
    const paid = others.filter((x) => x.status === 'approved');
    const rejected = others.filter((x) => /^rejected|wrong_address/.test(String(x.status))).length;
    const pendingOther = others.filter((x) => ['pending', 'paying', 'payout_check'].includes(x.status)).length;
    const paidUsd = paid.reduce((s, x) => s + (parseFloat(x.convertedAmount) || 0), 0);
    const paidFc = paid.reduce((s, x) => s + (x.amount || 0), 0);
    const stamp = (x) => x.paidAt || x.processedAt || x.createdAt;
    const lastPaidDoc = paid.slice().sort((a, b) => new Date(stamp(b)) - new Date(stamp(a)))[0] || null;
    const lastPaid = lastPaidDoc ? stamp(lastPaidDoc) : null;

    // ── other accounts sharing the wallet / device / IP ──
    const sameWallet = w.address ? await usersCol.countDocuments({ withdrawWalletAddress: w.address, telegramId: { $nin: ids } }) : 0;
    const sameDevice = user.deviceId ? await usersCol.countDocuments({ deviceId: user.deviceId, telegramId: { $nin: ids } }) : 0;
    const sameIp = user.signupIp ? await usersCol.countDocuments({ signupIp: user.signupIp, telegramId: { $nin: ids } }) : 0;

    // ── earning speed ──
    const joined = user.joinedAt ? new Date(user.joinedAt) : null;
    const days = joined ? Math.max(1, (Date.now() - joined.getTime()) / DAY) : null;
    const totalEarned = (user.fruitCoin || 0) + (w.amount || 0) + paidFc; // balance after request + this request + already paid out
    const perDay = days ? Math.round(totalEarned / days) : null;
    const lvl = getLevelForXp(user.xp || 0);

    // ── referrals (count + how good they are) ──
    const refCount = user.referralCount || 0;
    const refEarned = user.referralFruitCoinEarned || 0;
    let refQuality = null;
    if (refCount > 0) {
      try {
        const refs = await getReferrals(w.telegramId);
        if (refs.length) {
          const ipCount = new Map();
          for (const r of refs) if (r.signupIp) ipCount.set(r.signupIp, (ipCount.get(r.signupIp) || 0) + 1);
          refQuality = {
            total: refs.length,
            lv2: refs.filter((r) => getLevelForXp(r.xp || 0) >= 2).length,
            banned: refs.filter((r) => r.banned).length,
            sharedIp: [...ipCount.values()].filter((c) => c >= 3).reduce((s, c) => s + c, 0),
          };
        }
      } catch (e) { refQuality = null; }
    }

    // ── this period's numbers (lib/wdProfile.js) ──
    const prof = await getProfile(w.telegramId);
    const periodStart = lastPaid ? new Date(lastPaid) : joined;

    // ── red flags ──
    const flags = [];
    if (user.accountLocked) flags.push('🔒 account is LOCKED');
    if (sameWallet > 0) flags.push(`👛 same wallet used by ${sameWallet} other account(s)`);
    if (sameDevice > 0) flags.push(`📱 same device as ${sameDevice} other account(s)`);
    if (sameIp > 2) flags.push(`🌐 same signup IP as ${sameIp} other account(s)`);
    if (days !== null && days < 1 && totalEarned >= 3000) flags.push('⏱ new account (<1 day) with big balance');
    if (perDay !== null && perDay > 4000) flags.push(`⚡ very fast earning (~${n(perDay)} FC/day)`);
    if (paid.length === 0 && (w.amount || 0) >= 50000) flags.push('💰 big FIRST withdrawal');
    if (refQuality) {
      if (refQuality.total >= 5 && refQuality.lv2 / refQuality.total < 0.2) flags.push(`👥 only ${refQuality.lv2} of ${refQuality.total} referrals ever reached Level 2`);
      if (refQuality.banned > 0) flags.push(`🚫 ${refQuality.banned} of their referrals already banned`);
      if (refQuality.sharedIp >= 3) flags.push(`🌐 ${refQuality.sharedIp} referrals share a signup IP`);
    }
    if (totalEarned >= 1000 && refEarned / totalEarned >= 0.6) flags.push(`🔗 ${Math.round((refEarned / totalEarned) * 100)}% of all earnings came from referrals`);
    if (prof) {
      const spanDays = Math.max(1, (Date.now() - new Date(prof.since || prof.firstAt || Date.now()).getTime()) / DAY);
      const hrs = hoursActive(prof.hoursMask);
      const actDays = (prof.activeDays || []).length;
      if (hrs >= 22 && actDays >= 2) flags.push(`🕐 active in ${hrs} of 24 hours of the day (no sleep gap — bot-like)`);
      if ((prof.ads || 0) >= 80 && !prof.slashes && !prof.tasks && !prof.gameClaims) flags.push(`📺 ${n(prof.ads)} ads but no slash / task / game at all`);
      if (spanDays >= 4 && actDays <= 1 && (prof.ads || 0) + (prof.slashes || 0) >= 100) flags.push('📆 lots of actions but only 1 active day');
    }

    // ── the report ──
    const lines = [];
    lines.push(`📊 <b>User report</b>`);
    lines.push(`🕒 Requested: ${when(w.createdAt)} · ${ago(w.createdAt)}`);
    lines.push(`📅 Joined: ${when(joined)} · ${ago(joined)}`);
    lines.push(`⭐ Level ${lvl} · ${n(user.xp)} XP`);
    lines.push(`🍎 Balance now: <b>${n(user.fruitCoin)} FC</b>`);
    // Shown ONLY when there is a past withdrawal — a user who never withdrew gets no "last withdraw" / "first" line at all.
    if (paid.length || rejected || pendingOther) {
      lines.push(`💸 Withdrawals: <b>${paid.length}</b> paid (${paidUsd.toFixed(2)} USDT) · ${rejected} rejected/refunded${pendingOther ? ` · ${pendingOther} other open` : ''}`);
    }
    if (lastPaid) {
      lines.push(`⏮ Last withdraw: ${when(lastPaid)} · ${ago(lastPaid)}${lastPaidDoc && lastPaidDoc.convertedAmount ? ` · ${esc(lastPaidDoc.convertedAmount)} ${esc(lastPaidDoc.unit || 'USDT')}` : ''}`);
    }
    lines.push(`👥 Referrals: <b>${n(refCount)}</b> invited · ${n(refEarned)} FC earned from them`);
    if (refQuality) lines.push(`   ↳ ${refQuality.lv2} reached Lv2+ · ${refQuality.banned} banned${refQuality.sharedIp ? ` · ${refQuality.sharedIp} share an IP` : ''}`);
    if (user.referredBy) lines.push(`🔗 Joined via: <code>${esc(user.referredBy)}</code>`);

    lines.push('');
    if (prof) {
      const startMs = periodStart ? periodStart.getTime() : null;
      const lateStart = startMs && prof.since && new Date(prof.since).getTime() - startMs > 36 * 3600 * 1000;
      const spanDays = Math.max(1, Math.round((Date.now() - new Date(prof.since || prof.firstAt).getTime()) / DAY));
      lines.push(`🧾 <b>Since ${lastPaid ? 'last withdraw' : 'signup'}</b> · ${spanDays}d${lateStart ? ` <i>(counting started ${when(prof.since)})</i>` : ''}`);
      const by = Object.entries(prof.adsBy || {}).filter(([, c]) => c > 0).map(([k, c]) => `${SUB_LABEL[k] || k} ${n(c)}`);
      lines.push(`📺 Ads: <b>${n(prof.ads)}</b>${by.length ? ` (${by.join(' · ')})` : ''}`);
      lines.push(`⚔️ Slashes: <b>${n(prof.slashes)}</b> · 🎮 Game loot claims: <b>${n(prof.gameClaims)}</b>`);
      lines.push(`📋 Tasks: <b>${n(prof.tasks)}</b> · 🎁 Treasure boxes: <b>${n(prof.gifts)}</b>`);
      lines.push(`📆 Active days: <b>${(prof.activeDays || []).length}</b> of ${spanDays} · 🕐 hours of day used: <b>${hoursActive(prof.hoursMask)}</b>/24`);
      const f = prof.fc || {};
      const earn = [['ads', 'ads'], ['slash', 'slash'], ['game', 'games'], ['task', 'tasks'], ['gift', 'gifts']].filter(([k]) => f[k] > 0).map(([k, label]) => `${label} ${n(f[k])}`);
      if (earn.length) lines.push(`💰 Earned here: ${earn.join(' · ')} FC`);
    } else {
      lines.push(`🧾 <i>No activity counted yet for this period.</i>`);
    }
    lines.push(`📈 Lifetime: ${(user.completedTasks || []).length} tasks · ${n(user.totalAdsWatched)} ads · ${n(user.totalSlices)} slashes · ${n(totalEarned)} FC earned${perDay !== null ? ` (~${n(perDay)}/day)` : ''}`);
    lines.push(flags.length ? `\n🚩 <b>Check carefully:</b>\n${flags.map((f) => '• ' + f).join('\n')}` : `\n✅ No red flags found`);

    return { text: '\n\n' + lines.join('\n'), refCount };
  } catch (e) {
    console.error('withdrawInfo.userReport failed:', e);
    return { text: '', refCount: 0 };
  }
}

// Same as before: just the text.
async function userReport(w) {
  return (await userReportFull(w)).text;
}

module.exports = { userReport, userReportFull };
