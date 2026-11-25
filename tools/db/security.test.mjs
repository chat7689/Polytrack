// Account safety.
// 1. Internal helpers (public._*) are never callable from the game or the
//    API, so nobody can move another player's profile, credits or items by
//    calling one straight. (Nov 2026: _adopt was callable by any player.)
// 2. The limits added after two accounts were emptied in Nov 2026: sign-ins
//    that end by themselves, selling and auctions only from a recent sign-in
//    on a known computer, auctions only for settled accounts at real
//    prices, old profiles that can't be claimed, logins that can't be
//    renamed, a run log nobody can forge, pay links that stay Stripe's.
import { makeDb, ok, done } from './db.mjs';
const t = await makeDb();
const own = (sql, p) => t.owner(sql, p);

// every internal helper is closed to players and to anon
const open = (await own(`
  select p.proname as name, r.role
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'), ('authenticated')) r(role)
  where n.nspname = 'public' and p.proname like '\\_%'
    and has_function_privilege(r.role, p.oid, 'execute')
  order by 1`)).rows;
ok(open.length === 0, 'no public._* helper is executable by anon or players: ' + open.map((r) => r.name + '/' + r.role).join(', '));

// the attack: a signed-in player with no profile of their own calls _adopt
// to take another player's profile (name, credits, times)
await t.mkUser('Victim');
const V = t.users.Victim;
await own("insert into public.credit_events (uid, delta, kind) values ($1, 5000, 'test')", [V]);
const T = (await own("insert into auth.users (email) values ('thief@chat7689.github.io') returning id")).rows[0].id;
t.users.Thief = T;
const e1 = await t.err('Thief', 'select public._adopt($1, $2, $3)', [V, T, 'Victim']);
ok(e1 && /permission denied/.test(e1), 'a player cannot call _adopt: ' + e1);
const still = (await own('select id from public.profiles where display_name = $1', ['Victim'])).rows[0];
ok(still && still.id === V, 'the victim keeps their profile');
ok((await t.one('Victim', 'select public.my_balance() as j')).j === 5000, 'and their credits');
for (const [sql, args] of [
  ['select public._auction_give($1, $2)', [T, 'x']],
  ['select public._balance($1)', [V]],
  ['select public._may_play($1)', [V]],
  ['select public._podium_maps($1)', [V]],
  ['select public._track_limit($1)', [V]],
  ['select public._session_ok()', []],
  ['select public._ghost_like($1, $2, $3)', ['s5c1', V, '1,2,3']],
]) {
  const e = await t.err('Thief', sql, args);
  ok(e && /permission denied/.test(e), sql + ' is refused: ' + e);
}

// while the owner allows it, a returning player still gets their old profile
await own("insert into public.profiles (id, display_name, legacy) values (gen_random_uuid(), 'Oldie', true)");
const O = (await own("insert into auth.users (email) values ('oldie@chat7689.github.io') returning id")).rows[0].id;
t.users.Oldie = O;
const c = (await t.one('Oldie', "select public.claim_profile('Oldie', '', $1, 'fp') as j", ['a'.repeat(32)])).j;
ok(c.ok && c.adopted, 'with old-profile claims switched on, a returning player gets their profile: ' + JSON.stringify(c));
ok((await own('select id from public.profiles where display_name = $1', ['Oldie'])).rows[0].id === O, 'under their new login');
ok((await t.admin('select public.is_admin() as a')).rows[0].a === true, 'the admin token still works');

// ====================================================================
await t.rules(true);                       // the limits as the live game has them
const DEV = (n) => n.toString(16).padStart(32, '0');
let devN = 100;
const give = (n, item) => own('insert into public.inventory (uid, item) values ($1, $2) on conflict (uid, item) do update set count = public.inventory.count + 1', [t.users[n], item]);
const settle = async (n) => {             // an account old enough to trade
  await own("update public.profiles set created_at = now() - interval '30 days' where id = $1", [t.users[n]]);
  await own('insert into public.garage (uid, total) values ($1, 100) on conflict (uid) do update set total = 100', [t.users[n]]);
};
const useComputer = async (n, dev, ago) => {
  await t.one(n, 'select public.touch_device($1, $2) as j', [dev, 'fp']);
  if (ago) await own('update public.device_accounts set first_seen = now() - $3::interval where uid = $1 and device_id = $2', [t.users[n], dev, ago]);
};

