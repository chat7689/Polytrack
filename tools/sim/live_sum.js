const h = require('./harness.js'); const m = h.load(); const B = require('./bot.js');
let sum = 0, bad = 0;
for (const lv of m.LEVELS) {
  const data = m.validateCourse(lv.build());
  const r = B.run(m, data, { aggr: 1.3, boost: 1 });
  if (!r.finished) bad++;
  sum += r.finished ? r.time : 0;
  console.log(lv.id, r.finished ? r.time.toFixed(1) : 'FAIL ' + r.fail);
}
console.log('sum', sum.toFixed(1), 'fails', bad);
