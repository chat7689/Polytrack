const h = require('./harness.js'); const m = h.load(); const B = require('./bot.js');
const id = process.argv[2]; const opts = JSON.parse(process.argv[3]); const [a, b] = [+process.argv[4], +process.argv[5]];
const lv = m.NEXT_LEVELS.find((l) => l.id === id); const data = m.validateCourse(lv.build());
const trace = []; opts.trace = trace; const r = B.run(m, data, opts);
for (const row of trace) if (row[1] >= a && row[1] <= b) console.log(row.join(' '));
console.log('finished', r.finished, r.fail);
