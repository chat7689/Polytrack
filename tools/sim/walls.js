const h = require('./harness.js'); const m = h.load(); const B = require('./bot.js');
if (process.env.RF !== undefined) m.CAR.rollFollow = +process.env.RF;
if (process.env.NOGR) m.Vehicle.prototype._groundRoll = function () { this.groundRoll = 0; this.rollErr = 0; };
const ids = process.argv.slice(2);
const src = ids.length ? m.NEXT_LEVELS.filter((l) => ids.includes(l.id)) : m.NEXT_LEVELS;
for (const lv of src) {
  const data = m.validateCourse(lv.build());
  if (!data.strips.some((s) => s.frames.some((f) => Math.abs(f.r) > 0.6))) continue;
  const rows = [];
  for (const o of [{ aggr: 1.3, boost: 1 }, { aggr: 1, lane: 0.6 }, { aggr: 1, lane: -0.6 }, { aggr: 1, lane: 0.7, laneWave: 1 }, { aggr: 1, vbank: 28 }, { aggr: 1, vbank: 20, lane: -0.5 }, { aggr: 1, vbank: 20, lane: 0.5 }]) {
    const r = B.run(m, data, o);
    rows.push(JSON.stringify(o).replace(/[{}"]/g, '').padEnd(28) + (r.finished ? r.time.toFixed(1) : 'FAIL ' + r.fail + ' ' + r.failAt) + ' pops ' + r.pops + ' popV ' + r.popV.toFixed(1) + ' @' + r.popAt + ' scrape ' + r.scrape.toFixed(2) + ' up ' + r.wheelsUp.toFixed(2) + (r.scrape > 0.2 ? ' scrapeAt ' + r.scrapeAt : ''));
  }
  console.log(lv.id, lv.name); rows.forEach((x) => console.log('  ' + x));
}
