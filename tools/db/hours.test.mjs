// Opening hours, access codes and the run lock.
import { makeDb, ok, done } from './db.mjs';
const t = await makeDb();
const open = async (iso) => (await t.owner('select public._open_at($1::timestamptz) as o', [iso])).rows[0].o;
const next = async (iso) => (await t.owner("select to_char(public._next_open($1::timestamptz) at time zone 'America/Los_Angeles', 'Dy YYYY-MM-DD HH24:MI') as n", [iso])).rows[0].n;
// Pacific times (PDT in October = UTC-7; PST from 2 Nov = UTC-8)
ok(!(await open('2026-10-26 08:29:59-07')), 'Monday 8:29:59 closed');
ok(await open('2026-10-26 08:30:00-07'), 'Monday 8:30 open');
ok(await open('2026-10-26 15:29:59-07'), 'Monday 3:29:59 PM open');
ok(!(await open('2026-10-26 15:30:00-07')), 'Monday 3:30 PM closed');
ok(await open('2026-10-28 14:29:00-07'), 'Wednesday 2:29 PM open');
ok(!(await open('2026-10-28 14:30:00-07')), 'Wednesday 2:30 PM closed');
ok(await open('2026-10-29 15:00:00-07'), 'Thursday 3 PM open');
ok(await open('2026-10-30 09:00:00-07'), 'Friday 9 AM open');
ok(!(await open('2026-10-31 10:00:00-07')), 'Saturday closed');
ok(!(await open('2026-11-01 10:00:00-08')), 'Sunday closed');
ok(await open('2026-11-02 08:30:00-08'), 'Monday after the clocks change: 8:30 PST open');
ok(!(await open('2026-11-02 08:29:00-08')), 'and 8:29 PST closed');
ok(await next('2026-10-30 16:00:00-07') === 'Mon 2026-11-02 08:30', 'after Friday closes, next open is Monday 8:30: ' + await next('2026-10-30 16:00:00-07'));
ok(await next('2026-10-28 07:00:00-07') === 'Wed 2026-10-28 08:30', 'early Wednesday opens the same morning');
ok(await next('2026-10-28 15:00:00-07') === 'Thu 2026-10-29 08:30', 'after Wednesday closes, Thursday 8:30');

// codes: only the admin makes them
await t.mkUser('Kid1'); await t.mkUser('Kid2');
ok(/admins only|permission denied/i.test(await t.err('Kid1', "select public.admin_make_access_code('x', now() + interval '1 hour')")), 'players cannot make codes');
const nowOpen = (await t.owner('select public._open_at(now()) as o')).rows[0].o;
const st0 = (await t.one('Kid1', 'select public.play_status() as j')).j;
ok(st0.open === nowOpen && st0.opens > st0.now, 'play_status says open/closed and when it opens next ' + JSON.stringify(st0));
const c = (await t.admin("select public.admin_make_access_code('Saturday club', now() + interval '2 hours') as j")).rows[0].j;
ok(/^[A-Z2-9]{8}$/.test(c.code), 'a code is 8 letters/numbers: ' + c.code);
{ let m = ''; try { await t.admin("select public.admin_make_access_code('x', now() - interval '1 hour')"); } catch (e) { m = e.message; } ok(/end time in the future/.test(m), 'a code must end in the future: ' + m); }
// the run lock: closed now (unless this test runs in school hours)
const dev = 'a'.repeat(32);
const run = async (name) => (await t.one(name, 'select public.start_run($1, $2, $3, false) as j', ['s3c1', dev, 'fp'])).j;
if (!nowOpen) {
  const r1 = await run('Kid1');
  ok(!r1.ok && r1.error === 'closed', 'outside hours a run is refused ' + JSON.stringify(r1));
}
ok((await t.one('Kid1', "select public.redeem_access('nope1234') as j")).j.ok === false, 'a wrong code is refused');
const red = (await t.one('Kid1', 'select public.redeem_access($1) as j', [c.code.toLowerCase().replace(/(....)/, '$1-')])).j;
ok(red.ok && red.label === 'Saturday club', 'the right code works (any case, with a dash) ' + JSON.stringify(red));
ok((await t.one('Kid1', 'select public.play_status() as j')).j.granted > 0, 'and play_status shows the grant');
const r2 = await run('Kid1');
ok(r2.ok, 'with a code, a run starts at any hour ' + JSON.stringify(r2));
if (!nowOpen) ok(!(await run('Kid2')).ok, 'another player without the code still cannot');
// deleting the code ends it at once
await t.admin('select public.admin_delete_access_code($1)', [c.code]);
if (!nowOpen) ok((await run('Kid1')).error === 'closed', 'a deleted code stops working');
const list = (await t.admin('select public.admin_access_codes() as j')).rows[0].j;
ok(Array.isArray(list) && list.length === 0, 'and leaves the list');
// guessing is limited
for (let k = 0; k < 8; k++) await t.one('Kid2', "select public.redeem_access('ZZZZZZZZ') as j");
ok(/Too many/.test((await t.one('Kid2', "select public.redeem_access('ZZZZZZZZ') as j")).j.error), 'eight wrong codes in ten minutes locks guessing');
ok((await t.as('Kid1', 'select * from public.access_codes')).rows.length === 0, 'players cannot read the codes');
done();
