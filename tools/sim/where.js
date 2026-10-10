const h = require('./harness.js'); const m = h.load(); const B = require('./bot.js');
const lv = m.NEXT_LEVELS.find((l) => l.id === process.argv[2]); const data = m.validateCourse(lv.build());
const F = B.frameList(data); const THREE = h.THREE || global.THREE;
const pts = process.argv.slice(3).map((s) => s.split(',').map(Number));
for (const [x, y, z] of pts) {
  let best = 0, bd = 1e9;
  F.forEach((f, i) => { const d = (f.p.x - x) ** 2 + (f.p.y - y) ** 2 + (f.p.z - z) ** 2; if (d < bd) { bd = d; best = i; } });
  const f = F[best]; const d = { x: x - f.p.x, y: y - f.p.y, z: z - f.p.z };
  const dot = (v) => d.x * v.x + d.y * v.y + d.z * v.z;
  console.log([x, y, z].join(','), 'cum', f.cum.toFixed(1), 'lat', (dot(f.x) / (f.w / 2)).toFixed(2), 'n', dot(f.up).toFixed(2), 'along', dot(f.fwd).toFixed(2), 'r', f.r.toFixed(2), 'up', [f.up.x, f.up.y, f.up.z].map((v) => v.toFixed(2)).join(','));
}
