const h = require('./harness.js'); const m = h.load();
const id = process.argv[2], a = +process.argv[3], b = +process.argv[4];
const lv = m.NEXT_LEVELS.find((l) => l.id === id); const data = m.validateCourse(lv.build());
let cum = 0, prev = null;
for (const s of data.strips) for (const f of s.frames) {
  if (prev) cum += Math.hypot(f.p[0] - prev[0], f.p[2] - prev[2], f.p[1] - prev[1]);
  prev = f.p;
  if (cum >= a && cum <= b) console.log(cum.toFixed(1), 'y', f.p[1].toFixed(2), 'pitch', f.t.toFixed(3), 'yaw', f.y.toFixed(3), 'roll', f.r.toFixed(3), 'w', f.w, s.bridge ? 'bridge' : '', s.grip || '');
}
