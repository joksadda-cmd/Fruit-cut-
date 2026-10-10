// lib/onboarding.js
// New-user onboarding (added Oct 2026). A brand-new account must pass, in order:
//
//   1. puzzle    — tap 3 fruits in the shown order (server-checked)
//   2. code      — the bot DMs a 4-digit code as an IMAGE; user types it in the app
//   3. join      — join Official Channel + Community (Telegram getChatMember)
//   4. language  — pick a language
//   5. terms     — accept Rules & Terms  -> account opens
//
// When step 5 is done the inviter (if any) gets ONBOARD_REFERRER_REWARD_FC (50 FC)
// and the referral is counted for the weekly Top Referrer contest.
//
// State lives on the user doc: onboardedAt (null = still onboarding; field missing
// = old account, never onboarded again) and onboardStep.
//
// No new api/*.js file (Vercel Hobby = 12 functions max) — these handlers are
// called from api/auth.js. The code image is drawn here as a PNG with only
// Node built-ins (zlib), so no npm dependency is needed.

const crypto = require('crypto');
const zlib = require('zlib');
const { getCollection, findUserByTelegramId } = require('./db');
const { checkChannelMembership } = require('./joinGate');
const { sendTelegramMessage } = require('./notify');
const { TRANSACTION_TYPES } = require('./constants');

const ONBOARD_REFERRER_REWARD_FC = 50;

const STEPS = ['puzzle', 'code', 'join', 'language', 'terms'];

const PUZZLE_POOL = ['🍎', '🍊', '🍇', '🍉', '🍓', '🍋', '🍑', '🥝'];
const PUZZLE_SEQ_LEN = 3;
const PUZZLE_GRID = 6;
const PUZZLE_MIN_MS = 600;
const PUZZLE_MAX_MS = 90 * 1000;
const PUZZLE_MAX_ATTEMPTS = 5;

const CODE_TTL_MS = 2 * 60 * 1000;      // 2 minutes
const CODE_RESEND_COOLDOWN_MS = 30 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const CODE_MAX_SENDS = 8;               // per account, stops DM spam

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── PNG drawing (pixel font, same look as a "digital" verification code) ──
const FONT = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

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

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function renderCodePng(code) {
  const W = 640;
  const H = 300;
  const px = Buffer.alloc(W * H * 3);

  const setPx = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    px[i] = r; px[i + 1] = g; px[i + 2] = b;
  };
  const rect = (x0, y0, w, h, r, g, b) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPx(x, y, r, g, b);
  };

  // background + faint grid
  rect(0, 0, W, H, 8, 16, 38);
  for (let x = 0; x < W; x += 32) rect(x, 0, 1, H, 14, 30, 62);
  for (let y = 0; y < H; y += 32) rect(0, y, W, 1, 14, 30, 62);

  // glowing top bar + border
  rect(24, 20, W - 48, 6, 0, 200, 255);
  rect(0, 0, W, 4, 0, 160, 220);
  rect(0, H - 4, W, 4, 0, 160, 220);
  rect(0, 0, 4, H, 0, 160, 220);
  rect(W - 4, 0, 4, H, 0, 160, 220);

  // 4 digit boxes
  const scale = 14;               // 5x7 font -> 70x98 px per digit
  const dw = 5 * scale;
  const dh = 7 * scale;
  const boxPad = 14;
  const boxW = dw + boxPad * 2;
  const boxH = dh + boxPad * 2;
  const gap = 14;
  const totalW = 4 * boxW + 3 * gap;
  const startX = Math.floor((W - totalW) / 2);
  const startY = Math.floor((H - boxH) / 2) + 12;

  for (let d = 0; d < 4; d++) {
    const bx = startX + d * (boxW + gap);
    rect(bx, startY, boxW, boxH, 10, 28, 58);
    rect(bx, startY, boxW, 2, 0, 190, 240);
    rect(bx, startY + boxH - 2, boxW, 2, 0, 190, 240);
    rect(bx, startY, 2, boxH, 0, 190, 240);
    rect(bx + boxW - 2, startY, 2, boxH, 0, 190, 240);

    const glyph = FONT[code[d]];
    // tiny per-digit jitter so the image is not a perfect template
    const jx = crypto.randomInt(-3, 4);
    const jy = crypto.randomInt(-3, 4);
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] === '1') {
          rect(bx + boxPad + gx * scale + jx, startY + boxPad + gy * scale + jy, scale, scale, 255, 255, 255);
        }
      }
    }
  }

  // light noise so naive OCR scripts struggle (still easy for a human)
  for (let i = 0; i < 700; i++) {
    const v = crypto.randomInt(40, 120);
    setPx(crypto.randomInt(0, W), crypto.randomInt(0, H), v, v + 30, v + 80);
  }
  for (let l = 0; l < 4; l++) {
    const y0 = crypto.randomInt(startY, startY + boxH);
    const slope = crypto.randomInt(-2, 3);
    for (let x = startX; x < startX + totalW; x++) {
      const y = y0 + Math.floor(((x - startX) * slope) / 40);
      setPx(x, y, 70, 130, 190);
    }
  }

  // PNG scanlines (filter byte 0 per row)
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function sendCodeImage(telegramId, code) {
  const token = process.env.BOT_TOKEN;
  if (!token) return { ok: false, description: 'missing BOT_TOKEN' };
  const form = new FormData();
  form.append('chat_id', String(telegramId));
  form.append(
    'caption',
    `🔐 <b>FRUIT CUT · Verify it's you</b>\n\nHere is your secure 4-digit verification code:\n👉 <b>Check the image above!</b>\n\n⏱ Validity: 2 minutes\n<i>Enter this 4-digit code in the app to unlock access.\nNever share this code.</i>`
  );
  form.append('parse_mode', 'HTML');
  form.append('photo', new Blob([renderCodePng(code)], { type: 'image/png' }), 'code.png');
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
    return await res.json();
  } catch (err) {
    console.error('sendCodeImage failed:', err);
    return { ok: false, description: String(err) };
  }
}

