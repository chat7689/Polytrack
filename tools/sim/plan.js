// where a map's road goes: every ~20 m (cum, x, z, y, heading) and where it crosses itself
const h = require('./harness.js'); const m = h.load();
const id = process.argv[2];
const lv = m.NEXT_LEVELS.find((l) => l.id === id);
const data = m.validateCourse(lv.build());
const P = []; let cum = 0, prev = null;
data.strips.forEach((st) => st.frames.forEach((f) => { if (prev) cum += Math.hypot(f.p[0] - prev[0], f.p[1] - prev[1], f.p[2] - prev[2]); prev = f.p; P.push({ cum, x: f.p[0], y: f.p[1], z: f.p[2], yaw: f.y * 180 / Math.PI, w: f.w }); }));
let last = -99;
for (const p of P) if (p.cum - last >= 20) { last = p.cum; console.log(Math.round(p.cum).toString().padStart(5), 'x', p.x.toFixed(0).padStart(5), 'z', p.z.toFixed(0).padStart(5), 'y', p.y.toFixed(1).padStart(5), 'hdg', p.yaw.toFixed(0)); }
console.log('crossings:');
for (let i = 0; i < P.length - 1; i++) for (let j = i + 1; j < P.length - 1; j++) {
  if (P[j].cum - P[i].cum < 40) continue;
  const a = P[i], b = P[i + 1], c = P[j], d = P[j + 1];
  const den = (b.x - a.x) * (d.z - c.z) - (b.z - a.z) * (d.x - c.x);
  if (Math.abs(den) < 1e-9) continue;
  const t = ((c.x - a.x) * (d.z - c.z) - (c.z - a.z) * (d.x - c.x)) / den, u = ((c.x - a.x) * (b.z - a.z) - (c.z - a.z) * (b.x - a.x)) / den;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) console.log('  at', Math.round(a.cum), 'm (y', a.y.toFixed(1) + ') and', Math.round(c.cum), 'm (y', c.y.toFixed(1) + ') x', (a.x + t * (b.x - a.x)).toFixed(0), 'z', (a.z + t * (b.z - a.z)).toFixed(0));
}
