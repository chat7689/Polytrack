// Checkpoints every ~40 m along the road: how close does a real (finished)
// run come to each? Prints the worst margin beyond the road's half width.
const h = require('./harness.js');
const THREE = h.THREE;
const m = h.load();
const HZ = 20, H = 1 / 360;
function checkpoints(data, every, finish) {
  const frames = [];
  for (const st of data.strips) for (const f of st.frames) frames.push(f);
  // the road ends at the finish gate (the run-out after it never counts)
  let fi = frames.length - 1, fd = Infinity;
  frames.forEach((f, k) => { const d = Math.hypot(f.p[0] - finish[0], f.p[2] - finish[2]); if (d < fd) { fd = d; fi = k; } });
  const cps = [];
  let acc = 0, last = null;
  for (let k = 0; k < fi; k++) {
    const f = frames[k], p = [f.p[0], f.p[2]];
    if (last) acc += Math.hypot(p[0] - last[0], p[1] - last[1]);
    last = p;
    if (!cps.length || acc >= every) { cps.push([p[0], p[1], f.w / 2]); acc = 0; }
  }
  return cps;
}
module.exports = { checkpoints };
if (require.main !== module) return;
const calibSrc = require('fs').readFileSync(__dirname + '/calib.js', 'utf8');
// reuse calib's drive by evaluating it up to the measure function
const driveSrc = calibSrc.slice(calibSrc.indexOf('function rules('), calibSrc.indexOf('function measure('));
const fn = new Function('m', 'h', 'THREE', 'HZ', 'H', driveSrc + '; return { rules, drive };');
const { rules, drive } = fn(m, h, THREE, HZ, H);
let worst = 0, worstAt = '';
for (let i = 0; i < m.LEVELS.length; i++) {
  const R = rules(i);
  const cps = checkpoints(R.data, 40, R.finish);
  for (const o of [{ aggr: 0.7 }, { aggr: 1 }, { aggr: 1.4 }, { aggr: 1, boost: 1 }, { aggr: 1.6, boost: 1 }]) {
    const r = drive(R, o);
    if (!r.finished) continue;
    let from = 0, mapWorst = 0;
    for (const c of cps) {
      let bd = Infinity, bi = from;
      for (let k = from; k < r.rec.length; k++) { const d = Math.hypot(r.rec[k][0] - c[0], r.rec[k][2] - c[1]) - c[2]; if (d < bd) { bd = d; bi = k; } }
      from = bi;
      if (bd > mapWorst) { mapWorst = bd; R.wk = cps.indexOf(c); }
    }
    if (mapWorst > worst) { worst = mapWorst; worstAt = R.id + ' ' + JSON.stringify(o); }
    console.log(R.id, cps.length, JSON.stringify(o), mapWorst.toFixed(1), 'at cp', R.wk);
  }
}
console.log('WORST', worst.toFixed(1), worstAt);
