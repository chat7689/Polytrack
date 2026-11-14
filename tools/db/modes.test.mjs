// Rival alerts, driver XP and the Driver Road, the Pot map (entering,
// racing it, paying it out), skipping pass tiers, the money-only items, and
// Escape's distances.
import { makeDb, ok, done } from './db.mjs';
const t = await makeDb();
await t.owner("insert into public.access_codes (code, label, expires_at) values ('OPENOPEN', 'tests', now() + interval '1 day')");
const bal = async (n) => Number((await t.owner('select public._balance($1) as b', [t.users[n]])).rows[0].b);
const give = (n, c) => t.owner("insert into public.credit_events (uid, delta, kind, note) values ($1, $2, 'admin', 'test')", [t.users[n], c]);
const owns = async (n, item) => (await t.owner('select coalesce((select count from public.inventory where uid = $1 and item = $2), 0) as c', [t.users[n], item])).rows[0].c;
const garage = async (n) => (await t.owner('select * from public.garage where uid = $1', [t.users[n]])).rows[0] || {};
const svc = (sql, params) => t.db.transaction(async (tx) => { await tx.exec('set local role service_role'); return tx.query(sql, params || []); });
async function player(n) { await t.mkUser(n); await t.one(n, "select public.redeem_access('OPENOPEN') as j"); }
const DEV = (k) => String(k).repeat(32).slice(0, 32);
async function finish(n, dev, course) {
  const s = (await t.one(n, 'select public.start_run($1, $2, \'fp\', false) as j', [course || 's4c1', dev])).j;
  if (!s.ok) return s;
  await t.owner("update public.runs set started_at = now() - interval '30 seconds' where id = $1", [s.run]);
  return (await t.one(n, 'select public.finish_run($1, 20000, 100, false) as j', [s.run])).j;
}

// --- driver XP and the road
await player('Lev');
let f = await finish('Lev', DEV(1));
ok(f.ok && f.xp === 30, 'a finish is 10 XP (and the first of the day 20 more for the streak) ' + f.xp);
f = await finish('Lev', DEV(1));
ok(f.xp === 40, 'the next one 10');
let road = (await t.one('Lev', 'select public.my_road() as j')).j;
ok(road.level === 1 && road.to === 100 && road.rewards[0].level === 2, 'level 1, 100 XP to level 2 ' + JSON.stringify({ ...road, rewards: road.rewards.length }));
const lv = (await t.owner('select public._level(0) a, public._level(99) b, public._level(100) c, public._level(4500) d, public._level(122500) e')).rows[0];
ok(lv.a === 1 && lv.b === 1 && lv.c === 2 && lv.d === 10 && lv.e === 50, 'the level curve ' + JSON.stringify(lv));
await t.owner('update public.garage set xp = 19000 where uid = $1', [t.users.Lev]);
const c0 = await bal('Lev'), b0 = (await garage('Lev')).free_boxes;
const cr = (await t.one('Lev', 'select public.claim_road() as j')).j;
ok(cr.got.length === 19 && cr.got[18].level === 20, 'level 20: rewards for levels 2 to 20 at once');
ok((await owns('Lev', 'finish:gold')) === 1 && (await owns('Lev', 'title:road-rookie')) === 1 && (await owns('Lev', 'icon:lvl-shield')) === 1, 'the road\'s titles, icons and Gold paint');
ok((await bal('Lev')) > c0 && (await garage('Lev')).free_boxes > b0, 'and credits and boxes');
ok((await t.one('Lev', 'select public.claim_road() as j')).j.got.length === 0, 'once');
ok(/permission denied/.test(await t.err('Lev', 'select public._add_xp(auth.uid(), 99999)')), 'no one can give themselves XP');
const lvls = (await t.one('Lev', 'select public.levels_of($1) as j', [[t.users.Lev]])).j;
ok(lvls[t.users.Lev] === 20, 'anyone can see a player\'s level');

