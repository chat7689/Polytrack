// Course rules for the server, from the better test driver:
//   floor = 0.70 x the driver's best time (a lap at 1.4x its average speed
//   is out of any car's reach), ref = its best (times under 0.9 x ref are
//   flagged for a look). Where the driver can't finish: length / 50 m/s.
// Usage: node gen_rules2.js [seasonOnly]
const fs = require('fs');
const h = require('./harness.js');
const THREE = h.THREE;
const m = h.load();
const B = require('./bot.js');
const { checkpoints } = require('./cp_calib.js');
const r1 = (v) => Math.round(v * 10) / 10;
const arr = (cps) => "'{" + cps.map((c) => c.map(r1).join(',')).join(',') + "}'";

function geo(data) {
  const course = m.buildCourse(data, new THREE.Scene(), new m.PhysicsWorld());
  const gate = course.gates.find((g) => g.kind === 'finish');
  const finish = [gate.pos.x, gate.pos.y, gate.pos.z];
  return { start: data.start.pos, finish, gateR: Math.max(gate.radius || 0, (gate.width || 12) / 2 + 1.6), len: course.length, cps: checkpoints(data, 40, finish) };
}
function best(data, configs) {
  let b = null;
  for (const o of configs) { const r = B.run(m, data, o); if (r.finished && (b === null || r.time < b)) b = r.time; }
  return b;
}
const rows = [], report = [];
for (const lv of m.LEVELS) {
  const data = m.validateCourse(lv.build());
  const g = geo(data);
  const b = best(data, [{ aggr: 1 }, { aggr: 1.3, boost: 1 }, { aggr: 1.6, boost: 1 }, { aggr: 1.3, boost: 1, handbrake: 1 }]);
  const floor = b ? 0.7 * b : g.len / 50;
  report.push(lv.id + ' ' + lv.name + ' best ' + (b ? b.toFixed(2) : '-') + ' floor ' + floor.toFixed(2));
  rows.push(`('${lv.id}', ${r1(g.start[0])}, ${r1(g.start[1])}, ${r1(g.start[2])}, ${r1(g.finish[0])}, ${r1(g.finish[1])}, ${r1(g.finish[2])}, ${r1(g.gateR)}, ${Math.round(floor * 1000)}, ${b ? Math.round(b * 1000) : 'null'}, ${Math.round(g.len)}, ${arr(g.cps)})`);
}
console.log(report.join('\n'));
const days = [];
if (!process.argv.includes('seasonOnly')) {
  const d0 = new Date(Date.UTC(2026, 9, 1)), d1 = new Date(Date.UTC(2027, 11, 31));
  let slowest = 99, fails = 0;
  for (let d = new Date(d0); d <= d1; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10).replace(/-/g, '');
    const data = m.validateCourse(m.DailyGen.level(key).build());
    const g = geo(data);
    const b = best(data, [{ aggr: 1.3, boost: 1 }]);
    if (!b) fails++;
    const floor = b ? 0.7 * b : g.len / 50;
    slowest = Math.min(slowest, g.len / floor);
    days.push(`('d${key}', ${r1(g.start[0])}, ${r1(g.start[1])}, ${r1(g.start[2])}, ${r1(g.finish[0])}, ${r1(g.finish[1])}, ${r1(g.finish[2])}, ${r1(g.gateR)}, ${Math.round(floor * 1000)}, ${b ? Math.round(b * 1000) : 'null'}, ${Math.round(g.len)}, ${arr(g.cps)})`);
  }
  console.log('days', days.length, 'driver failed on', fails);
}
const sql = 'insert into public.course_rules (course_id, sx, sy, sz, fx, fy, fz, gate_r, floor_ms, ref_ms, len_m, cps) values\n' +
  rows.concat(days).join(',\n') + '\non conflict (course_id) do update set sx = excluded.sx, sy = excluded.sy, sz = excluded.sz, fx = excluded.fx, fy = excluded.fy, fz = excluded.fz,\n' +
  '  gate_r = excluded.gate_r, floor_ms = excluded.floor_ms, ref_ms = excluded.ref_ms, len_m = excluded.len_m, cps = excluded.cps;\n';
fs.writeFileSync(__dirname + '/rules2.sql', sql);
console.log('bytes', sql.length);
