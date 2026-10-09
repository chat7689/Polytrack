const h = require('./harness.js'); const m = h.load(); const B = require('./bot.js');
const [id, from, to] = [process.argv[2], +process.argv[3] || 0, +process.argv[4] || 1e9];
const lv = m.NEXT_LEVELS.find((l) => l.id === id); const data = m.validateCourse(lv.build());
const trace = []; const r = B.run(m, data, { aggr: 1.3, boost: 1, trace });
for (const row of trace) if (row[1] >= from && row[1] <= to) console.log(row.join(' '));
console.log('finished', r.finished, r.fail, r.time.toFixed(1));