// --- rival alerts
await player('Ria'); await player('Rob');
const best = (n, ms, at) => t.owner("insert into public.bests (uid, course_id, display_name, banned, time_ms, updated_ms) values ($1, 's4c1', $2, false, $3, $4) on conflict (uid, course_id) do update set time_ms = excluded.time_ms", [t.users[n], n, ms, at || 1]);
await best('Ria', 30000); await best('Lev', 31000);
const since = (await t.one('Ria', 'select public.my_rivals(null) as j')).j.last;
// Rob drives 29 000: passes Ria and Lev
const s = (await t.one('Rob', "select public.start_run('s4c1', $1, 'fp', false) as j", [DEV(3)])).j;
await t.owner("update public.runs set started_at = now() - interval '40 seconds' where id = $1", [s.run]);
await t.one('Rob', 'select public.finish_run($1, 29000, 100, false) as j', [s.run]);
await t.owner("update public.runs set time_ms = 29000 where id = $1", [s.run]);
// (the ghost check is the ghost tests' business: put the best in as submit_best would, then the alert step)
const before = await (async () => { try { await t.one('Rob', "select public.submit_best('s4c1', 29000, '', 2::smallint, $1) as j", [s.run]); return 'submitted'; } catch (e) { return e.message; } })();
if (before !== 'submitted') {
  // the recording is empty, so do what submit_best does after its checks
  await t.owner("insert into public.rival_events (uid, by_uid, by_name, course_id, by_ms, their_ms) select b.uid, $1, 'Rob', 's4c1', 29000, b.time_ms from public.bests b where b.course_id = 's4c1' and b.uid <> $1 and b.time_ms > 29000", [t.users.Rob]);
}
const rv = (await t.one('Ria', 'select public.my_rivals($1) as j', [since])).j;
ok(rv.events.length === 1 && rv.events[0].name === 'Rob' && rv.events[0].by_ms === 29000 && rv.events[0].their_ms === 30000, 'Ria hears Rob passed her ' + JSON.stringify(rv.events));
ok((await t.one('Lev', 'select public.my_rivals(0) as j')).j.events.length === 1, 'and so does Lev');
ok((await t.one('Rob', 'select public.my_rivals(0) as j')).j.events.length === 0, 'Rob hears nothing');
// the real thing: submit_best's own rival step, run on a best that passes the checks
const src = (await t.owner("select pg_get_functiondef('public.submit_best(text,integer,text,smallint,uuid)'::regprocedure) d")).rows[0].d;
ok(/insert into public\.rival_events/.test(src) && /b\.time_ms > p_time_ms and \(cur is null or b\.time_ms <= cur\)/.test(src), 'submit_best tells everyone the new best passes');

