// Fake drivers with real test-driver runs on every live map, as SQL for the local fakebase.
const h = require('./harness.js'); const m = h.load(); const B = require('./bot.js');
const fs = require('fs');
const D = [
  ['Jake', { aggr: 1.3, boost: 1 }, [10, 80, 55]], ['Mia', { aggr: 1.3, boost: 1, lane: 0.04 }, [200, 75, 55]],
  ['Leo', { aggr: 1.25, boost: 1 }, [120, 70, 50]], ['Ava', { aggr: 1.2, boost: 1, lane: -0.05 }, [300, 70, 60]],
  ['Noah', { aggr: 1.15 }, [40, 85, 55]], ['Zoe', { aggr: 1.05, lane: 0.08 }, [260, 65, 55]],
  ['Eli', { aggr: 0.95 }, [160, 60, 45]], ['Ivy', { aggr: 0.85, lane: -0.1 }, [330, 75, 65]]
];
const id = (k) => '00000000-0000-4000-8000-' + String(1000 + k).padStart(12, '0');
let sql = '';
D.forEach(([n, , c], k) => {
  sql += `insert into auth.users (id, email) values ('${id(k)}', '${n.toLowerCase()}@chat7689.github.io') on conflict do nothing;\n`;
  sql += `insert into public.profiles (id, display_name) values ('${id(k)}', '${n}') on conflict do nothing;\n`;
  sql += `insert into public.car_customization (uid, unlocked, primary_color, secondary_color) values ('${id(k)}', '[${c[0]}]', '{"h":${c[0]},"s":${c[1]},"l":${c[2]}}', '{"h":${c[0]},"s":${c[1] - 20},"l":${c[2] - 18}}') on conflict do nothing;\n`;
});
const now = Date.now();
m.LEVELS.forEach((lv, li) => {
  const data = m.validateCourse(lv.build());
  D.forEach(([n, o], k) => {
    const r = B.run(m, data, Object.assign({ full: true }, o));
    if (!r.finished) { console.log(lv.id, n, 'dnf'); return; }
    const ms = Math.round(r.time * 1000);
    const rec = r.rec.map((x, j, all) => x.length === 8 ? x : x.slice(0, 3).concat((all[j + 1] && all[j + 1].length === 8 ? all[j + 1] : all[j - 1]).slice(3, 7), [x[3]]));
    const s = rec.map((x) => x.map((v, j) => j < 3 ? +v.toFixed(2) : j < 7 ? +v.toFixed(4) : v | 0).join(',')).join(',');
    // recent records: map leaders set in the last few hours, others days ago
    const when = now - (k === 0 ? (li * 37 + 5) : (li + k) * 3600) * 60000;
    sql += `insert into public.bests (uid, course_id, display_name, time_ms, updated_ms) values ('${id(k)}', '${lv.id}', '${n}', ${ms}, ${when}) on conflict (uid, course_id) do update set time_ms = excluded.time_ms, updated_ms = excluded.updated_ms;\n`;
    sql += `insert into public.ghosts (uid, course_id, time_ms, samples, v) values ('${id(k)}', '${lv.id}', ${ms}, '${s}', 2) on conflict (uid, course_id) do update set time_ms = excluded.time_ms, samples = excluded.samples;\n`;
    console.log(lv.id, n, r.time.toFixed(3));
  });
});
fs.writeFileSync('../supa/seed.sql', sql);
