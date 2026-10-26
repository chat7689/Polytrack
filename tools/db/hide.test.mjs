// Hidden runs: the school-day arithmetic, paying for days (100 credits
// each, stacking), and that nobody but the owner (and the admin) gets the
// recording of a hidden run while its time stays on the leaderboard.
import { makeDb, ok, done } from './db.mjs';
const t = await makeDb();
const add = async (from, n) => (await t.owner("select to_char(public._add_weekdays($1::timestamptz, $2) at time zone 'America/Los_Angeles', 'Dy HH24:MI') as v", [from, n])).rows[0].v;
// 2026-10-26 is a Monday (PDT, UTC-7)
ok(await add('2026-10-26 10:00-07', 1) === 'Tue 10:00', 'Monday 10:00 + 1 day = Tuesday 10:00');
ok(await add('2026-10-30 10:00-07', 1) === 'Mon 10:00', 'Friday 10:00 + 1 day = Monday 10:00 (the weekend is free): ' + await add('2026-10-30 10:00-07', 1));
ok(await add('2026-10-29 10:00-07', 2) === 'Mon 10:00', 'Thursday + 2 days = Monday');
ok(await add('2026-10-31 12:00-07', 1) === 'Tue 12:00', 'Saturday + 1 day: the weekend is skipped, then one day: ' + await add('2026-10-31 12:00-07', 1));
ok(await add('2026-10-26 10:00-07', 5) === 'Mon 10:00', 'Monday + 5 days = the next Monday');

await t.mkUser('Hider'); await t.mkUser('Peeker'); await t.mkUser('Broke');
const uid = async (n) => (await t.owner('select id from public.profiles where display_name = $1', [n])).rows[0].id;
const H = await uid('Hider'), B = await uid('Broke');
await t.owner("insert into public.credit_events (uid, delta, kind) values ($1, 1000, 'test')", [H]);
await t.owner("insert into public.credit_events (uid, delta, kind) values ($1, 50, 'test')", [B]);
for (const [u, n] of [[H, 'Hider'], [B, 'Broke']]) {
  await t.owner("insert into public.bests (uid, course_id, display_name, time_ms) values ($1, 's4c1', $2, 9000)", [u, n]);
  await t.owner("insert into public.ghosts (uid, course_id, time_ms, samples) values ($1, 's4c1', 9000, '1,2,3,4,5,6,7,8')", [u]);
}
const sees = async (who, owner) => (await t.as(who, "select uid from public.ghosts where course_id = 's4c1' and uid = $1", [owner])).rows.length === 1;
ok(await sees('Peeker', H), 'before hiding, anyone can load the run');
const r1 = (await t.one('Hider', "select public.hide_run('s4c1', 2) as j")).j;
ok(r1.ok && r1.cost === 200 && r1.balance === 800, 'hiding for 2 days costs 200 credits ' + JSON.stringify(r1));
ok(!(await sees('Peeker', H)), 'now nobody else gets the recording');
ok(await sees('Hider', H), 'but its owner does');
ok((await t.admin("select count(*)::int n from public.ghosts where uid = $1", [H])).rows[0].n === 1, 'and the admin does');
ok((await t.as('Peeker', "select time_ms from public.bests where uid = $1 and course_id = 's4c1'", [H])).rows.length === 1, 'the time stays on the leaderboard');
ok((await t.as('Peeker', "select until from public.run_hides where uid = $1", [H])).rows.length === 1, 'everyone can see that it is hidden, and until when');
const r2 = (await t.one('Hider', "select public.hide_run('s4c1', 1) as j")).j;
const more = (await t.owner("select public._add_weekdays(to_timestamp($1 / 1000.0), 1) as v", [r1.until])).rows[0].v;
ok(r2.ok && r2.until === new Date(more).getTime() && r2.balance === 700, 'paying again adds a day to the end of the time already paid');
const r3 = (await t.one('Broke', "select public.hide_run('s4c1', 1) as j")).j;
ok(!r3.ok && /100 credits/.test(r3.error), 'not enough credits: refused, nothing taken: ' + r3.error);
ok((await t.one('Broke', 'select public.my_balance() as j')).j === 50, 'and the balance is untouched');
ok(!(await t.one('Hider', "select public.hide_run('s4m3', 1) as j")).j.ok, 'a map with no run of yours cannot be hidden');
ok(!(await t.one('Hider', "select public.hide_run('s4c1', 0) as j")).j.ok && !(await t.one('Hider', "select public.hide_run('s4c1', 31) as j")).j.ok, '1 to 30 days only');
ok(/permission denied|row-level security/.test(await t.err('Peeker', "insert into public.run_hides (uid, course_id, until) values (auth.uid(), 's4c1', now() + interval '9 days')")), 'nobody writes a hide without paying');
await t.one('Hider', "select public.show_run('s4c1') as j");
ok(await sees('Peeker', H), 'showing it again opens it to everyone');
await t.one('Hider', "select public.hide_run('s4c1', 1) as j");
await t.owner("update public.run_hides set until = now() - interval '1 minute' where uid = $1", [H]);
ok(await sees('Peeker', H), 'a hide that ran out is over by itself');
done();
