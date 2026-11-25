// The test driver's own lines, for the server: forty points along each of
// its recordings (tools/db/recs.json, made by `node tools/sim/recs.js`), as
// SQL for supabase/schema.sql. A time whose recording follows one of these
// lines to within 25 cm was driven by the game's own test driver, not by a
// player (schema.sql: _ghost_like), and is refused.
//   node tools/sim/bot_lines.js > tools/sim/bot_lines.sql
const fs = require('fs');
const path = require('path');
const recs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'db', 'recs.json'), 'utf8'));
const by = {};
for (const r of recs) {
  const a = r.samples.split(',').map(Number), n = a.length / 8;
  if (n < 40) continue;
  const pts = [];
  for (let j = 0; j < 40; j++) {
    const f = j * (n - 1) / 39, i = Math.min(Math.floor(f), n - 2), u = f - i, k = i * 8;
    pts.push((a[k] + (a[k + 8] - a[k]) * u).toFixed(2), (a[k + 2] + (a[k + 10] - a[k + 2]) * u).toFixed(2));
  }
  (by[r.id] = by[r.id] || []).push(pts.join(','));
}
const out = ['-- the test driver\'s lines (node tools/sim/bot_lines.js), 40 points (x, z) a recording'];
for (const id of Object.keys(by).sort()) {
  out.push("update public.course_rules set bots = '{" + by[id].join(',') + "}' where course_id = '" + id + "';");
}
console.log(out.join('\n'));