// ---- a sign-in lasts 12 hours
await t.mkUser('Olive');
ok((await t.one('Olive', 'select public.my_garage() as j')).j, 'a fresh sign-in works');
await t.signIn('Olive', '13 hours');
ok(/session expired/.test(await t.err('Olive', 'select public.my_garage()')), 'a sign-in from 13 hours ago is refused');
ok(/session expired/.test(await t.err('Olive', "select public.sell_item('car:wedge', 1)")), 'for everything a player does');
ok(/Sign in again/.test(await t.err('Olive', 'select public.keep_session(true)')), 'and it can no longer be turned into a kept one');
// "keep me signed in": 30 days, asked for right after the password
await t.signIn('Olive');
ok((await t.one('Olive', 'select public.keep_session(true) as j')).j.keep === true, 'keep me signed in, right after signing in');
await own("update auth.sessions set created_at = now() - interval '20 days' where id = $1", [t.sessions.Olive]);
ok((await t.one('Olive', 'select public.my_garage() as j')).j, 'a kept sign-in still works after 20 days');
await own("update auth.sessions set created_at = now() - interval '31 days' where id = $1", [t.sessions.Olive]);
await own("update public.session_info set keep_until = keep_until - interval '31 days' where session_id = $1", [t.sessions.Olive]);
ok(/session expired/.test(await t.err('Olive', 'select public.my_garage()')), 'and ends after 30');
// signed out everywhere (the session row is gone): refused at once
await t.signIn('Olive');
await own('delete from auth.sessions where id = $1', [t.sessions.Olive]);
ok(/session expired/.test(await t.err('Olive', 'select public.my_garage()')), 'a sign-in that was ended is refused at once');
// the admin sets a new password: every sign-in of that player ends
await t.signIn('Olive');
await t.admin('select public.admin_set_password($1, $2)', [t.users.Olive, 'a new password 1']);
ok(/session expired/.test(await t.err('Olive', 'select public.my_garage()')), 'a new password from the admin signs the player out everywhere');
ok((await own("select count(*)::int n from public.admin_log where action = 'password'")).rows[0].n === 1, 'and it is in the admin log');

// ---- selling needs a recent sign-in on a computer the account knows
await t.mkUser('Seller'); await settle('Seller');
for (let i = 0; i < 4; i++) await give('Seller', 'car:wedge');
ok(/Reload the game/.test(await t.err('Seller', "select public.sell_item('car:wedge', 1)")), 'a sign-in that never said which computer it is on cannot sell');
const home = DEV(devN++), lab = DEV(devN++);
await useComputer('Seller', home, '10 days');
ok((await t.one('Seller', "select public.sell_item('car:wedge', 1) as j")).j.ok, 'on a computer used for days: sold');
// someone guessed the password and signs in on a computer the account has never used
await t.signIn('Seller');
await useComputer('Seller', lab);
const eNew = await t.err('Seller', "select public.sell_item('car:wedge', 1)");
ok(/new to your account/.test(eNew), 'a new computer cannot sell for 24 hours: ' + eNew);
ok(/new to your account/.test(await t.err('Seller', "select public.list_auction('car:wedge', 1000, null, 24)")), 'nor auction');
ok(/new to your account/.test(await t.err('Seller', 'select public.reset_my_scores()')), 'nor wipe the scores');
ok(/new to your account/.test(await t.err('Seller', "select public.hide_run('s5c1', 1)")), 'nor spend on hiding runs');
await own("update public.device_accounts set first_seen = now() - interval '25 hours' where uid = $1 and device_id = $2", [t.users.Seller, lab]);
ok((await t.one('Seller', "select public.sell_item('car:wedge', 1) as j")).j.ok, 'a day later that computer can');
// a kept sign-in (weeks old, say on a computer left signed in) can play but not sell
await t.signIn('Seller'); await useComputer('Seller', home);
await t.one('Seller', 'select public.keep_session(true) as j');
await own("update auth.sessions set created_at = now() - interval '5 days' where id = $1", [t.sessions.Seller]);
ok((await t.one('Seller', 'select public.my_garage() as j')).j, 'a kept sign-in from 5 days ago can play');
ok(/fresh sign-in/.test(await t.err('Seller', "select public.sell_item('car:wedge', 1)")), 'but selling asks for the password again');
// the first computer a brand-new account uses is not "new to the account"
await t.mkUser('Rookie'); await give('Rookie', 'car:wedge'); await useComputer('Rookie', DEV(devN++));
ok((await t.one('Rookie', "select public.sell_item('car:wedge', 1) as j")).j.ok, 'a new account sells on its first computer');

