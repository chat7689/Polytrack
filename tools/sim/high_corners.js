const h = require('./harness.js'); const m = h.load(); const B = require('./bot.js');
for (const lv of m.NEXT_LEVELS) {
  const data = m.validateCourse(lv.build()); const F = B.frameList(data);
  const out = [];
  for (let i = 2; i < F.length - 2; i++) {
    let dy = F[i + 1].yaw - F[i - 1].yaw; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
    const ds = F[i + 1].cum - F[i - 1].cum, R = Math.abs(ds / (dy || 1e-9));
    if (R < 35 && F[i].p.y > (process.env.Y || 3)) out.push(Math.round(F[i].cum) + 'm R' + R.toFixed(0) + ' y' + F[i].p.y.toFixed(1));
  }
  console.log(lv.id, lv.name, out.length ? out.filter((_, k) => k % 3 === 0).join(' | ') : 'ok');
}
