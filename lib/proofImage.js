// lib/proofImage.js
// When the admin APPROVES a withdrawal, the bot posts a "PAYMENT SUCCESSFUL"
// proof to the official group (and the payment channel): a generated picture
// (same pixel style as the new-user verification code image) + a caption that
// mentions the user.
//
// The picture is drawn here as a PNG with Node built-ins only (zlib) — no npm
// package, no canvas, no font files. Names with characters the pixel font
// cannot draw (Bengali, emoji ...) are left out of the PICTURE only; the caption
// always carries the real, clickable mention.

const zlib = require('zlib');

// Where proofs are posted: the official group https://t.me/fruit_cut_group
// The bot must be an ADMIN there (allowed to post). To add another target later,
// just add its @username to this list; a failure in one target never blocks the others.
const PROOF_TARGETS = ['@fruit_cut_group'];

// ── 5x7 pixel font ──────────────────────────────────────────────────
const G = {
  A: '01110,10001,10001,11111,10001,10001,10001', B: '11110,10001,10001,11110,10001,10001,11110',
  C: '01110,10001,10000,10000,10000,10001,01110', D: '11110,10001,10001,10001,10001,10001,11110',
  E: '11111,10000,10000,11110,10000,10000,11111', F: '11111,10000,10000,11110,10000,10000,10000',
  G: '01110,10001,10000,10111,10001,10001,01111', H: '10001,10001,10001,11111,10001,10001,10001',
  I: '01110,00100,00100,00100,00100,00100,01110', J: '00111,00010,00010,00010,00010,10010,01100',
  K: '10001,10010,10100,11000,10100,10010,10001', L: '10000,10000,10000,10000,10000,10000,11111',
  M: '10001,11011,10101,10101,10001,10001,10001', N: '10001,11001,10101,10011,10001,10001,10001',
  O: '01110,10001,10001,10001,10001,10001,01110', P: '11110,10001,10001,11110,10000,10000,10000',
  Q: '01110,10001,10001,10001,10101,10010,01101', R: '11110,10001,10001,11110,10100,10010,10001',
  S: '01111,10000,10000,01110,00001,00001,11110', T: '11111,00100,00100,00100,00100,00100,00100',
  U: '10001,10001,10001,10001,10001,10001,01110', V: '10001,10001,10001,10001,10001,01010,00100',
  W: '10001,10001,10001,10101,10101,11011,10001', X: '10001,10001,01010,00100,01010,10001,10001',
  Y: '10001,10001,01010,00100,00100,00100,00100', Z: '11111,00001,00010,00100,01000,10000,11111',
  0: '01110,10001,10011,10101,11001,10001,01110', 1: '00100,01100,00100,00100,00100,00100,01110',
  2: '01110,10001,00001,00010,00100,01000,11111', 3: '11110,00001,00001,01110,00001,00001,11110',
  4: '00010,00110,01010,10010,11111,00010,00010', 5: '11111,10000,11110,00001,00001,10001,01110',
  6: '00110,01000,10000,11110,10001,10001,01110', 7: '11111,00001,00010,00100,01000,01000,01000',
  8: '01110,10001,10001,01110,10001,10001,01110', 9: '01110,10001,10001,01111,00001,00010,01100',
  '.': '00000,00000,00000,00000,00000,01100,01100', ':': '00000,01100,01100,00000,01100,01100,00000',
  '-': '00000,00000,00000,11111,00000,00000,00000', '_': '00000,00000,00000,00000,00000,00000,11111',
  '@': '01110,10001,10111,10101,10110,10000,01110', '/': '00001,00010,00010,00100,01000,01000,10000',
  ',': '00000,00000,00000,00000,01100,00100,01000', '+': '00000,00100,00100,11111,00100,00100,00000',
  ' ': '00000,00000,00000,00000,00000,00000,00000',
};
const FONT = {};
for (const [ch, rows] of Object.entries(G)) FONT[ch] = rows.split(',');

// Keep only what the pixel font can draw.
function drawable(text, max) {
  const t = String(text || '').toUpperCase().replace(/[^A-Z0-9.:\-_@/,+ ]/g, '').replace(/\s+/g, ' ').trim();
  return t.slice(0, max);
}
const textWidth = (t, scale) => (t.length ? t.length * 6 * scale - scale : 0);

// ── PNG encoder ─────────────────────────────────────────────────────
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const tb = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([len, tb, data, crc]);
}