// ---- auctions: settled accounts, real prices
await give('Rookie', 'car:wedge');
ok(/3 days old and has 30 finished runs/.test(await t.err('Rookie', "select public.list_auction('car:wedge', 1000, null, 24)")), 'an account made today cannot auction');
await t.signIn('Seller'); await useComputer('Seller', home);
const sellPrice = (await own("select sell from public.items where id = 'car:wedge'")).rows[0].sell;
ok(/lowest starting price/.test(await t.err('Seller', "select public.list_auction('car:wedge', 1, 1, 24)")), 'no 1-credit auctions: the floor is what the game pays (' + sellPrice + ')');
const au = (await t.one('Seller', "select public.list_auction('car:wedge', $1::int, $1::int, 24) as j", [sellPrice])).j;
ok(au.ok, 'at the floor price it lists');
await own("insert into public.credit_events (uid, delta, kind) values ($1, 50000, 'test')", [t.users.Rookie]);
ok(/3 days old and has 30 finished runs/.test(await t.err('Rookie', 'select public.bid_auction($1, $2::int)', [au.id, sellPrice])), 'an account made today cannot bid (no instant catcher accounts)');
await t.mkUser('Buyer'); await settle('Buyer'); await useComputer('Buyer', DEV(devN++), '9 days');
await own("insert into public.credit_events (uid, delta, kind) values ($1, 50000, 'test')", [t.users.Buyer]);
ok((await t.one('Buyer', 'select public.bid_auction($1, $2::int) as j', [au.id, sellPrice])).j.bought, 'a settled account buys it');
// items bought with money are not sold or auctioned (sell, then refund, kept the credits)
await give('Seller', 'finish:holo');
ok(/can.t be sold/.test(await t.err('Seller', "select public.sell_item('finish:holo', 1)")), 'a bought item cannot be sold for credits');
ok(/can.t be auctioned/.test(await t.err('Seller', "select public.list_auction('finish:holo', 400, null, 24)")), 'nor auctioned');

// ---- old (pre-move) profiles are not for the taking
await own("insert into public.profiles (id, display_name, legacy) values (gen_random_uuid(), 'Ancient', true)");
await own(`insert into public.settings (key, value) values ('invite', '{"code":"LETMEIN"}') on conflict (key) do update set value = excluded.value`);
t.users.Ancient = (await own("insert into auth.users (email) values ('ancient@chat7689.github.io') returning id")).rows[0].id;
ok((await t.as(null, "select public.returning_player('Ancient') as r")).rows[0].r === false, 'the sign-in page no longer invites anyone to claim an old name');
const c2 = (await t.one('Ancient', "select public.claim_profile('Ancient', 'LETMEIN', $1, 'fp') as j", [DEV(devN++)])).j;
ok(!c2.ok && c2.error === 'taken', 'signing up under an old player\'s name is refused: ' + JSON.stringify(c2));
ok((await own("select legacy from public.profiles where display_name = 'Ancient'")).rows[0].legacy === true, 'the old profile is untouched');
ok(/not signed in/.test(await t.err('Ancient', "select public.claim_profile('Ancient2', 'LETMEIN', $1, 'fp')", [DEV(devN++)])), 'and that removed login cannot keep trying');

// ---- logins: the game's own only, never renamed
let eIns = null; try { await own("insert into auth.users (email) values ('someone@example.org')"); } catch (e) { eIns = e.message; }
ok(/Accounts are made in the game/.test(eIns || ''), 'a login with an outside address is refused: ' + eIns);
let eUpd = null; try { await own("update auth.users set email = 'thief@example.org' where id = $1", [t.users.Seller]); } catch (e) { eUpd = e.message; }
ok(/can.t be changed/.test(eUpd || ''), 'a login cannot be renamed: ' + eUpd);

