// Runs the test driver on some maps with parts of the physics switched back,
// to see which change moves a time.  VARIANT=belly|sides|girder|caps|below
//   node variant.js s4m1,s4m12
const h = require('./harness.js'); const m = h.load(); const B = require('./bot.js');
const ids = (process.argv[2] || '').split(',');
for (const lv of m.LEVELS.concat(m.NEXT_LEVELS).filter((l) => ids.includes(l.id))) {
  const r = B.run(m, m.validateCourse(lv.build()), { aggr: 1.3, boost: 1 });
  console.log(process.env.VARIANT || 'all', lv.id, r.finished ? r.time.toFixed(1) : 'FAIL ' + r.fail);
}
