const h = require('./harness.js'); const m = h.load(); const B = require('./bot.js');
const src = process.env.LIVE ? m.LEVELS : m.NEXT_LEVELS;
for (const lv of src) {
  const F = B.frameList(m.validateCourse(lv.build()));
  const hits = [];
  for (let i = 0; i < F.length; i++) for (let j = i + 1; j < F.length; j++) {
    if (F[j].cum - F[i].cum < 40) continue;
    const d = Math.hypot(F[i].p.x - F[j].p.x, F[i].p.z - F[j].p.z);
    if (d < (F[i].w + F[j].w) / 2 + 1) hits.push(Math.round(F[i].cum) + '/' + Math.round(F[j].cum) + ' dy' + (F[j].p.y - F[i].p.y).toFixed(0));
  }
  console.log(lv.id, lv.name, hits.length ? hits.filter((_, k) => k % 6 === 0).slice(0, 6).join(' ') + ' (' + hits.length + ')' : 'no crossings');
}