// ---- the run log: the player's own name, the server's clock, small
await t.mkUser('Logger'); await t.mkUser('Framed');
const logN = async (n) => (await own('select count(*)::int n from public.run_log where display_name = $1', [n])).rows[0].n;
await t.as('Logger', "insert into public.run_log (uid, display_name, kind, time_ms, created_at, data) select auth.uid(), 'Framed', 'campaign', 1000, now() - interval '1 year', '{}'::jsonb from generate_series(1, 300)");
ok(await logN('Framed') === 0, 'a run log row cannot carry another player\'s name');
ok(await logN('Logger') === 40, 'back-dated rows no longer get past the 40-a-minute limit (kept ' + await logN('Logger') + ')');
ok((await own("select count(*)::int n from public.run_log where created_at < now() - interval '1 hour'")).rows[0].n === 0, 'and are dated by the server');
await own('delete from public.run_log where true');
await t.as('Logger', "insert into public.run_log (uid, kind, time_ms, data) values (auth.uid(), 'campaign', 1000, jsonb_build_object('x', repeat('a', 9000)))");
ok(await logN('Logger') === 0, 'an oversized row is dropped');
await t.as('Logger', `insert into public.run_log (uid, kind, time_ms, data) values (auth.uid(), 'campaign', 1000, '{"topKmh": 200}')`);
ok(await logN('Logger') === 1, 'the game\'s own rows still go in');

// ---- the pay links are Stripe's, whoever writes them
const eLink = await (async () => { try { await t.admin(`insert into public.settings (key, value) values ('shop', '{"link":"https://evil.example/pay","link5":""}') on conflict (key) do update set value = excluded.value`); return null; } catch (e) { return e.message; } })();
ok(/Stripe Payment Link/.test(eLink || ''), 'even an admin login cannot point the shop at another site: ' + eLink);
const eLink2 = await (async () => { try { await t.admin(`insert into public.settings (key, value) values ('money_links', '{"holo":"javascript:alert(1)"}') on conflict (key) do update set value = excluded.value`); return null; } catch (e) { return e.message; } })();
ok(/Stripe Payment Link/.test(eLink2 || ''), 'nor a money item: ' + eLink2);
await t.admin("select public.admin_set_money_link('holo', 'https://buy.stripe.com/abc123')");
ok((await own("select value ->> 'holo' as v from public.settings where key = 'money_links'")).rows[0].v === 'https://buy.stripe.com/abc123', 'a real Stripe link is still saved');

// ---- the admin login: nobody else can lock it, and it leaves a trace
for (let i = 0; i < 120; i++) await t.as(null, "select public.admin_login('nobody', 'wrong')", [], { ip: '10.9.' + (i % 12) + '.' + i });
const stillIn = (await t.as(null, "select public.admin_login('testadmin', 'test only password 1') as j", [], { ip: '10.0.0.77' })).rows[0].j;
ok(!!stillIn.token, '120 wrong tries from other networks do not lock the real admin out');
ok((await own("select count(*)::int n from public.admin_log where action = 'admin sign-in'")).rows[0].n >= 1, 'admin sign-ins are logged');

// ---- settle_daily: no rows for made-up days
await t.one('Logger', "select public.settle_daily('19990101') as j");
ok((await own("select count(*)::int n from public.daily_results where day = '19990101'")).rows[0].n === 0, 'a made-up day is not settled');

// ---- a streak carries over the weekend (2026-11-20 is a Friday)
const alive = async (a, b) => (await own('select public._streak_alive($1, $2) as v', [a, b])).rows[0].v;
ok(await alive('20261119', '20261120'), 'Thursday to Friday: the streak goes on');
ok(await alive('20261120', '20261123'), 'Friday to Monday: the weekend was closed, so it goes on');
ok(!(await alive('20261119', '20261123')), 'Thursday to Monday: Friday was missed, so it starts again');
ok(!(await alive('20261120', '20261124')), 'Friday to Tuesday: Monday was missed');
await own(`insert into public.settings (key, value) values ('hours', '{"on": false}') on conflict (key) do update set value = excluded.value`);
ok(!(await alive('20261120', '20261123')), 'with the game open every day, the weekend counts as missed');
await own("delete from public.settings where key = 'hours'");

