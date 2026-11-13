// Growth: the daily play streak (credits, a box every 7th day, a missed day
// starts it again), invites paying a free box to both at the friend's 10th
// finish (not when it's one person on one computer), open sign-ups, and
// the "playing now" count.
import { makeDb, ok, done } from './db.mjs';
const t = await makeDb();
const DEV = (k) => String(k).repeat(32).slice(0, 32);
await t.owner(`insert into public.settings (key, value) values ('invite', '{"code": "TESTCODE"}') on conflict (key) do update set value = excluded.value`);
await t.owner("insert into public.access_codes (code, label, expires_at) values ('OPENOPEN', 'tests', now() + interval '1 day')");
async function signup(name, code, device) {
  const r = await t.owner('insert into auth.users (email) values ($1) returning id', [name.toLowerCase() + '@chat7689.github.io']);
  t.users[name] = r.rows[0].id;
  const j = (await t.one(name, 'select public.claim_profile($1, $2, $3, $4) as j', [name, code, device, 'fp-' + name])).j;
  if (j.ok) await t.one(name, "select public.redeem_access('OPENOPEN') as j");
  return j;
}
async function finish(name, device) {
  const s = (await t.one(name, "select public.start_run('s4c1', $1, 'fp', false) as j", [device])).j;
  if (!s.ok) throw new Error(JSON.stringify(s));
  await t.owner("update public.runs set started_at = now() - interval '30 seconds' where id = $1", [s.run]);
  return (await t.one(name, 'select public.finish_run($1, 20000, 100, false) as j', [s.run])).j;
}
const boxes = async (name) => (await t.owner('select coalesce((select free_boxes from public.garage where uid = $1), 0) as n', [t.users[name]])).rows[0].n;
const credits = async (name, kind) => Number((await t.owner('select coalesce(sum(delta), 0) as n from public.credit_events where uid = $1 and kind = $2', [t.users[name], kind])).rows[0].n);

// --- the streak
ok((await signup('Ava', 'TESTCODE', DEV(1))).ok, 'Ava signs up with the code');
let f = await finish('Ava', DEV(1));
ok(f.ok && f.streak === 1 && f.streak_bonus === 25, 'the first finish of a day starts a streak and pays 25 ' + JSON.stringify(f));
f = await finish('Ava', DEV(1));
ok(f.streak_bonus === 0 && (await credits('Ava', 'streak')) === 25, 'the second finish that day pays nothing more');
let day = (await t.one('Ava', 'select public.my_day() as j')).j;
ok(day.streak === 1 && day.today === true, 'my_day shows the streak ' + JSON.stringify(day));
// pretend yesterday was day 6 of a streak
const yday = "to_char((now() at time zone 'America/Los_Angeles')::date - 1, 'YYYYMMDD')";
await t.owner(`update public.garage set streak = 6, streak_day = ${yday} where uid = $1`, [t.users.Ava]);
await t.owner("delete from public.credit_events where uid = $1 and kind = 'streak'", [t.users.Ava]);
day = (await t.one('Ava', 'select public.my_day() as j')).j;
ok(day.streak === 6 && day.today === false, 'yesterday\'s streak still shows, not yet played today');
const b0 = await boxes('Ava');
f = await finish('Ava', DEV(1));
ok(f.streak === 7 && f.streak_bonus === 175 && f.streak_box === true && (await boxes('Ava')) === b0 + 1, 'day 7 pays 175 and a free box ' + JSON.stringify(f));
ok((await t.owner('select best_streak from public.garage where uid = $1', [t.users.Ava])).rows[0].best_streak === 7, 'the best streak is kept');
// a missed day
await t.owner("update public.garage set streak = 9, streak_day = to_char((now() at time zone 'America/Los_Angeles')::date - 2, 'YYYYMMDD') where uid = $1", [t.users.Ava]);
await t.owner("delete from public.credit_events where uid = $1 and kind = 'streak'", [t.users.Ava]);
ok((await t.one('Ava', 'select public.my_day() as j')).j.streak === 0, 'a missed day: the menu shows no streak');
f = await finish('Ava', DEV(1));
ok(f.streak === 1 && f.streak_bonus === 25, 'and the next finish starts again at 1');
// day 10 pays the 7-day most
await t.owner(`update public.garage set streak = 9, streak_day = ${yday} where uid = $1`, [t.users.Ava]);
await t.owner("delete from public.credit_events where uid = $1 and kind = 'streak'", [t.users.Ava]);
f = await finish('Ava', DEV(1));
ok(f.streak === 10 && f.streak_bonus === 175 && !f.streak_box, 'past 7 days it stays at 175 a day, a box only every 7th ' + JSON.stringify(f));

