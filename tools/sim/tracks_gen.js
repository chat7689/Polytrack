// Random player tracks, as JSON for tools/db/tracks.test.mjs: each with the
// game's own finish (TrackBuilder's gate), TrackKit.walk()'s reckoning and
// whether TrackKit.check() takes it. Usage: node tracks_gen.js > ../db/tracks.json
const h = require('./harness.js'); const m = h.load(); const K = m.TrackKit;
let seed = 7;
const R = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const pick = (a) => a[Math.floor(R() * a.length)];
const val = (e) => (Array.isArray(e) ? e[0] : e);
function piece() {
  switch (pick('SSSTTTBHHCRJ')) {
    case 'S': return ['S', 10 * (1 + Math.floor(R() * 20))];
    case 'T': return ['T', val(pick(K.RADII)), pick(K.ANGLES) * (R() < 0.5 ? -1 : 1), val(pick(K.BANKS)), R() < 0.2 ? 1 : 0];
    case 'B': return ['B', pick(K.STRIPS)];
    case 'H': return ['H', val(pick(K.RISES)) * (R() < 0.5 ? -1 : 1)];
    case 'C': return ['C'];
    case 'R': return ['R', pick(K.ROLLERS)];
    default: return ['J', val(pick(K.JUMPS))];
  }
}
const out = [];
while (out.length < 60) {
  const t = { w: pick(K.WIDTHS), pieces: Array.from({ length: 1 + Math.floor(R() * 12) }, piece) };
  const c = K.check(t), g = K.walk(t);
  let gate = null;
  try { gate = m.validateCourse(K.build(t)).gates.find((x) => x.kind === 'finish').pos; } catch (e) { /* the S-bend rule */ }
  out.push({ w: t.w, pieces: t.pieces, ok: c.ok, error: c.error || '', walk: g, gate });
}
process.stdout.write(JSON.stringify(out));