// ---- friends-race rooms: the server says who opened the room
await t.signIn('Buyer'); await t.signIn('Seller');
ok((await t.one('Buyer', "select public.room_host('ABCD', 'aaaaaaaa1111') as k")).k === 'aaaaaaaa1111', 'the player who opens a room is its host');
ok((await t.one('Seller', "select public.room_host('ABCD', 'bbbbbbbb2222') as k")).k === 'aaaaaaaa1111', 'someone else opening the same code does not take it over');
ok((await t.one('Seller', "select public.room_host('ABCD', null) as k")).k === 'aaaaaaaa1111', 'joiners are told the same host');
await t.as('Seller', "select public.room_close('ABCD')");
ok((await t.one('Seller', "select public.room_host('ABCD', null) as k")).k === 'aaaaaaaa1111', 'only the host can close the room');
await t.as('Buyer', "select public.room_close('ABCD')");
ok((await t.one('Seller', "select public.room_host('ABCD', null) as k")).k === '', 'closed by its host, the room has none');

// ---- a refund takes back what the Driver Road paid for the gift levels
await t.mkUser('Payer');
await own("select public.grant_purchase('cs_test_road', $1, 2000, 'usd', 'pi_test_road')", [t.users.Payer]);
const lvlBefore = (await own('select public._level(xp) as l, xp from public.garage where uid = $1', [t.users.Payer])).rows[0];
await t.one('Payer', 'select public.claim_road() as j');
const afterClaim = (await own('select road_upto, free_boxes from public.garage where uid = $1', [t.users.Payer])).rows[0];
const hadGold = (await own("select count(*)::int n from public.inventory where uid = $1 and item = 'finish:gold'", [t.users.Payer])).rows[0].n;
await own("select public.refund_purchase('pi_test_road')");
const afterRefund = (await own('select road_upto, free_boxes, public._level(xp) as l from public.garage where uid = $1', [t.users.Payer])).rows[0];
ok(lvlBefore.l >= 20 && afterClaim.road_upto >= 20 && hadGold === 1, '(setup) $20 gave 20 levels and the Driver Road paid them out (level ' + lvlBefore.l + ')');
ok(afterRefund.l === 1 && afterRefund.road_upto === 1, 'after the refund the levels and the Driver Road are back where they were');
ok((await own("select count(*)::int n from public.inventory where uid = $1 and item in ('finish:gold', 'title:road-rookie', 'icon:lvl-shield', 'title:road-warrior')", [t.users.Payer])).rows[0].n === 0, 'the level items are gone');
ok(afterRefund.free_boxes <= Math.max(0, afterClaim.free_boxes - 8), 'and the level boxes (' + afterClaim.free_boxes + ' -> ' + afterRefund.free_boxes + ')');