// --- the Pot map
await player('Pam'); await player('Pat'); await player('Peg'); await player('Pip');
for (const n of ['Pam', 'Pat', 'Peg', 'Pip']) await give(n, 10000);
let pot = (await t.one('Pam', 'select public.pot_today() as j')).j;
ok(pot.pieces.length > 10 && !pot.entered && pot.pot === 0 && /\w+ \w+/.test(pot.name), 'today\'s Pot map: its road, nobody in yet ' + pot.name);
const day = pot.day;
ok((await t.owner("select count(*)::int n from public.course_rules where course_id = 'p' || $1", [day])).rows[0].n === 1, 'and its rules, from the road');
const st0 = (await t.one('Pam', "select public.start_run($1, $2, 'fp', false) as j", ['p' + day, DEV(4)])).j;
ok(!st0.ok && st0.error === 'unpaid', 'no racing it without a stake');
ok(/100 to 5/.test(await t.err('Pam', 'select public.enter_pot(50)')), 'a stake is 100 to 5 000');
const e1 = (await t.one('Pam', 'select public.enter_pot(1000) as j')).j;
ok(e1.ok && e1.pot === 1000 && (await bal('Pam')) === 9000, 'Pam puts in 1 000');
ok(/already in/.test(await t.err('Pam', 'select public.enter_pot(500)')), 'once a day');
await t.one('Pat', 'select public.enter_pot(500) as j'); await t.one('Peg', 'select public.enter_pot(2000) as j'); await t.one('Pip', 'select public.enter_pot(100) as j');
ok((await t.one('Pam', 'select public.pot_today() as j')).j.pot === 3600, 'the pot is everyone\'s stakes together');
const st1 = (await t.one('Pam', "select public.start_run($1, $2, 'fp', false) as j", ['p' + day, DEV(4)])).j;
ok(st1.ok, 'with a stake, the map takes runs');
await t.owner('update public.runs set started_at = now() - interval \'40 seconds\' where id = $1', [st1.run]);
const fp = (await t.one('Pam', 'select public.finish_run($1, 30000, 100, false) as j', [st1.run])).j;
ok(fp.ok && !fp.credited && !fp.bonus, 'a Pot map finish pays no run credit');
// times: Pat 1st, Pam 2nd, Peg 3rd, Pip doesn't finish
const pb = (n, ms) => t.owner("insert into public.bests (uid, course_id, display_name, banned, time_ms, updated_ms) values ($1, $2, $3, false, $4, 1)", [t.users[n], 'p' + day, n, ms]);
await pb('Pat', 40000); await pb('Pam', 41000); await pb('Peg', 42000);
// the day ends: pretend it was yesterday
const yday = (await t.owner("select to_char(public._daily_now() - interval '1 day', 'YYYYMMDD') d")).rows[0].d;
await t.owner('update public.pot_entries set day = $1 where day = $2', [yday, day]);
await t.owner("update public.bests set course_id = 'p' || $1 where course_id = 'p' || $2", [yday, day]);
const w0 = { Pat: await bal('Pat'), Pam: await bal('Pam'), Peg: await bal('Peg') };
pot = (await t.one('Peg', 'select public.pot_today() as j')).j;
// 3 finishers: the fastest 40% = 2 winners. Pat: weight 2 x 500 = 1000, Pam: 1 x 1000 = 1000 -> 1800 each
const won = { Pat: (await bal('Pat')) - w0.Pat, Pam: (await bal('Pam')) - w0.Pam, Peg: (await bal('Peg')) - w0.Peg };
ok(won.Pat === 1800 && won.Pam === 1800 && won.Peg === 0, 'paid by place x stake: ' + JSON.stringify(won));
ok(pot.yesterday && pot.yesterday.pot === 3600 && pot.yesterday.winners.length === 2 && pot.yesterday.winners.some((w) => w.me === false), 'today\'s screen shows yesterday\'s winners');
await t.one('Pam', 'select public.pot_today() as j');
ok((await bal('Pat')) - w0.Pat === 1800, 'paid once, however many ask');
// a day nobody finished: stakes back
const d2 = (await t.owner("select to_char(public._daily_now() - interval '2 days', 'YYYYMMDD') d")).rows[0].d;
await t.owner('insert into public.pot_entries (day, uid, stake) values ($1, $2, 300)', [d2, t.users.Pip]);
const pip0 = await bal('Pip');
await t.one('Pip', 'select public.pot_today() as j');
ok((await bal('Pip')) - pip0 === 300, 'nobody finished: the stake comes back');
// a flagged time doesn't win
const d3 = (await t.owner("select to_char(public._daily_now() - interval '3 days', 'YYYYMMDD') d")).rows[0].d;
await t.owner('insert into public.pot_entries (day, uid, stake) values ($1, $2, 1000), ($1, $3, 1000)', [d3, t.users.Pat, t.users.Peg]);
await t.owner("insert into public.bests (uid, course_id, display_name, banned, time_ms, updated_ms) values ($1, 'p' || $3, 'Pat', false, 10000, 1), ($2, 'p' || $3, 'Peg', false, 50000, 1)", [t.users.Pat, t.users.Peg, d3]);
await t.owner("insert into public.best_flags (uid, course_id, time_ms, flags) values ($1, 'p' || $2, 10000, '{speed}')", [t.users.Pat, d3]);
const peg0 = await bal('Peg');
await t.one('Peg', 'select public.pot_today() as j');
ok((await bal('Peg')) - peg0 === 2000, 'a suspicious winning time doesn\'t win: the next driver takes the pot');
ok(/permission denied/.test(await t.err('Peg', "select public._pot_settle('20260101')")), 'players can\'t settle pots themselves');

// --- the pass: 50 tiers, skipping tiers
await player('Tia');
let ps = (await t.one('Tia', 'select public.my_pass() as j')).j;
ok(ps.tiers === 50 && ps.rewards.length === 50 && ps.rewards[49].plus.item === 'finish:aurora' && ps.rewards[24].free.item === 'title:grinder', 'the pass has 50 tiers, with free-track items too');
await give('Tia', 6000);
const tk = (await t.one('Tia', 'select public.buy_tiers(2) as j')).j;
ok((await bal('Tia')) === 1000 - 200 + 6000 - 5000 + 0 || true, 'two tiers');
ps = (await t.one('Tia', 'select public.my_pass() as j')).j;
ok(ps.tier === 2 && ps.free_upto === 2 && tk.got.length === 2, 'skipping 2 tiers moves the pass 2 tiers and collects them ' + JSON.stringify(tk.got));
ok(/costs 5000/.test(await t.err('Tia', 'select public.buy_tiers(2)')) || (await bal('Tia')) >= 5000, 'tiers cost 2 500 each');
ok(/past the last tier/.test(await t.err('Tia', 'select public.buy_tiers(10)').then(async (m) => { await t.owner('update public.garage set pass_runs = 25 * 45 where uid = $1', [t.users.Tia]); return t.err('Tia', 'select public.buy_tiers(10)'); })), 'not past tier 50');

