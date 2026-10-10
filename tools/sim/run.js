const h = require('./harness.js'); const m = h.load(); const B = require('./bot.js');
if (process.env.HF) m.CAR.hullFriction = +process.env.HF;
const lv = m.LEVELS.concat(m.NEXT_LEVELS).find((l) => l.id === process.argv[2]);
for (const o of JSON.parse(process.argv[3])) { const r = B.run(m, m.validateCourse(lv.build()), o); console.log(JSON.stringify(o), r.finished ? r.time.toFixed(1) : 'FAIL ' + r.fail + ' ' + r.failAt); }
