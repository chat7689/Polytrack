// Random player tracks, as JSON for tools/db/tracks.test.mjs: each with the
// game's own finish (TrackBuilder's gate), TrackKit.walk()'s reckoning and
// whether TrackKit.check() takes it. Most use today's pieces (a width on
// each); some are in the shorter form tracks were saved in before widths.
// Usage: node tracks_gen.js > ../db/tracks.json
const h = require('./harness.js'); const m = h.load(); const K = m.TrackKit;
let seed = 7;
const R = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const pick = (a) => a[Math.floor(R() * a.length)];
const val = (e) => (Array.isArray(e) ? e[0] : e);
const sign = () => (R() < 0.5 ? -1 : 1);
function piece() {
  const w = pick(K.WIDTHS.filter((x) => x <= 22));
  switch (pick('SSSTTTTBXHHCRJNW')) {
    case 'S': return ['S', pick(K.LENGTHS), w];
    case 'T': { const r = val(pick(K.RADII)); return ['T', r, pick(K.ANGLES) * sign(), pick(K.BANKS), R() < 0.2 ? 1 : 0, Math.min(w, 2 * (r - 8))]; }
    case 'B': return ['B', pick(K.STRIPS), w];
    case 'X': return ['X', pick(K.STRIPS), w];
    case 'H': { const run = pick(K.RUNS), ok = K.RISES.filter((r) => r / run <= 0.36); return ['H', pick(ok) * sign(), run, w]; }
    case 'C': return ['C', val(pick(K.CRESTS)), w];
    case 'R': return ['R', pick(K.ROLLERS), val(pick(K.ROLLER_H)), w];
    case 'J': return ['J', val(pick(K.JUMPS)), w];
    case 'N': return ['N', pick([20, 30, 40, 60]), pick(K.NARROW)];
    default: return ['W', pick([20, 30, 40, 60]), pick(K.WIDE)];
  }
}
// the shorter, older form
function oldPiece() {
  switch (pick('STBHCRJ')) {
    case 'S': return ['S', 10 * (1 + Math.floor(R() * 20))];
    case 'T': return ['T', pick([24, 40, 60, 90]), pick([30, 45, 60, 90, 120, 150, 180]) * sign(), pick([0, 10, 25, 40]), R() < 0.2 ? 1 : 0];
    case 'B': return ['B', pick([20, 30, 40])];
    case 'H': return ['H', pick([3, 6, 10]) * sign()];
    case 'C': return ['C'];
    case 'R': return ['R', pick([2, 3, 4])];
    default: return ['J', pick([1, 2, 3, 4])];
  }
}
const out = [];
while (out.length < 80) {
  const old = out.length % 4 === 3;
  const pieces = Array.from({ length: 1 + Math.floor(R() * 12) }, old ? oldPiece : piece);
  const t = { w: old ? pick([13, 14, 15, 16, 17, 18]) : val(pieces[0][pieces[0].length - 1]), pieces };
  if (!old && (t.w < 6 || t.w > 30)) t.w = 15;
  const c = K.check(t), g = K.walk(t);
  let gate = null;
  try { gate = m.validateCourse(K.build(t)).gates.find((x) => x.kind === 'finish').pos; } catch (e) { /* the S-bend rule */ }
  out.push({ w: t.w, pieces: t.pieces, ok: c.ok, error: c.error || '', walk: g, gate, old });
}
process.stdout.write(JSON.stringify(out));