function renderProofPng({ amount, unit, username, method, dateText }) {
  const W = 800, H = 450;
  const px = Buffer.alloc(W * H * 3);
  const set = (x, y, r, g, b) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 3; px[i] = r; px[i + 1] = g; px[i + 2] = b; };
  const rect = (x0, y0, w, h, c) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, c[0], c[1], c[2]); };
  const text = (t, cx, y, scale, c) => {
    let x = Math.round(cx - textWidth(t, scale) / 2);
    for (const ch of t) {
      const glyph = FONT[ch];
      if (glyph) for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) if (glyph[gy][gx] === '1') rect(x + gx * scale, y + gy * scale, scale, scale, c);
      x += 6 * scale;
    }
  };
  const fitScale = (t, maxW, maxScale) => { let s = maxScale; while (s > 1 && textWidth(t, s) > maxW) s--; return s; };

  const CYAN = [0, 200, 255], GREEN = [60, 230, 120], WHITE = [255, 255, 255], GOLD = [255, 204, 0], GRAY = [140, 165, 190];

  // background with a soft vertical gradient + grid
  for (let y = 0; y < H; y++) { const k = y / H; rect(0, y, W, 1, [Math.round(8 + 6 * k), Math.round(16 + 14 * k), Math.round(38 + 22 * k)]); }
  for (let x = 0; x < W; x += 40) rect(x, 0, 1, H, [16, 34, 68]);
  for (let y = 0; y < H; y += 40) rect(0, y, W, 1, [16, 34, 68]);
  rect(0, 0, W, 5, CYAN); rect(0, H - 5, W, 5, CYAN); rect(0, 0, 5, H, CYAN); rect(W - 5, 0, 5, H, CYAN);
  rect(30, 22, W - 60, 6, GREEN);

  // green circle with a check mark
  const cx = W / 2, cy = 92, R = 40;
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) if (x * x + y * y <= R * R) set(cx + x, cy + y, GREEN[0], GREEN[1], GREEN[2]);
  const thick = (x0, y0, x1, y1, t) => { const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)); for (let i = 0; i <= n; i++) { const x = Math.round(x0 + ((x1 - x0) * i) / n), y = Math.round(y0 + ((y1 - y0) * i) / n); rect(x - t, y - t, t * 2 + 1, t * 2 + 1, [8, 24, 44]); } };
  thick(cx - 18, cy + 2, cx - 5, cy + 15, 4);
  thick(cx - 5, cy + 15, cx + 20, cy - 14, 4);

  // title
  text('PAYMENT SUCCESSFUL', W / 2, 140, 6, GREEN);

  // amount
  const amt = drawable(`${amount} ${unit}`, 20);
  text(amt, W / 2, 210, fitScale(amt, 700, 11), WHITE);

  // method line
  const meth = drawable(`VIA ${method || 'TONKEEPER'}`, 28);
  text(meth, W / 2, 298, 3, CYAN);

  // divider
  rect(60, 326, W - 120, 2, [30, 60, 100]);

  // user + date
  const name = drawable(username, 18);
  if (name) {
    text('USER', 200, 342, 3, GRAY);
    text(name, 200, 368, fitScale(name, 330, 5), WHITE);
  } else {
    text('FRUIT CUT PLAYER', 200, 356, 3, WHITE);
  }
  text('DATE', 600, 342, 3, GRAY);
  const dt = drawable(dateText, 26);
  text(dt, 600, 372, fitScale(dt, 300, 3), WHITE);

  // brand
  text('FRUIT CUT - SLICE MANIA', W / 2, 416, 3, GOLD);

  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ── caption + posting ───────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function maskAddress(a) {
  const s = String(a || '');
  return s.length <= 10 ? s : `${s.slice(0, 4)}••••${s.slice(-4)}`;
}
function formatDate(d) {
  const t = d instanceof Date ? d : new Date(d || Date.now());
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const p = (n) => String(n).padStart(2, '0');
  return `${p(t.getUTCDate())} ${months[t.getUTCMonth()]} ${t.getUTCFullYear()} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())} UTC`;
}
function methodLabel(m) {
  const k = String(m || '').toLowerCase();
  return k.includes('ton') ? 'TonKeeper (TON network)' : (m || 'Wallet');
}

function buildCaption(w) {
  const name = esc(w.username || 'Player');
  return (
    `✅ <b>PAYMENT SUCCESSFUL</b> ✅\n\n` +
    `👤 <a href="tg://user?id=${w.telegramId}">${name}</a> just got paid!\n` +
    `💵 Amount: <b>${w.convertedAmount} ${w.unit}</b>\n` +
    `🏦 Method: ${esc(methodLabel(w.method))}\n` +
    `📍 Wallet: <code>${esc(maskAddress(w.address))}</code>\n` +
    `🕒 ${formatDate(new Date())}\n\n` +
    `🍎 Slash fruits, finish tasks and withdraw real USDT — you can be next! 🚀`
  );
}

// Posts the proof to every target. Returns [{ target, ok, mode, error }].
async function postPaymentProof(w, miniAppUrl) {
  const token = process.env.BOT_TOKEN;
  const caption = buildCaption(w);
  const markup = { inline_keyboard: [[{ text: '🎮 Start Earning', url: miniAppUrl }]] };
  const results = [];
  let fileId = null; // after the first upload, reuse Telegram's file_id for the other targets

  let png = null;
  try {
    png = renderProofPng({ amount: w.convertedAmount, unit: w.unit, username: w.username, method: String(w.method || 'TonKeeper'), dateText: formatDate(new Date()) });
  } catch (e) { console.error('proof image render failed:', e); }

  for (const target of PROOF_TARGETS) {
    try {
      let r = null;
      if (fileId || png) {
        if (fileId) {
          r = await (await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: target, photo: fileId, caption, parse_mode: 'HTML', reply_markup: markup }),
          })).json();
        } else {
          const form = new FormData();
          form.append('chat_id', target); form.append('caption', caption); form.append('parse_mode', 'HTML');
          form.append('reply_markup', JSON.stringify(markup));
          form.append('photo', new Blob([png], { type: 'image/png' }), 'payment_proof.png');
          r = await (await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form })).json();
          if (r && r.ok && r.result && r.result.photo) fileId = r.result.photo[r.result.photo.length - 1].file_id;
        }
        if (r && r.ok) { results.push({ target, ok: true, mode: 'photo' }); continue; }
      }
      // fallback: plain text (never lose the proof because of a picture problem)
      const t = await (await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: target, text: caption, parse_mode: 'HTML', reply_markup: markup, disable_web_page_preview: true }),
      })).json();
      results.push({ target, ok: !!(t && t.ok), mode: 'text', error: t && !t.ok ? t.description : (r && r.description) || undefined });
    } catch (e) {
      results.push({ target, ok: false, error: String(e.message || e) });
    }
  }
  return results;
}

module.exports = { postPaymentProof, renderProofPng, buildCaption, PROOF_TARGETS };
