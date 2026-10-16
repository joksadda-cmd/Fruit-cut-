#!/usr/bin/env node
// scripts/find_cheaters.js — find accounts that earned Fruit Coin with hack tools.
//
// Run it on YOUR computer (not on Vercel):
//   MONGODB_URI="mongodb+srv://..." node scripts/find_cheaters.js            -> report only (changes nothing)
//   MONGODB_URI="..." node scripts/find_cheaters.js --days 14                 -> look back 14 days (default 7)
//   MONGODB_URI="..." node scripts/find_cheaters.js --lock                    -> also LOCK every flagged account
//   MONGODB_URI="..." node scripts/find_cheaters.js --ban                     -> also BAN them and reject their PENDING withdrawals (no refund)
//
// An account is flagged when, in any single UTC day of the period, it
//   - earned more than CEILING FC from ads / slash / treasure box (more than the daily caps allow), or
//   - got more than AD_CEILING ad rewards, or
//   - shares its payout wallet with another account, or
//   - made 8+ withdrawal requests (the old rules had no limit).
// Review the list before using --ban. Shared carrier IPs and family wallets can look similar to cheating.

const { MongoClient } = require('mongodb');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d; };
const DAYS = val('--days', 7);
const CEILING = val('--ceiling', 7000);
const AD_CEILING = val('--ad-ceiling', 220);
const MANY_WITHDRAWALS = val('--many-withdrawals', 8);

(async () => {
  if (!process.env.MONGODB_URI) { console.error('Set MONGODB_URI first.'); process.exit(1); }
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('fruitcut');
  const since = new Date(Date.now() - DAYS * 86400000);
  const flagged = new Map(); // telegramId -> [reasons]
  const add = (id, why) => { const k = String(id); if (!flagged.has(k)) flagged.set(k, []); flagged.get(k).push(why); };

  // 1) earning per user per UTC day
  const perDay = await db.collection('transactions').aggregate([
    { $match: { type: { $in: ['ad_reward', 'slash_reward', 'daily_gift_reward'] }, createdAt: { $gte: since } } },
    { $group: {
        _id: { u: '$telegramId', d: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } } },
        fc: { $sum: '$amount' },
        ads: { $sum: { $cond: [{ $eq: ['$type', 'ad_reward'] }, 1, 0] } },
    } },
    { $match: { $or: [{ fc: { $gt: CEILING } }, { ads: { $gt: AD_CEILING } }] } },
  ]).toArray();
  for (const r of perDay) add(r._id.u, `${r._id.d}: ${r.fc.toLocaleString()} FC and ${r.ads} ad rewards in one day`);

  // 2) many withdrawals
  const manyWd = await db.collection('withdrawals').aggregate([
    { $group: { _id: '$telegramId', n: { $sum: 1 }, fc: { $sum: '$amount' } } },
    { $match: { n: { $gte: MANY_WITHDRAWALS } } },
  ]).toArray();
  for (const r of manyWd) add(r._id, `${r.n} withdrawal requests (${r.fc.toLocaleString()} FC)`);

  // 3) one wallet, several accounts
  const wallets = await db.collection('withdrawals').aggregate([
    { $group: { _id: '$address', users: { $addToSet: '$telegramId' } } },
    { $match: { $expr: { $gt: [{ $size: '$users' }, 1] } } },
  ]).toArray();
  for (const w of wallets) for (const u of w.users) add(u, `wallet ${String(w._id).slice(0, 10)}… shared by ${w.users.length} accounts`);

  console.log(`\nPeriod: last ${DAYS} days · flagged accounts: ${flagged.size}\n`);
  const usersCol = db.collection('users');
  for (const [id, reasons] of flagged) {
    const u = await usersCol.findOne({ telegramId: { $in: [id, Number(id)] } });
    console.log(`${id}  @${(u && u.username) || '?'}  level ${u ? Math.max(1, u.level || 1) : '?'}  balance ${u ? (u.fruitCoin || 0).toLocaleString() : '?'} FC  ${u && u.banned ? '[BANNED]' : u && u.accountLocked ? '[LOCKED]' : ''}`);
    reasons.slice(0, 6).forEach((r) => console.log('    - ' + r));
  }

  if (flag('--lock') || flag('--ban')) {
    const ids = [...flagged.keys()];
    const both = ids.flatMap((i) => [i, Number(i)]);
    if (flag('--ban')) {
      const r = await usersCol.updateMany({ telegramId: { $in: both } }, { $set: { banned: true, bannedAt: new Date(), bannedReason: 'cheat_audit' } });
      const wd = await db.collection('withdrawals').updateMany({ telegramId: { $in: both }, status: 'pending' }, { $set: { status: 'rejected_banned', processedAt: new Date() } });
      for (const id of ids) await db.collection('bannedRegistry').updateOne({ _id: id }, { $set: { bannedAt: new Date(), reason: 'cheat_audit' }, $setOnInsert: { firstBannedAt: new Date() } }, { upsert: true });
      console.log(`\nBANNED ${r.modifiedCount} accounts, rejected ${wd.modifiedCount} pending withdrawals (no refund).`);
    } else {
      const r = await usersCol.updateMany({ telegramId: { $in: both }, accountLocked: { $ne: true } }, { $set: { accountLocked: true, accountLockedAt: new Date(), accountLockedReason: 'earn_anomaly' } });
      console.log(`\nLOCKED ${r.modifiedCount} accounts (they keep their balance but cannot withdraw).`);
    }
  } else {
    console.log('\n(report only — nothing changed. Add --lock or --ban to act.)');
  }
  await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