function onboardingState(user) {
  // Old accounts have no onboardedAt field at all -> never onboarded again.
  if (!user || user.onboardedAt !== null) return { needed: false, step: 'done' };
  return { needed: true, step: STEPS.includes(user.onboardStep) ? user.onboardStep : 'puzzle' };
}

async function setStep(usersCol, user, step) {
  await usersCol.updateOne({ _id: user._id }, { $set: { onboardStep: step } });
  return { success: true, step };
}

// ── action handlers ─────────────────────────────────────────────────
async function puzzleStart(usersCol, user) {
  const grid = shuffle(PUZZLE_POOL).slice(0, PUZZLE_GRID);
  const target = shuffle(grid).slice(0, PUZZLE_SEQ_LEN);
  await usersCol.updateOne(
    { _id: user._id },
    { $set: { onboardPuzzle: { grid, target, issuedAt: new Date(), attempts: 0 } } }
  );
  return { success: true, grid, target };
}

async function puzzleVerify(usersCol, user, tapped) {
  const ch = user.onboardPuzzle;
  if (!ch || !ch.target) return { success: false, error: 'no_active_challenge' };
  const elapsed = Date.now() - new Date(ch.issuedAt).getTime();
  if (elapsed > PUZZLE_MAX_MS) return { success: false, error: 'expired' };
  if (elapsed < PUZZLE_MIN_MS) return { success: false, error: 'too_fast' };

  const ok = Array.isArray(tapped) && tapped.length === ch.target.length && tapped.every((v, i) => v === ch.target[i]);
  if (!ok) {
    const attempts = (ch.attempts || 0) + 1;
    if (attempts >= PUZZLE_MAX_ATTEMPTS) {
      await usersCol.updateOne({ _id: user._id }, { $unset: { onboardPuzzle: '' } });
      return { success: false, error: 'too_many_attempts' };
    }
    await usersCol.updateOne({ _id: user._id }, { $set: { 'onboardPuzzle.attempts': attempts } });
    return { success: false, error: 'wrong', attemptsLeft: PUZZLE_MAX_ATTEMPTS - attempts };
  }
  await usersCol.updateOne({ _id: user._id }, { $set: { onboardStep: 'code' }, $unset: { onboardPuzzle: '' } });
  return { success: true, step: 'code' };
}

async function codeSend(usersCol, user) {
  const prev = user.onboardCode || {};
  if (prev.sentAt && Date.now() - new Date(prev.sentAt).getTime() < CODE_RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((CODE_RESEND_COOLDOWN_MS - (Date.now() - new Date(prev.sentAt).getTime())) / 1000);
    return { success: false, error: 'cooldown', waitSeconds: wait };
  }
  if ((prev.sends || 0) >= CODE_MAX_SENDS) return { success: false, error: 'too_many_sends' };

  const code = String(crypto.randomInt(1000, 10000));
  const sent = await sendCodeImage(user.telegramId, code);
  if (!sent || !sent.ok) {
    // 403 / "chat not found" = user never started the bot.
    return { success: false, error: 'cannot_dm', detail: sent && sent.description };
  }
  await usersCol.updateOne(
    { _id: user._id },
    {
      $set: {
        onboardCode: {
          code,
          sentAt: new Date(),
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
          attempts: 0,
          sends: (prev.sends || 0) + 1,
        },
      },
    }
  );
  return { success: true, expiresInSeconds: CODE_TTL_MS / 1000 };
}

