// lib/lottery.js
// Server-authoritative 777 Lottery prize table + picker.
//
// IMPORTANT: this file is the ONLY place the winning percentages live.
// api/lottery.js never sends `weight` back to the client — the frontend
// only gets the id/label/icon it won, per Rashu's spec ("winning chance
// hide rakhbe"). Prize VALUES are also never trusted from the client —
// the server picks the prize AND applies the reward in one atomic flow.

const PRIZES = [
  { id: 1,  type: 'coin',     val: 2000, weight: 20, label: '2000 🪙 Gold',        icon: '🪙' },
  { id: 2,  type: 'coin',     val: 500,  weight: 20, label: '500 🪙 Gold',         icon: '🪙' },
  { id: 3,  type: 'coin',     val: 1000, weight: 10, label: '1000 🪙 Gold',        icon: '🪙' },
  { id: 4,  type: 'fc',       val: 20,   weight: 10, label: '20 🍎 Fruit Coin',    icon: '🍎' },
  { id: 5,  type: 'fc',       val: 100,  weight: 5,  label: '100 🍎 Fruit Coin',   icon: '🍎' },
  { id: 6,  type: 'lottoken', val: 2,    weight: 5,  label: '2 🎫 Lottery Token',  icon: '🎫' },
  { id: 7,  type: 'fc',       val: 50,   weight: 10, label: '50 🍎 Fruit Coin',    icon: '🍎' },
  { id: 8,  type: 'token',    val: 2,    weight: 10, label: '2 🎮 Game Token',     icon: '🎮' },
  { id: 9,  type: 'token',    val: 3,    weight: 9,  label: '3 🎮 Game Token',     icon: '🎮' },
  { id: 10, type: 'fc',       val: 1000, weight: 1,  label: '1000 🍎 Fruit Coin',  icon: '🍎' },
];

const TOTAL_WEIGHT = PRIZES.reduce((sum, p) => sum + p.weight, 0); // should be 100

function pickPrize() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const p of PRIZES) {
    r -= p.weight;
    if (r < 0) return p;
  }
  return PRIZES[PRIZES.length - 1]; // float rounding fallback
}

// Public-safe view: id/type/val/label/icon only — NEVER weight.
function publicPrizeList() {
  return PRIZES.map(({ id, type, val, label, icon }) => ({ id, type, val, label, icon }));
}

module.exports = { PRIZES, TOTAL_WEIGHT, pickPrize, publicPrizeList };
