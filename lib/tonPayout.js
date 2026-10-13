// lib/tonPayout.js
// AUTOMATIC USDT PAYOUTS: when the admin taps "Approve & Pay" in the bot, the server sends the USDT
// (TON network) from YOUR payout wallet straight to the user's wallet. Nobody has to open Tonkeeper.
//
// ENV (Vercel):
//   TON_PAYOUT_MNEMONIC   required  - the 24 secret words of the payout wallet, separated by spaces
//   TON_WALLET_VERSION    optional  - 'v5r1' (default, new Tonkeeper wallets) or 'v4r2' (older wallets)
//   TON_PAYOUT_ADDRESS    optional  - the wallet address you expect. If the 24 words do not produce THIS address,
//                                     payouts are refused (protects you from a wrong word / wrong wallet version)
//   PAYOUT_MAX_USDT       optional  - safety cap for ONE payout (default 10)
//   TONCENTER_API_KEY     optional  - raises toncenter's rate limit
//
// SAFETY
//   * The wallet must hold USDT (TON network) + about 0.5 TON for network fees.
//   * Every payout result is one of:   ok  /  definite failure (nothing was sent)  /  uncertain (may have been sent).
//     Only a definite failure may be retried automatically — "uncertain" is always checked by a human first,
//     so the same withdrawal can never be paid twice.

const { TonClient, WalletContractV4, WalletContractV5R1, internal, toNano, Address, beginCell, SendMode } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');

// Official USDT jetton on TON (Tether). 6 decimals.
const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const USDT_DECIMALS = 6;
const GAS_ATTACHED = toNano('0.1');   // attached to the jetton transfer; the unused part comes back to the payout wallet
const MIN_TON_NEEDED = toNano('0.15');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isConfigured = () => !!String(process.env.TON_PAYOUT_MNEMONIC || '').trim();
const maxUsdt = () => Number(process.env.PAYOUT_MAX_USDT) > 0 ? Number(process.env.PAYOUT_MAX_USDT) : 10;

function client() {
  return new TonClient({
    endpoint: 'https://toncenter.com/api/v2/jsonRPC',
    apiKey: process.env.TONCENTER_API_KEY || undefined,
  });
}

// toncenter without a key allows ~1 request/second: space the calls out, and retry politely on "429 Too Many Requests".
let lastCallAt = 0;
async function pace() {
  if (process.env.TONCENTER_API_KEY) return;
  const wait = lastCallAt + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}
