// lib/payoutFlow.js
// The decision logic around an automatic payout, kept separate from the Telegram bot so it can be tested.
//
// A withdrawal moves through these statuses (collection `withdrawals`):
//   pending        -> waiting for the admin
//   paying         -> admin tapped Approve, the server is sending the USDT right now
//   approved       -> USDT sent (or, when auto-payout is not set up, admin paid by hand)
//   payout_check   -> UNCERTAIN: the transfer may or may not have gone out. A human must look at the
//                     wallet history and press "Sent" or "Not sent". Never retried automatically.
//
// Safety rules
//   * Only the first tap wins (status flips pending -> paying atomically in bot.js) so the same
//     withdrawal can never be paid twice, even if Telegram re-delivers the button press.
//   * A DEFINITE failure (nothing was sent: not enough USDT, bad address, network down while still
//     checking ...) puts it back to `pending` so the admin can fix the cause and tap Approve again.
//   * An UNCERTAIN result is never retried by the machine.

// tonPayout.js (and the @ton packages) are loaded only when a payout really happens, so a problem with
// them can never break the rest of the admin bot.
const loadPayoutLib = () => require('./tonPayout');
const { getCollection } = require('./db');
const isConfigured = () => !!String(process.env.TON_PAYOUT_MNEMONIC || '').trim();

const REASONS = {
  not_configured: 'Auto-payout is not set up (TON_PAYOUT_MNEMONIC missing).',
  not_enough_usdt: 'The payout wallet does not have enough USDT.',
  not_enough_ton_for_fees: 'The payout wallet needs about 0.5 TON for network fees.',
  bad_address: "The user's wallet address is not a valid TON address. Use ⚠️ Wrong Address (refund) instead.",
  bad_amount: 'The payout amount is invalid.',
  above_safety_cap: 'This payout is above the safety limit (PAYOUT_MAX_USDT).',
  wallet_address_mismatch: 'The 24 words do not give the address in TON_PAYOUT_ADDRESS (wrong word or wrong TON_WALLET_VERSION).',
  payout_busy: 'Another payout is being sent right now. Wait about 30 seconds, then tap Approve again.',
  unsupported_unit: 'Only USDT withdrawals can be paid automatically.',
  check_failed: 'Could not reach the TON network just now. Nothing was sent — try again in a minute.',
  mnemonic_must_be_24_words: 'TON_PAYOUT_MNEMONIC must be exactly 24 words.',
  no_confirmation_yet: 'The transfer was sent but the network has not confirmed it yet.',
  send_error: 'An error happened while sending.',
};
const reasonText = (code) => REASONS[code] || String(code || 'unknown error');

// ONE payout at a time. Two payouts sent at the same moment would use the same wallet sequence number: one of them would be
// dropped by the network while the other one makes the code believe both were sent. So a short lock is taken first.
async function acquireLock() {
  try {
    const c = await getCollection('payoutLock');
    const now = new Date();
    const r = await c.findOneAndUpdate(
      { _id: 'payout', $or: [{ until: { $lt: now } }, { until: { $exists: false } }] },
      { $set: { until: new Date(now.getTime() + 90 * 1000), at: now } },
      { upsert: true, returnDocument: 'after' }
    );
    return !!r;
  } catch (e) {
    return false; // duplicate key = somebody else holds the lock right now
  }
}
async function releaseLock() {
  try { const c = await getCollection('payoutLock'); await c.updateOne({ _id: 'payout' }, { $set: { until: new Date(0) } }); } catch (e) { /* the lock expires by itself after 90s */ }
}

// `w` must already be flipped to status 'paying' by the caller. Returns { state, error?, detail? }
//   state: 'paid' | 'failed' (back to pending) | 'uncertain' (payout_check)
async function autoPay(col, w, lib) {
  let r;
  let locked = false;
  try {
    lib = lib || loadPayoutLib();
    if (String(w.unit).toUpperCase() !== 'USDT') r = { ok: false, kind: 'definite', error: 'unsupported_unit' };
    else if (!(locked = await acquireLock())) r = { ok: false, kind: 'definite', error: 'payout_busy' };
    else r = await lib.sendUsdt(w.address, w.convertedAmount);
  } catch (e) {
    // An exception this late is unexpected: treat as uncertain (safest — a human checks the wallet).
    r = { ok: false, kind: 'uncertain', error: 'send_error', detail: String((e && e.message) || e).slice(0, 120) };
  } finally {
    if (locked) await releaseLock();
  }

  const now = new Date();
  if (r.ok) {
    await col.updateOne({ _id: w._id, status: 'paying' }, { $set: { status: 'approved', paidAt: now, payoutSeqno: r.seqno ?? null, payoutTxHash: r.txHash || null, payoutMode: 'auto' } });
    return { state: 'paid', txHash: r.txHash || null };
  }
  const note = `${r.error}${r.detail ? ' — ' + r.detail : ''}`.slice(0, 200);
  if (r.kind === 'definite') {
    await col.updateOne(
      { _id: w._id, status: 'paying' },
      { $set: { status: 'pending', lastPayoutError: note, lastPayoutErrorAt: now }, $unset: { processedAt: '' } }
    );
    return { state: 'failed', error: r.error, detail: r.detail };
  }
  await col.updateOne({ _id: w._id, status: 'paying' }, { $set: { status: 'payout_check', payoutNote: note, payoutCheckAt: now } });
  return { state: 'uncertain', error: r.error, detail: r.detail };
}

module.exports = { autoPay, reasonText, isConfigured, loadPayoutLib };
