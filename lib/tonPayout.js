// lib/tonPayout.js
// AUTOMATIC USDT PAYOUTS: when the admin taps "Approve & Pay" in the bot, the server sends the USDT
// (TON network) from YOUR payout wallet straight to the user's wallet. Nobody has to open Tonkeeper.
//
// ENV (Vercel):
//   TON_PAYOUT_MNEMONIC   required  - the 24 secret words of the payout wallet, separated by spaces
//   TON_WALLET_VERSION    optional  - 'v5r1' (default, new Tonkeeper wallets), 'v4r2' or 'v3r2' (older wallets).
//                                     Leave it empty and set TON_PAYOUT_ADDRESS: the version is then found automatically.
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

const { TonClient, WalletContractV3R2, WalletContractV4, WalletContractV5R1, internal, toNano, Address, beginCell, SendMode } = require('@ton/ton');
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

// toncenter WITHOUT an API key allows only 1 request/second, so the calls are queued 1.1s apart (this is what makes a
// payout slow: ~25-40s). WITH a free TONCENTER_API_KEY (10 requests/second) nothing is queued and a payout takes ~10-20s.
let lastCallAt = 0;
let paceChain = Promise.resolve();
function pace() {
  if (process.env.TONCENTER_API_KEY) return Promise.resolve();
  const p = paceChain.then(async () => {
    const wait = lastCallAt + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
  });
  paceChain = p.catch(() => {});
  return p;
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

function makeContract(version, publicKey) {
  if (version === 'v4r2' || version === 'v4') return WalletContractV4.create({ workchain: 0, publicKey });
  if (version === 'v3r2' || version === 'v3') return WalletContractV3R2.create({ workchain: 0, publicKey });
  return WalletContractV5R1.create({ workchain: 0, publicKey });
}
const sameAddress = (a, b) => { try { return Address.parse(a).equals(b); } catch (e) { return false; } };

// Wallet version:
//   * TON_WALLET_VERSION set            -> use exactly that
//   * only TON_PAYOUT_ADDRESS is set    -> the server tries v5r1, v4r2, v3r2 and picks the one that gives YOUR address
//                                          (so an old Tonkeeper wallet works without knowing its version)
//   * neither is set                    -> v5r1 (new Tonkeeper wallets)
async function loadWallet() {
  const words = String(process.env.TON_PAYOUT_MNEMONIC || '').trim().split(/\s+/).filter(Boolean);
  if (words.length !== 24) throw new Error('mnemonic_must_be_24_words');
  const keys = await mnemonicToPrivateKey(words);
  const explicit = String(process.env.TON_WALLET_VERSION || '').trim().toLowerCase();
  const expected = String(process.env.TON_PAYOUT_ADDRESS || '').trim();

  let version = explicit || 'v5r1';
  let contract = makeContract(version, keys.publicKey);
  if (expected) {
    if (explicit) {
      if (!sameAddress(expected, contract.address)) {
        const err = new Error('wallet_address_mismatch');
        err.derived = contract.address.toString({ bounceable: false });
        throw err;
      }
    } else {
      let found = null;
      const derived = [];
      for (const v of ['v5r1', 'v4r2', 'v3r2']) {
        const c = makeContract(v, keys.publicKey);
        derived.push(`${v}: ${c.address.toString({ bounceable: false })}`);
        if (!found && sameAddress(expected, c.address)) found = { v, c };
      }
      if (!found) {
        const err = new Error('wallet_address_mismatch');
        err.derived = derived.join(' | ');
        throw err;
      }
      version = found.v; contract = found.c;
    }
  }
  const c = client();
  return { c, keys, contract, opened: c.open(contract), address: contract.address, version };
}

// The USDT "jetton wallet" address of an owner never changes, so it is looked up once per server instance.
const jwCache = new Map();
async function jettonWalletOf(c, owner) {
  const key = owner.toString();
  if (jwCache.has(key)) return jwCache.get(key);
  const r = await retry(() => c.runMethod(Address.parse(USDT_MASTER), 'get_wallet_address', [
    { type: 'slice', cell: beginCell().storeAddress(owner).endCell() },
  ]));
  const addr = r.stack.readAddress();
  jwCache.set(key, addr);
  return addr;
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
    await sleep(1000);
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
    // the TON balance and the USDT wallet address are independent, so ask for both at the same time
    const [tonBal, jwAddr] = await Promise.all([retry(() => w.c.getBalance(w.address)), jettonWalletOf(w.c, w.address)]);
    if (tonBal < MIN_TON_NEEDED) return { ok: false, kind: 'definite', error: 'not_enough_ton_for_fees', detail: `${(Number(tonBal) / 1e9).toFixed(3)} TON` };
    jw = jwAddr;
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
    const deadline = Date.now() + 35000;
    const pollMs = process.env.TONCENTER_API_KEY ? 1200 : 0; // without a key the 1.1s queue already spaces the calls
    while (Date.now() < deadline) {
      if (pollMs) await sleep(pollMs);
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