// ---- slow motion: a run may take only a little longer in real time than its clock says
// (Nov 2026: first places were taken with the page slowed to a tenth of its speed)
await own("insert into public.access_codes (code, label, expires_at) values ('SLOWSLOW', 'tests', now() + interval '1 day')");
await t.mkUser('Slomo'); await t.one('Slomo', "select public.redeem_access('SLOWSLOW') as j");
const slowDev = DEV(devN++);
const drive = async (clockMs, realSecs) => {
  const s = (await t.one('Slomo', "select public.start_run('s5c1', $1, 'fp', false) as j", [slowDev])).j;
  if (!s.ok) throw new Error(JSON.stringify(s));
  await own('update public.runs set started_at = now() - make_interval(secs => $2) where id = $1', [s.run, realSecs]);
  return (await t.one('Slomo', 'select public.finish_run($1, $2, 100, false) as j', [s.run, clockMs])).j;
};
ok((await drive(20000, 20.3)).ok, 'a 20 s run that took 20.3 s counts');
ok((await drive(20000, 21.4)).ok, 'and one that took 21.4 s (a slow connection, a stutter)');
ok(!(await drive(20000, 22.2)).ok, 'but not one that took 22.2 s (the game at 0.9x)');
const half = await drive(20000, 40);
ok(!half.ok && half.slow, 'a 20 s run that took 40 s (the game at half speed) is refused: ' + half.message);
const tenth = await drive(15000, 150);
ok(!tenth.ok && tenth.slow, 'a 15 s run that took 150 s (a tenth of the speed) is refused');
ok(!(await drive(13000, 130)).ok, 'and a 13 s one that took 130 s (this one used to get through)');
const paused = await drive(20000, 26);
ok(!paused.ok && paused.slow, 'a run paused for 6 seconds in the middle is refused too');
const slowEv = (await own("select count(*)::int n, max(detail) as d from public.security_events where kind = 'slow motion' and name = 'Slomo'")).rows[0];
ok(slowEv.n === 1 && /0\.[0-9]+x speed/.test(slowEv.d), 'and the admin\'s security feed says who tried: ' + slowEv.d);
ok((await own("select count(*)::int n from public.bests where uid = $1", [t.users.Slomo])).rows[0].n === 0, 'no time reached the board from a slowed run');
// the owner can widen or tighten it without a new schema
await own(`insert into public.settings (key, value) values ('run_clock', '{"pct": 50, "ms": 0}') on conflict (key) do update set value = excluded.value`);
ok((await drive(20000, 29)).ok, 'settings run_clock widens the limit');
await own("delete from public.settings where key = 'run_clock'");
// Escape: the storm is on the game's clock, so the distance says how long the run can have lasted
const esc = async (meters, realSecs) => {
  const s = (await t.one('Slomo', 'select public.start_escape() as j')).j;
  await own('update public.escape_runs set started_at = now() - make_interval(secs => $2) where id = $1', [s.run, realSecs]);
  return (await t.one('Slomo', 'select public.finish_escape($1, $2) as j', [s.run, meters])).j;
};
ok((await esc(2500, 85)).ok, 'Escape: 2 500 m after 85 s (when the storm gets there) counts');
ok(!(await esc(4000, 600)).ok, 'Escape: 4 000 m after ten minutes (the game slowed down) does not');

// ---- the game's own test driver is not a player
import fs from 'fs';
const recs = JSON.parse(fs.readFileSync(new URL('recs.json', import.meta.url), 'utf8'));
const bot = recs.find((x) => x.id === 's5c1');
const send = async (samples, ms) => {
  const s = (await t.one('Slomo', "select public.start_run('s5c1', $1, 'fp', false) as j", [slowDev])).j;
  await own('update public.runs set started_at = now() - make_interval(secs => $2) where id = $1', [s.run, ms / 1000]);
  const f = (await t.one('Slomo', 'select public.finish_run($1, $2, 100, false) as j', [s.run, ms])).j;
  if (!f.ok) throw new Error(JSON.stringify(f));
  return (await t.one('Slomo', 'select public.submit_best($1, $2, $3, 2::smallint, $4) as j', ['s5c1', ms, samples, s.run])).j;
};
const asBot = await send(bot.samples, bot.ms);
ok(asBot.improved === false && asBot.copied === true, 'the test driver\'s own recording is refused as a player\'s time: ' + JSON.stringify(asBot));
ok((await own('select count(*)::int n from public.bests where uid = $1', [t.users.Slomo])).rows[0].n === 0, 'and nothing reaches the board');
// a real player's line is a different one: the same recording moved 1.5 m sideways passes
const shifted = bot.samples.split(',').map((v, i) => (i % 8 === 0 ? (Number(v) + 1.5).toFixed(2) : v)).join(',');
ok((await send(shifted, bot.ms)).improved === true, 'a recording on a different line is accepted');

// ---- the game reports a tampered clock
await useComputer('Slomo', slowDev);
await t.as('Slomo', "select public.client_flag('clock', 'raf=1.5 perf=1.5 tl=15.0 <script>')");
await t.as('Slomo', "select public.client_flag('nonsense', 'x')");
const cf = (await own("select kind, detail from public.security_events where name = 'Slomo' and kind like 'client %'")).rows;
ok(cf.length === 1 && cf[0].kind === 'client clock' && /raf=1.5 perf=1.5 tl=15.0 script/.test(cf[0].detail), 'a tampered clock reaches the security feed, cleaned: ' + JSON.stringify(cf));
done();
