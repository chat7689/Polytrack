const h = require('./harness.js'); const m = h.load(); const B = require('./bot.js');
let f = 0, n = 0;
for (const lv of (process.env.NEXT ? m.NEXT_LEVELS : m.LEVELS)) {
  const data = m.validateCourse(lv.build()); const row = [];
  for (const o of [{ aggr: 1.15, lane: 0.8 }, { aggr: 1.15, lane: -0.8 }, { aggr: 1.2, lane: 0.85, laneWave: 1 }]) {
    const r = B.run(m, data, o); n++; if (!r.finished) f++;
    row.push(r.finished ? r.time.toFixed(1) : 'FAIL ' + r.fail + ' ' + r.failAt);
  }
  console.log(lv.id, row.join(' | '));
}
console.log('fails', f, 'of', n);
