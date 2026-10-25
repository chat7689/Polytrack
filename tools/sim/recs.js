// Recordings of test-driver runs on every live map, in the game's upload
// format, as JSON for tools/db/ghost.test.mjs (does the server's recording
// check pass real drives?). Usage: node recs.js > ../db/recs.json
const h = require('./harness.js'); const m = h.load(); const B = require('./bot.js');
const drivers = [{ aggr: 1.3, boost: 1 }, { aggr: 1 }, { aggr: 0.85, lane: -0.1 }];
const out = [];
for (const lv of m.LEVELS) {
  const data = m.validateCourse(lv.build());
  for (const o of drivers) {
    const r = B.run(m, data, Object.assign({ full: true }, o));
    if (!r.finished) { out.push({ id: lv.id, dnf: true }); continue; }
    const rec = r.rec.map((x, j, all) => x.length === 8 ? x : x.slice(0, 3).concat((all[j + 1] && all[j + 1].length === 8 ? all[j + 1] : all[j - 1]).slice(3, 7), [x[3]]));
    const s = rec.map((x) => x.map((v, j) => j < 3 ? +v.toFixed(2) : j < 7 ? +v.toFixed(4) : v | 0).join(',')).join(',');
    out.push({ id: lv.id, ms: Math.round(r.time * 1000), samples: s });
  }
}
process.stdout.write(JSON.stringify(out));
