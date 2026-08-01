// lib/lottery.js
// Server-authoritative 777 Lottery prize table + picker.
//
// IMPORTANT: this file is the ONLY place the winning percentages live.
// api/lottery.js never sends `weight` back to the client — the frontend
// only gets the id/label/icon it won, per Rashu's spec ("winning chance
// hide rakhbe"). Prize VALUES are also never trusted from the client —
// the server picks the prize AND applies the reward in one atomic flow.

// NOTE: Rashu's spec added up to 110% (30+15+4.5+10+5+20+15+5+5+0.5=110),
// not 100. Weights below are entered EXACTLY as given — pickPrize() below
// divides by TOTAL_WEIGHT (whatever it actually sums to), so this still
// produces mathematically valid odds, but each item's REAL chance is its
// stated % ÷ 1.1 (e.g. "100 Gold 30%" actually lands ~27.3%, not 30%).
// If exact round numbers matter, cut 10 points from somewhere and this
// comment can be updated to say "should be 100" again.
const PRIZES = [
  { id: 1,  type: 'coin',     val: 100,  weight: 30,  label: '100 🪙 Gold',         icon: '🪙' },
  { id: 2,  type: 'coin',     val: 1000, weight: 15,  label: '1000 🪙 Gold',        icon: '🪙' },
  { id: 3,  type: 'fc',       val: 100,  weight: 4.5, label: '100 🍎 Fruit Coin',   icon: '🍎' },
  { id: 4,  type: 'fc',       val: 50,   weight: 10,  label: '50 🍎 Fruit Coin',    icon: '🍎' },
  { id: 5,  type: 'token',    val: 3,    weight: 5,   label: '3 🎮 Game Token',     icon: '🎮' },
  { id: 6,  type: 'coin',     val: 200,  weight: 20,  label: '200 🪙 Gold',         icon: '🪙' },
  { id: 7,  type: 'fc',       val: 20,   weight: 15,  label: '20 🍎 Fruit Coin',    icon: '🍎' },
  { id: 8,  type: 'lottoken', val: 2,    weight: 5,   label: '2 🎫 Lottery Token',  icon: '🎫' },
  { id: 9,  type: 'token',    val: 2,    weight: 5,   label: '2 🎮 Game Token',     icon: '🎮' },
  { id: 10, type: 'fc',       val: 1000, weight: 0.5, label: '1000 🍎 Fruit Coin',  icon: '🍎' },
];

const TOTAL_WEIGHT = PRIZES.reduce((sum, p) => sum + p.weight, 0); // = 110 (see note above)

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