// --- invites
ok((await signup('Ben', 'ref:Ava', DEV(2))).ok, 'Ben joins with Ava\'s link');
const a0 = await boxes('Ava');
for (let k = 0; k < 9; k++) f = await finish('Ben', DEV(2));
ok(!f.ref_box && (await boxes('Ava')) === a0, 'nothing yet after 9 finishes');
let inv = (await t.one('Ava', 'select public.my_invites() as j')).j;
ok(inv.friends.length === 1 && inv.friends[0].name === 'Ben' && inv.friends[0].runs === 9 && inv.boxes === 0, 'Ava sees Ben at 9 of 10 ' + JSON.stringify(inv));
f = await finish('Ben', DEV(2));
ok(f.ref_box === true && f.ref_name === 'Ava', 'the 10th finish pays the invite ' + JSON.stringify(f));
ok((await boxes('Ava')) === a0 + 1 && (await boxes('Ben')) >= 1, 'a free box each');
ok((await t.owner("select count(*)::int n from public.credit_events where uid = $1 and kind = 'invite_box'", [t.users.Ava])).rows[0].n === 1, 'Ava\'s game hears about it');
f = await finish('Ben', DEV(2));
ok(!f.ref_box && (await boxes('Ava')) === a0 + 1, 'only once');
inv = (await t.one('Ava', 'select public.my_invites() as j')).j;
ok(inv.boxes === 1 && inv.friends[0].reward === 'boxes', 'Ava\'s invites show the box');
// one person, two accounts on one computer
ok((await signup('Cal', 'ref:Ava', DEV(1))).ok, 'Cal joins with Ava\'s link on Ava\'s computer');
const a1 = await boxes('Ava');
await t.owner("update public.runs set started_at = now() - interval '10 minutes' where uid = $1", [t.users.Ava]);
for (let k = 0; k < 10; k++) f = await finish('Cal', DEV(1));
ok(!f.ref_box && (await boxes('Ava')) === a1, 'the same computer: no boxes');
ok((await t.owner('select reward from public.referrals where uid = $1', [t.users.Cal])).rows[0].reward === 'none', 'and it is marked so it never pays');
ok(/permission denied/.test(await t.err('Ava', "select public._same_computer(auth.uid(), auth.uid())")), 'players can\'t ask who shares a computer');

// --- open sign-ups
ok((await signup('Dee', '', DEV(3))).error === 'invite', 'invite-only: no code, no account');
ok((await t.one(null, "select public.device_status($1, 'x') as j", [DEV(9)])).j.openSignups === false, 'the game knows sign-ups need a code');
await t.admin('select public.admin_set_open_signups(true)');
ok((await t.admin('select public.admin_open_signups() as o')).rows[0].o === true, 'the admin opens sign-ups');
ok((await t.one(null, "select public.device_status($1, 'x') as j", [DEV(9)])).j.openSignups === true, 'and the game knows');
ok((await signup('Eve', '', DEV(4))).ok, 'now anyone can join with no code');
ok(/admin/i.test(await t.err('Eve', 'select public.admin_set_open_signups(false)')), 'only the admin can switch it');
await t.admin('select public.admin_set_open_signups(false)');
ok((await signup('Fay', '', DEV(5))).error === 'invite', 'closed again');

// --- playing now, and the admin's view
const on = (await t.one(null, 'select public.online_now() as n')).n;
ok(on >= 2, 'drivers who started a run in the last 5 minutes are counted (' + on + ')');
const st = (await t.admin('select public.admin_invite_stats() as j')).rows[0].j;
ok(st.total === 2 && st.paid === 1 && st.same === 1 && st.top[0].name === 'Ava', 'the admin sees the invites ' + JSON.stringify(st));
ok(/admin/i.test(await t.err('Ava', 'select public.admin_invite_stats()')), 'and only the admin');
done();
