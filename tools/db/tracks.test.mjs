// Player tracks: the server's road (_track_geo) against the game's, saving
// (3 a player, names, public/private), boards reset when the road changes,
// no credits, and who may drive what. Make tracks.json first:
//   cd ../sim && node tracks_gen.js > ../db/tracks.json
import { readFileSync } from 'fs';
import { makeDb, ok, done } from './db.mjs';
const t = await makeDb();
const list = JSON.parse(readFileSync(new URL('./tracks.json', import.meta.url), 'utf8'));
let built = 0, worst = 0;
for (const k of list) {
  const g = (await t.owner('select public._track_geo($1, $2::jsonb) as g', [k.w, JSON.stringify(k.pieces)])).rows[0].g;
  const lo = k.walk.lo < -0.75, hi = k.walk.hi > 80 || k.walk.len > 3000;
  if (lo || hi) { ok(!g.ok, 'the server refuses what the game refuses (' + k.error + '): ' + JSON.stringify(g)); continue; }
  if (!g.ok) { ok(false, 'the server refused a track the game accepts: ' + g.error + ' ' + JSON.stringify(k.pieces)); continue; }
  const d = Math.hypot(g.fx - k.walk.fx, g.fz - k.walk.fz), dy = Math.abs(g.fy - k.walk.fy);
  ok(d < 0.2 && dy < 0.2 && Math.abs(g.len - k.walk.len) < 1 && g.cps.length === k.walk.cps.length, 'server and game walk the same road (off by ' + d.toFixed(3) + ' m)');
  if (k.gate) {
    built++;
    const e = Math.hypot(g.fx - k.gate[0], g.fz - k.gate[2]);
    worst = Math.max(worst, e);
    ok(e < 0.5 && Math.abs(g.fy - k.gate[1]) < 15, 'the finish is where the game puts it (off by ' + e.toFixed(3) + ' m, ' + (g.fy - k.gate[1]).toFixed(2) + ' m in height)');
  }
}
console.log(built + ' built, worst finish ' + worst.toFixed(3) + ' m');
ok(!(await t.owner(`select public._track_geo(15, '[["S", 15]]'::jsonb) as g`)).rows[0].g.ok, 'a straight that is not a multiple of 10 m is refused');
ok(!(await t.owner(`select public._track_geo(15, '[["T", 30, 90, 0, 0]]'::jsonb) as g`)).rows[0].g.ok, 'a turn radius the builder does not make is refused');
ok(!(await t.owner(`select public._track_geo(15, '[["H", -6]]'::jsonb) as g`)).rows[0].g.ok, 'a hill down from the ground is refused');
ok(!(await t.owner(`select public._track_geo(20, '[["S", 40]]'::jsonb) as g`)).rows[0].g.ok, 'a road 20 m wide is refused');

// saving
await t.mkUser('Builder'); await t.mkUser('Other');
const save = (who, id, name, pub, pieces, w = 15) => t.one(who, 'select public.save_track($1, $2, $3, $4, $5::jsonb) as j', [id, name, pub, w, JSON.stringify(pieces)]).then((r) => r.j);
const a = await save('Builder', null, 'My First Track', true, [['S', 100], ['J', 3], ['S', 60]]);
ok(a.ok && /^u\d+$/.test(a.course), 'a track saves ' + JSON.stringify(a));
ok(!(await save('Builder', null, 'x', true, [['S', 50]])).ok, 'a name needs 3 letters');
ok(!(await save('Builder', null, '<script>', true, [['S', 50]])).ok, 'a name is letters, numbers and spaces');
const b = await save('Builder', null, 'Second', false, [['S', 50], ['T', 60, 90, 25, 0], ['S', 50]]);
const c = await save('Builder', null, 'Third', false, [['S', 50]]);
ok(b.ok && c.ok, 'three tracks');
const d4 = await save('Builder', null, 'Fourth', false, [['S', 50]]);
ok(!d4.ok && /3 tracks/.test(d4.error), 'but not four: ' + d4.error);
const rules = (await t.owner('select * from public.course_rules where course_id = $1', [a.course])).rows[0];
ok(rules && rules.floor_ms > 0 && rules.cps.length >= 6, 'the server made the track\'s rules ' + (rules && rules.floor_ms));
ok(!(await save('Other', a.id, 'Hijack', true, [['S', 10]])).ok, 'nobody changes someone else\'s track');
const mine = (await t.one('Builder', 'select public.my_tracks() as j')).j;
ok(mine.length === 3 && mine[0].name === 'My First Track', 'my_tracks lists them');
const pub = (await t.one('Other', 'select public.public_tracks() as j')).j;
ok(pub.length === 1 && pub[0].author === 'Builder', 'everyone sees the public one only, with who built it');
ok((await t.one('Other', 'select public.get_track($1) as j', [b.id])).j === null, 'a private track stays private');

