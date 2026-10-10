// Checks next season's maps: layout (roads touching, earth banks spilling
// onto another road, crossings without clearance), then the test driver at
// several levels: finish, time, checkpoints, and how it drives.
// Usage: node check_next.js [id ...] [quick]
const h = require('./harness.js');
const m = h.load();
const B = require('./bot.js');
const want = process.argv.slice(2).filter((a) => /^s3c\d+$/.test(a));
const quick = process.argv.includes('quick');
const levels = (m.NEXT_LEVELS || []).filter((lv) => !want.length || want.includes(lv.id));
const GY = m.GROUND_Y;

function layout(data) {
  const P = [];
  let cum = 0, prev = null;
  data.strips.forEach((st) => st.frames.forEach((f, i) => {
    const seg = st.segs[Math.min(i, st.segs.length - 1)] || {};
    if (prev) cum += Math.hypot(f.p[0] - prev[0], f.p[1] - prev[1], f.p[2] - prev[2]);
    prev = f.p;
    const hw = f.w / 2, h = Math.max(f.p[1] + hw * Math.abs(Math.sin(f.r)) - GY, 0);
    P.push({ x: f.p[0], y: f.p[1], z: f.p[2], hw, cum, yaw: f.y, noBank: !!seg.noBank, loop: Math.abs(f.t) > 0.6, reach: seg.noBank ? hw : hw + Math.max(h * 2, 2.2) + 1 });
  }));
  const issues = {};
  const add = (k, a, b, d) => { const key = k + '@' + Math.round(a.cum / 20) * 20 + '/' + Math.round(b.cum / 20) * 20; if (!issues[key]) issues[key] = k + ' at ' + Math.round(a.cum) + ' m & ' + Math.round(b.cum) + ' m (' + d + ')'; };
  let minGap = Infinity;
  for (let i = 0; i < P.length; i += 1) for (let j = i + 1; j < P.length; j += 1) {
    const a = P[i], b = P[j];
    if (b.cum - a.cum < 50) continue;
    const dxz = Math.hypot(a.x - b.x, a.z - b.z), dy = b.y - a.y;
    if (a.loop || b.loop) { if (a.loop && b.loop) continue; }
    if (dxz < a.hw + b.hw + 3) {
      if (Math.abs(dy) < 6.5) add('TOUCH', a, b, 'dxz ' + dxz.toFixed(1) + ' dy ' + dy.toFixed(1));
      else { const up = dy > 0 ? b : a; if (!up.noBank && !up.loop) add('CROSS-NOT-BRIDGE', a, b, 'dy ' + dy.toFixed(1)); }
    } else if (Math.abs(dy) < 6.5) minGap = Math.min(minGap, dxz - a.hw - b.hw);
    // a road buried under the other road's earth bank (the bank runs sideways
    // from the deck edge down to the grass at about 1 in 2)
    for (const [A, Bp] of [[a, b], [b, a]]) {
      if (A.noBank || A.loop || Bp.loop) continue;
      const fx = Math.sin(A.yaw), fz = Math.cos(A.yaw), rx = Bp.x - A.x, rz = Bp.z - A.z;
      const along = rx * fx + rz * fz, lat = Math.abs(rx * fz - rz * fx);
      if (Math.abs(along) > 2.5 || lat < A.hw || lat - Bp.hw > A.reach) continue;
      const surf = A.y - Math.max(0, lat - Bp.hw - A.hw) * 0.5;
      if (Bp.y < surf - 0.3) add('BURIED', A, Bp, 'bank ' + surf.toFixed(1) + ' road ' + Bp.y.toFixed(1) + ' lat ' + lat.toFixed(0));
    }
  }
  // every jump: the landing must start below the lip it is jumped from
  for (let si = 1; si < data.strips.length; si++) {
    const lip = data.strips[si - 1].frames[data.strips[si - 1].frames.length - 1], land = data.strips[si].frames[0];
    const drop = lip.p[1] - land.p[1];
    if (drop < 0.4) issues['LAND' + si] = 'LANDING-HIGH jump ' + si + ': lip y ' + lip.p[1].toFixed(2) + ', landing y ' + land.p[1].toFixed(2);
  }
  return { issues: Object.values(issues), minGap, len: P[P.length - 1].cum, maxY: Math.max(...P.map((p) => p.y)) };
}

for (const lv of levels) {
  let data;
  try { data = m.validateCourse(lv.build()); } catch (e) { console.log(lv.id, lv.name, 'BUILD ERROR', e.message); continue; }
  if (!data.valid) { console.log(lv.id, lv.name, 'INVALID'); continue; }
  const L = layout(data);
  console.log('\n' + lv.id + ' ' + lv.name + '  len ' + Math.round(L.len) + ' m, top ' + L.maxY.toFixed(0) + ' m, closest side road ' + (isFinite(L.minGap) ? L.minGap.toFixed(1) + ' m' : '-'));
  for (const s of L.issues.slice(0, 8)) console.log('   ! ' + s);
  if (L.issues.length > 8) console.log('   ! ... ' + (L.issues.length - 8) + ' more');
  const configs = quick ? [{ aggr: 1.3, boost: 1 }] : [{ aggr: 0.8 }, { aggr: 1 }, { aggr: 1.3, boost: 1 }, { aggr: 1.3, boost: 1, handbrake: 1 }];
  for (const o of configs) {
    const r = B.run(m, data, o);
    const tag = (o.aggr + (o.boost ? 'b' : '') + (o.handbrake ? 'h' : '')).padEnd(6);
    if (!r.finished) { console.log('   ' + tag + ' FAIL ' + r.fail + ' at ' + Math.round((r.progress || 0) * 100) + '% (' + Math.round(r.progress * L.len) + ' m)'); continue; }
    console.log('   ' + tag + ' ' + r.time.toFixed(1) + ' s' + (r.cpOk ? '' : ' CPFAIL ' + r.cpNext + '/' + r.cps) + (r.cpSingles ? ' miss' + r.cpSingles : '') +
      ' | roll ' + r.maxRollRate.toFixed(1) + ' up ' + r.wheelsUp.toFixed(2) + ' scrape ' + r.scrape.toFixed(2) + ' g ' + r.maxCompG.toFixed(1) +
      ' spin ' + r.spins + ' grass ' + r.grass.toFixed(1) + ' air ' + r.air.toFixed(1) + (r.minLoopV < 99 ? ' loopV ' + r.minLoopV.toFixed(0) : '') +
      ' brake ' + r.brakeTime.toFixed(1) + (r.hbTime ? ' hb ' + r.hbTime.toFixed(1) : '') + ' drift ' + r.driftTime.toFixed(1) + ' top ' + r.top.toFixed(0));
  }
}
