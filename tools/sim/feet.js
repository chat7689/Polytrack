// The earth banks' feet (where the green slope under a raised road meets
// the grass): how tightly each foot line curls and whether it folds back on
// itself, for a set of tracks. Usage: node feet.js
const h = require('./harness.js'); const m = h.load(); const K = m.TrackKit;
function measure(data) {
  let minR = Infinity, folds = 0;
  for (const st of data.strips) for (const side of [1, -1]) {
    const { foot } = m.embankment(st.frames, side);
    for (let i = 1; i < foot.length - 1; i++) {
      const a = foot[i - 1], b = foot[i], c = foot[i + 1];
      const ab = Math.hypot(b.x - a.x, b.z - a.z), bc = Math.hypot(c.x - b.x, c.z - b.z), ac = Math.hypot(c.x - a.x, c.z - a.z);
      const cross = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
      if (ab > 0.05 && bc > 0.05 && cross > 1e-6) minR = Math.min(minR, ab * bc * ac / (2 * cross));
      // the foot running backwards against the road: a fold
      const e0 = st.frames[i - 1].p, e1 = st.frames[i + 1].p;
      if ((c.x - a.x) * (e1[0] - e0[0]) + (c.z - a.z) * (e1[2] - e0[2]) < 0) folds++;
    }
  }
  return { minR, folds };
}
const tracks = {
  'raised hairpin': [['S', 40, 15], ['H', 10, 40, 15], ['S', 30, 15], ['T', 24, 180, 10, 0, 15], ['S', 40, 15], ['H', -10, 40, 15], ['S', 60, 15]],
  'high tight turn': [['S', 40, 15], ['H', 20, 60, 15], ['S', 20, 15], ['T', 40, 90, 25, 0, 15], ['S', 40, 15], ['H', -20, 60, 15], ['S', 60, 15]],
  'downhill start, turn': [['H', -20, 60, 15], ['T', 30, -120, 15, 0, 15], ['S', 80, 15]],
  'wide high sweeper': [['S', 40, 15], ['H', 15, 60, 15], ['T', 90, 90, 25, 0, 15], ['S', 40, 15]],
  'banked wall': [['S', 60, 15], ['T', 60, 180, 60, 0, 15], ['S', 80, 15]]
};
for (const [name, pieces] of Object.entries(tracks)) {
  const c = K.check({ w: 15, pieces });
  if (!c.ok) { console.log(name, 'refused', c.error); continue; }
  const r = measure(c.data);
  console.log(name.padEnd(22), 'tightest foot curl ' + r.minR.toFixed(1) + ' m', 'folds ' + r.folds);
}
console.log('season maps:');
for (const lv of m.LEVELS) { const r = measure(m.validateCourse(lv.build())); if (r.minR < 6 || r.folds) console.log('  ' + lv.id, lv.name, 'tightest ' + r.minR.toFixed(1) + ' m, folds ' + r.folds); }