// driving: tickets, no credits, a board
const dev = 'b'.repeat(32);
await t.owner("insert into public.access_codes (code, label, expires_at) values ('TESTTEST', 'tests', now() + interval '1 day')");
for (const who of ['Builder', 'Other']) await t.one(who, "select public.redeem_access('TESTTEST') as j");
const r1 = (await t.one('Other', 'select public.start_run($1, $2, $3, false) as j', [a.course, dev, 'fp'])).j;
ok(r1.ok, 'anyone can drive a public track ' + JSON.stringify(r1));
const r2 = (await t.one('Other', 'select public.start_run($1, $2, $3, false) as j', ['u' + b.id, dev, 'fp'])).j;
ok(!r2.ok, 'but not someone else\'s private one ' + JSON.stringify(r2));
const r3 = (await t.one('Builder', 'select public.start_run($1, $2, $3, false) as j', ['u' + b.id, 'c'.repeat(32), 'fp'])).j;
ok(r3.ok, 'the builder can drive their own private track');
await t.owner("update public.runs set started_at = now() - interval '30 seconds' where id = $1", [r1.run]);
const f1 = (await t.one('Other', 'select public.finish_run($1, $2, 100, false) as j', [r1.run, 20000])).j;
ok(f1.ok && !f1.credited && !f1.bonus, 'a finish on a player track pays no credits ' + JSON.stringify(f1));
await t.owner("insert into public.bests (uid, course_id, display_name, time_ms) select id, $1, display_name, 20000 from public.profiles where display_name = 'Other'", [a.course]);
ok((await t.one('Other', 'select public.public_tracks() as j')).j[0].drivers === 1, 'the list counts drivers');
// changing the road clears the board; renaming does not
await save('Builder', a.id, 'Renamed', true, [['S', 100], ['J', 3], ['S', 60]]);
ok((await t.owner('select count(*)::int n from public.bests where course_id = $1', [a.course])).rows[0].n === 1, 'a new name keeps the times');
const ch = await save('Builder', a.id, 'Renamed', true, [['S', 120], ['J', 3], ['S', 60]]);
ok(ch.reset && (await t.owner('select count(*)::int n from public.bests where course_id = $1', [a.course])).rows[0].n === 0, 'a new road clears them');
// players can't wipe boards
ok(/permission denied/.test(await t.err('Other', "select public._track_reset('s4c1', true)")), 'players cannot call the reset');
ok((await t.one('Other', 'select public.delete_track($1) as j', [a.id])).j.ok === false, 'nobody deletes someone else\'s track');
ok((await t.one('Builder', 'select public.delete_track($1) as j', [a.id])).j.ok, 'the builder deletes their own');
ok(!(await t.owner('select 1 from public.course_rules where course_id = $1', [a.course])).rows.length, 'and its rules go with it');
const e = await save('Builder', null, 'Room again', true, [['S', 40]]);
ok(e.ok, 'which makes room for another');
await t.admin('select public.admin_delete_track($1)', [e.id]);
ok((await t.one('Builder', 'select public.my_tracks() as j')).j.length === 2, 'the admin can delete any track');
done();