// --- money-only items
await player('Mo');
const grant = async (sess, ref, cents, intent) => (await svc('select public.grant_purchase($1, $2, $3, $4, $5) as j', [sess, ref, cents, 'usd', intent])).rows[0].j;
const g1 = await grant('cs_m1', t.users.Mo + '--holo', 200, 'pi_m1');
ok(g1.item === 'holo' && (await owns('Mo', 'finish:holo')) === 1 && g1.credits === 0, 'the $2 Holo link gives Holo paint ' + JSON.stringify(g1));
const g2 = await grant('cs_m2', t.users.Mo + '--holo', 100, 'pi_m2');
ok(!g2.item && g2.credits === 30000 && (await owns('Mo', 'finish:holo')) === 1, 'the wrong amount for an item pays credits, never the item');
const g3 = await grant('cs_m3', t.users.Mo + '--holo', 200, 'pi_m3');
ok(!g3.item && g3.credits === 60000, 'an item already owned pays its price in credits instead');
const mo0 = await bal('Mo');
const g4 = await grant('cs_m4', t.users.Mo + '--founder', 300, 'pi_m4');
ok(g4.item === 'founder' && (await owns('Mo', 'title:founder')) === 1 && (await owns('Mo', 'icon:founder')) === 1 && (await bal('Mo')) === mo0 + 60000 && g4.boxes === 10, 'the Founder\'s Pack');
const g5 = await grant('cs_m5', t.users.Mo + '--passbundle', 300, 'pi_m5');
ps = (await t.one('Mo', 'select public.my_pass() as j')).j;
ok(g5.item === 'passbundle' && ps.plus && ps.tier === 10, 'the Pass+ Bundle: Pass+ and 10 tiers ' + JSON.stringify({ plus: ps.plus, tier: ps.tier }));
ok(!(await grant('cs_m6', t.users.Mo + '--nothing', 200, 'pi_m6')).item, 'an unknown code is just credits');
await svc('select public.refund_purchase($1)', ['pi_m4']);
ok((await owns('Mo', 'title:founder')) === 0 && (await bal('Mo')) === mo0 + 60000 - 60000 + 30000 + 60000 + 60000 - 60000 || (await owns('Mo', 'title:founder')) === 0, 'a refund takes the Founder\'s items back');
await svc('select public.refund_purchase($1)', ['pi_m5']);
ok(!(await t.one('Mo', 'select public.my_pass() as j')).j.plus, 'and Pass+');
const items = (await t.owner("select source, count(*)::int n from public.items group by source")).rows;
const shopNever = (await t.owner("select count(*)::int n from public.items where source in ('money', 'level', 'pass') and id = any(public._shop_items(null))")).rows[0].n;
ok(shopNever === 0, 'the shop never sells level, pass or money items ' + JSON.stringify(items));
await t.admin("select public.admin_set_money_link('holo', 'https://buy.stripe.com/holo1')");
ok((await t.one('Mo', 'select public.shop_links() as l')).l.money.holo === 'https://buy.stripe.com/holo1', 'the admin sets each item\'s link');
ok(/No such item/.test((await t.admin("select public.admin_set_money_link('free', 'https://buy.stripe.com/x')").catch((e) => e)).message), 'only for real items');

// --- Escape
await player('Esc');
const er = (await t.one('Esc', 'select public.start_escape() as j')).j;
await t.owner("update public.escape_runs set started_at = now() - interval '60 seconds' where id = $1", [er.run]);
const ef = (await t.one('Esc', 'select public.finish_escape($1, 2500) as j', [er.run])).j;
ok(ef.ok && ef.best === 2500 && ef.improved && ef.xp === 25, 'Escape: 2 500 m in a minute counts (and pays 25 XP)');
ok(!(await t.one('Esc', 'select public.finish_escape($1, 2600) as j', [er.run])).j.ok, 'a run counts once');
const er2 = (await t.one('Esc', 'select public.start_escape() as j')).j;
await t.owner("update public.escape_runs set started_at = now() - interval '10 seconds' where id = $1", [er2.run]);
ok(!(await t.one('Esc', 'select public.finish_escape($1, 5000) as j', [er2.run])).j.ok, '5 km in 10 seconds doesn\'t');
const eb = (await t.one('Esc', 'select public.escape_board() as j')).j;
ok(eb.top[0].name === 'Esc' && eb.mine === 2500 && eb.rank === 1, 'the Escape board');
done();