async function codeVerify(usersCol, user, rawCode) {
  const c = user.onboardCode;
  if (!c || !c.code) return { success: false, error: 'no_code' };
  if (new Date(c.expiresAt).getTime() < Date.now()) return { success: false, error: 'expired' };
  if ((c.attempts || 0) >= CODE_MAX_ATTEMPTS) return { success: false, error: 'too_many_attempts' };

  const given = String(rawCode || '').trim();
  if (given !== c.code) {
    await usersCol.updateOne({ _id: user._id }, { $inc: { 'onboardCode.attempts': 1 } });
    return { success: false, error: 'wrong', attemptsLeft: CODE_MAX_ATTEMPTS - (c.attempts || 0) - 1 };
  }
  await usersCol.updateOne({ _id: user._id }, { $set: { onboardStep: 'join' }, $unset: { onboardCode: '' } });
  return { success: true, step: 'join' };
}

async function joinVerify(usersCol, user) {
  const channels = await checkChannelMembership(user.telegramId);
  const allJoined = channels.every((c) => c.joined);
  if (!allJoined) return { success: true, allJoined: false, channels };
  await usersCol.updateOne({ _id: user._id }, { $set: { onboardStep: 'language' } });
  return { success: true, allJoined: true, channels, step: 'language' };
}

async function finish(usersCol, user, deps) {
  // Atomic: only the first call flips onboardedAt, so the 50 FC can never double-pay.
  const done = await usersCol.findOneAndUpdate(
    { _id: user._id, onboardedAt: null },
    { $set: { onboardedAt: new Date(), onboardStep: 'done', termsAcceptedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!done) return { success: true, step: 'done' };

  if (done.referredBy && String(done.referredBy) !== String(done.telegramId)) {
    try {
      const referrer = await findUserByTelegramId(usersCol, done.referredBy);
      if (referrer && !referrer.banned) {
        const updated = await usersCol.findOneAndUpdate(
          { _id: referrer._id },
          { $inc: { fruitCoin: ONBOARD_REFERRER_REWARD_FC, referralFruitCoinEarned: ONBOARD_REFERRER_REWARD_FC }, $set: { lastActive: new Date() } },
          { returnDocument: 'after' }
        );
        const txCol = await getCollection('transactions');
        await txCol.insertOne({
          telegramId: referrer.telegramId,
          type: TRANSACTION_TYPES.REFERRAL_REWARD,
          amount: ONBOARD_REFERRER_REWARD_FC,
          balanceAfter: updated ? updated.fruitCoin : referrer.fruitCoin,
          meta: { step: 'onboarding', milestone: 'finished account verification', referredTelegramId: done.telegramId },
          createdAt: new Date(),
        });
        const who = done.username && done.username !== 'Player' ? `@${done.username}` : 'Your friend';
        sendTelegramMessage(
          referrer.telegramId,
          `🎉 <b>Friend Verified!</b>\n\n${who} finished account verification.\n\n🍎 +${ONBOARD_REFERRER_REWARD_FC} Fruit Coin`,
          { reply_markup: { inline_keyboard: [[{ text: '🎮 Open Game', url: 'https://t.me/Fruit_cut_bot/PlayTo_Earn' }]] } }
        ).catch(() => {});
      }
      // Count for the weekly Top Referrer contest right now (the account just
      // passed puzzle + DM code + channel join + terms, so it is a real person).
      if (deps && deps.onReferralVerified) await deps.onReferralVerified(done);
    } catch (err) {
      console.error('onboarding referral reward error:', err);
    }
  }
  return { success: true, step: 'done', rewardedReferrer: !!done.referredBy };
}

// Single entry point used by api/auth.js
async function handleOnboardingAction(action, telegramId, body, deps) {
  const usersCol = await getCollection('users');
  const user = await findUserByTelegramId(usersCol, telegramId);
  if (!user) return { success: false, error: 'user_not_found' };
  if (user.banned) return { success: false, error: 'banned' };

  const st = onboardingState(user);
  if (!st.needed) return { success: true, step: 'done' };

  const need = (step) => (st.step === step ? null : { success: false, error: 'wrong_step', step: st.step });

  switch (action) {
    case 'onboard_state':
      return { success: true, step: st.step };
    case 'onboard_puzzle_start':
      return need('puzzle') || puzzleStart(usersCol, user);
    case 'onboard_puzzle_verify':
      return need('puzzle') || puzzleVerify(usersCol, user, body.tappedSequence);
    case 'onboard_code_send':
      return need('code') || codeSend(usersCol, user);
    case 'onboard_code_verify':
      return need('code') || codeVerify(usersCol, user, body.code);
    case 'onboard_join_verify':
      return need('join') || joinVerify(usersCol, user);
    case 'onboard_language_done':
      return need('language') || setStep(usersCol, user, 'terms');
    case 'onboard_finish':
      return need('terms') || finish(usersCol, user, deps);
    default:
      return { success: false, error: 'unknown_action' };
  }
}

module.exports = { handleOnboardingAction, onboardingState, ONBOARD_REFERRER_REWARD_FC, renderCodePng };