async function retry(fn) {
  let last;
  for (let i = 0; i < 5; i++) {
    try { await pace(); return await fn(); }
    catch (e) {
      last = e;
      const msg = String((e && (e.message || e.response && e.response.status)) || e);
      if (!/429|too many|rate/i.test(msg)) throw e;
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
}

async function loadWallet() {
  const words = String(process.env.TON_PAYOUT_MNEMONIC || '').trim().split(/\s+/).filter(Boolean);
  if (words.length !== 24) throw new Error('mnemonic_must_be_24_words');
  const keys = await mnemonicToPrivateKey(words);
  const version = String(process.env.TON_WALLET_VERSION || 'v5r1').toLowerCase();
  const contract = version === 'v4r2' || version === 'v4'
    ? WalletContractV4.create({ workchain: 0, publicKey: keys.publicKey })
    : WalletContractV5R1.create({ workchain: 0, publicKey: keys.publicKey });
  const expected = String(process.env.TON_PAYOUT_ADDRESS || '').trim();
  if (expected) {
    let same = false;
    try { same = Address.parse(expected).equals(contract.address); } catch (e) { same = false; }
    if (!same) {
      const err = new Error('wallet_address_mismatch');
      err.derived = contract.address.toString({ bounceable: false });
      throw err;
    }
  }
  const c = client();
  return { c, keys, contract, opened: c.open(contract), address: contract.address, version };
}

async function jettonWalletOf(c, owner) {
  const r = await retry(() => c.runMethod(Address.parse(USDT_MASTER), 'get_wallet_address', [
    { type: 'slice', cell: beginCell().storeAddress(owner).endCell() },
  ]));
  return r.stack.readAddress();
}

async function usdtBalanceOf(c, jettonWallet) {
  try {
    const r = await retry(() => c.runMethod(jettonWallet, 'get_wallet_data'));
    return r.stack.readBigNumber();            // 6-decimal units
  } catch (e) {
    return 0n;                                 // jetton wallet not created yet = no USDT
  }
}

const unitsToText = (u) => (Number(u) / 10 ** USDT_DECIMALS).toFixed(USDT_DECIMALS).replace(/\.?0+$/, '');
const textToUnits = (t) => BigInt(Math.round(parseFloat(t) * 10 ** USDT_DECIMALS));

// For the admin menu: shows whether the payout wallet is ready.
async function walletInfo() {
  if (!isConfigured()) return { ok: false, error: 'not_configured' };
  try {
    const w = await loadWallet();
    const tonBal = await retry(() => w.c.getBalance(w.address));
    const jw = await jettonWalletOf(w.c, w.address);
    const usdt = await usdtBalanceOf(w.c, jw);
    return {
      ok: true,
      address: w.address.toString({ bounceable: false }),
      version: w.version,
      ton: (Number(tonBal) / 1e9).toFixed(3),
      usdt: unitsToText(usdt) || '0',
      readyForPayout: tonBal >= MIN_TON_NEEDED && usdt > 0n,
    };
  } catch (e) {
    if (e && e.message === 'wallet_address_mismatch') return { ok: false, error: 'wallet_address_mismatch', derived: e.derived };
    return { ok: false, error: String((e && e.message) || e).slice(0, 120) };
  }
}

// After the transfer is accepted, look up its transaction hash (for the "View Transaction" link).
// Best effort: returns null if it cannot be found — the payment itself is already done.
async function findTxHash(w, jw, sinceSec) {
  for (let i = 0; i < 4; i++) {
    try {
      const txs = await retry(() => w.c.getTransactions(w.address, { limit: 6 }));
      for (const tx of txs) {
        if (tx.now < sinceSec - 5) continue;
        const outs = tx.outMessages.values();
        if (outs.some((m) => m.info && m.info.type === 'internal' && m.info.dest && m.info.dest.equals(jw))) {
          return tx.hash().toString('hex');
        }
      }
    } catch (e) { /* try again */ }
    await sleep(2000);
  }
  return null;
}

// Sends `amountUsdt` (text like "1.2345") of USDT to `destination`.
// Returns { ok:true } | { ok:false, kind:'definite'|'uncertain', error:'code', detail? }
async function sendUsdt(destination, amountUsdt) {
  if (!isConfigured()) return { ok: false, kind: 'definite', error: 'not_configured' };

  // ── Phase 1: checks. Nothing has been sent yet, so every failure here is "definite". ──
  let w, dest, units, jw;
  try {
    const amount = parseFloat(amountUsdt);
    if (!(amount > 0)) return { ok: false, kind: 'definite', error: 'bad_amount' };
    if (amount > maxUsdt()) return { ok: false, kind: 'definite', error: 'above_safety_cap', detail: `${amount} > ${maxUsdt()} USDT (PAYOUT_MAX_USDT)` };
    units = textToUnits(amountUsdt);

    try { dest = Address.parse(String(destination).trim()); }
    catch (e) { return { ok: false, kind: 'definite', error: 'bad_address' }; }

    w = await loadWallet();
    const tonBal = await retry(() => w.c.getBalance(w.address));
    if (tonBal < MIN_TON_NEEDED) return { ok: false, kind: 'definite', error: 'not_enough_ton_for_fees', detail: `${(Number(tonBal) / 1e9).toFixed(3)} TON` };
    jw = await jettonWalletOf(w.c, w.address);
    const usdtBal = await usdtBalanceOf(w.c, jw);
    if (usdtBal < units) return { ok: false, kind: 'definite', error: 'not_enough_usdt', detail: `${unitsToText(usdtBal) || '0'} USDT in wallet` };
  } catch (e) {
    if (e && e.message === 'wallet_address_mismatch') return { ok: false, kind: 'definite', error: 'wallet_address_mismatch', detail: e.derived };
    return { ok: false, kind: 'definite', error: 'check_failed', detail: String((e && e.message) || e).slice(0, 120) };
  }

  // ── Phase 2: broadcast. From here on a failure is "uncertain" (the transfer may or may not have gone out). ──
  try {
    const sinceSec = Math.floor(Date.now() / 1000);
    const seqBefore = await retry(() => w.opened.getSeqno());
    const body = beginCell()
      .storeUint(0x0f8a7ea5, 32)                       // jetton transfer
      .storeUint(BigInt(Date.now()), 64)               // query id
      .storeCoins(units)
      .storeAddress(dest)                              // new owner = the user
      .storeAddress(w.address)                         // unused gas goes back to us
      .storeBit(0)                                     // no custom payload
      .storeCoins(1n)                                  // forward amount (tiny)
      .storeBit(0)                                     // no forward payload
      .endCell();

    await retry(() => w.opened.sendTransfer({
      seqno: seqBefore,
      secretKey: w.keys.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
      messages: [internal({ to: jw, value: GAS_ATTACHED, bounce: true, body })],
    }));

    // The wallet's seqno goes up by one once the network has accepted our message.
    for (let i = 0; i < 12; i++) {
      await sleep(2500);
      let now;
      try { now = await w.opened.getSeqno(); } catch (e) { continue; }
      if (now > seqBefore) {
        let txHash = null;
        try { txHash = await findTxHash(w, jw, sinceSec); } catch (e) { txHash = null; }
        return { ok: true, seqno: seqBefore, txHash };
      }
    }
    return { ok: false, kind: 'uncertain', error: 'no_confirmation_yet' };
  } catch (e) {
    return { ok: false, kind: 'uncertain', error: 'send_error', detail: String((e && e.message) || e).slice(0, 120) };
  }
}

module.exports = { isConfigured, sendUsdt, walletInfo, USDT_MASTER };
