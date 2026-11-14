// The Podium Pass ($3 on Stripe, money item 'podium'): 1 credit a minute
// for every season map the holder is top 3 on, for 14 days; buying again adds
// 14 days; a refund ends it and takes back what it paid. And the retired
// Pass+ Bundle.
import { makeDb, ok, done } from './db.mjs';
const t = await makeDb();
await t.owner("insert into public.access_codes (code, label, expires_at) values ('OPENOPEN', 'tests', now() + interval '1 day')");
const bal = async (n) => Number((await t.owner('select public._balance($1) as b', [t.users[n]])).rows[0].b);
const svc = (sql, params) => t.db.transaction(async (tx) => { await tx.exec('set local role service_role'); return tx.query(sql, params || []); });
const grant = async (sess, ref, cents, intent) => (await svc('select public.grant_purchase($1, $2, $3, $4, $5) as j', [sess, ref, cents, 'usd', intent])).rows[0].j;
async function player(n) { await t.mkUser(n); await t.one(n, "select public.redeem_access('OPENOPEN') as j"); }
const best = (n, course, ms, at, banned) => t.owner(
  'insert into public.bests (uid, course_id, display_name, banned, time_ms, updated_ms) values ($1, $2, $3, $4, $5, $6) ' +
  'on conflict (uid, course_id) do update set time_ms = excluded.time_ms, updated_ms = excluded.updated_ms, banned = excluded.banned',
  [t.users[n], course, n, !!banned, ms, at || 1]);
const pass = async (n) => (await t.owner('select * from public.podium_passes where uid = $1', [t.users[n]])).rows[0];
const back = (n, mins) => t.owner("update public.podium_passes set paid_to = now() - make_interval(secs => $2) where uid = $1", [t.users[n], mins * 60]);
const mine = async (n) => (await t.one(n, 'select public.my_podium_pass() as j')).j;

for (const n of ['Pia', 'Q1', 'Q2', 'Q3', 'Q4']) await player(n);
// Pia: 1st on s4m1, 2nd on s4m2, 3rd on s4m3, 4th on s4m4, 1st on a player track and an old season's map
await best('Pia', 's4m1', 20000); await best('Q1', 's4m1', 21000);
await best('Q1', 's4m2', 19000); await best('Pia', 's4m2', 20000); await best('Q2', 's4m2', 21000);
await best('Q1', 's4m3', 18000); await best('Q2', 's4m3', 19000); await best('Pia', 's4m3', 20000, 5); await best('Q3', 's4m3', 20000, 9);
await best('Q1', 's4m4', 17000); await best('Q2', 's4m4', 18000); await best('Q3', 's4m4', 19000); await best('Pia', 's4m4', 20000);
await best('Pia', 'u77', 10000); await best('Pia', 's3c1', 10000);

let m = await mine('Pia');
ok(!m.active && m.rate === 3 && m.maps.join() === 's4m1,s4m2,s4m3', 'without a pass: 3 podiums (a tie goes to whoever set it first) ' + JSON.stringify(m));

// --- buying it
const g1 = await grant('cs_p1', t.users.Pia + '--podium', 300, 'pi_p1');
let p = await pass('Pia');
ok(g1.ok && g1.item === 'podium' && g1.credits === 0 && p, 'the $3 link starts a Podium Pass ' + JSON.stringify(g1));
const days = (new Date(p.expires_at) - new Date(p.starts_at)) / 86400000;
ok(Math.abs(days - 14) < 0.001, 'for 14 days ' + days);
ok((await t.owner("select count(*)::int n from public.credit_events where uid = $1 and kind = 'purchase' and delta = 0", [t.users.Pia])).rows[0].n === 1,
  'and the game hears it arrived (a 0-credit purchase line)');

// --- paid by the minute
const b0 = await bal('Pia');
await back('Pia', 10);
m = await mine('Pia');
ok(m.active && m.rate === 3 && Number(m.earned) === 30 && (await bal('Pia')) === b0 + 30, '10 minutes on 3 podiums: 30 credits ' + JSON.stringify(m));
ok((await t.owner("select count(*)::int n from public.credit_events where uid = $1 and kind = 'podium_pass'", [t.users.Pia])).rows[0].n === 1, 'as a podium_pass credit line');
m = await mine('Pia');
ok(Number(m.earned) === 30 && (await bal('Pia')) === b0 + 30, 'asking again at once pays nothing more');
await back('Pia', 1.5);
await mine('Pia');
p = await pass('Pia');
const left = (Date.now() - new Date(p.paid_to)) / 1000;
ok(Number(p.earned) === 33 && left > 25 && left < 40, 'a minute and a half: one minute paid, the half carried over ' + left.toFixed(1) + 's');

// --- a podium lost stops paying
await back('Pia', 5);
await t.owner('select public._podium_pay(null)');                  // as submit_best does before a best changes
await best('Q2', 's4m1', 15000); await best('Q3', 's4m1', 16000); await best('Q4', 's4m1', 17000);
await back('Pia', 5);
m = await mine('Pia');
ok(m.rate === 2 && Number(m.earned) === 33 + 15 + 10, 'pushed off one podium: 5 min x 3, then 5 min x 2 ' + m.earned);
const src = (await t.owner("select pg_get_functiondef('public.submit_best(text,integer,text,smallint,uuid)'::regprocedure) d")).rows[0].d;
ok(/_podium_pay\(null\)[\s\S]*insert into public\.bests/.test(src), 'submit_best pays the passes before a season best changes');
// a banned driver ahead doesn't count
await best('Q4', 's4m2', 1000, 1, true);
ok((await mine('Pia')).rate === 2, 'a banned driver doesn\'t take a podium');
// only this season's maps (settings 'season_maps' once a new season is out)
await t.owner("insert into public.settings (key, value) values ('season_maps', '[\"s4m2\"]'::jsonb) on conflict (key) do update set value = excluded.value");
ok((await mine('Pia')).rate === 1, 'the season\'s maps come from settings when set');
await t.owner("delete from public.settings where key = 'season_maps'");

// --- expiry
await t.owner("update public.podium_passes set expires_at = now() - interval '1 minute', paid_to = now() - interval '11 minutes' where uid = $1", [t.users.Pia]);
const e0 = Number((await pass('Pia')).earned);
m = await mine('Pia');
ok(!m.active && Number(m.earned) === e0 + 20, 'an expired pass is paid up to its end and no further ' + (m.earned - e0));
m = await mine('Pia');
ok(Number(m.earned) === e0 + 20, 'and then nothing');

// --- buying again: restarts when over, adds 14 days while running
const b1 = await bal('Pia');
await grant('cs_p2', t.users.Pia + '--podium', 300, 'pi_p2');
p = await pass('Pia');
ok(Number(p.earned) === 0 && Math.abs((new Date(p.expires_at) - Date.now()) / 86400000 - 14) < 0.01, 'after it ran out, a new pass starts from now');
await grant('cs_p3', t.users.Pia + '--podium', 300, 'pi_p3');
p = await pass('Pia');
ok(Math.abs((new Date(p.expires_at) - Date.now()) / 86400000 - 28) < 0.01, 'bought while running: 14 more days');
ok((await bal('Pia')) === b1, 'buying pays no credits');

// --- refund
await back('Pia', 10);
await mine('Pia');
const b2 = await bal('Pia');
await svc('select public.refund_purchase($1)', ['pi_p3']);
p = await pass('Pia');
m = await mine('Pia');
ok(!m.active && (await bal('Pia')) === b2 - 20, 'a refund ends the pass and takes back what it paid ' + ((await bal('Pia')) - b2));
p = await pass('Pia');
ok(new Date(p.expires_at) <= Date.now() && Number(p.earned) === 0 && Number((await mine('Pia')).earned) === 0, 'and it pays nothing after');

// --- the wrong price, someone else's id, and who can call what
const g4 = await grant('cs_p4', t.users.Q1 + '--podium', 100, 'pi_p4');
ok(!g4.item && g4.credits === 30000 && !(await pass('Q1')), 'the wrong amount is credits, never the pass');
ok(/permission denied/.test(await t.err('Q1', 'select public._podium_pay(null)') || ''), 'players can\'t run the payout themselves');
ok(/permission denied/.test(await t.err('Q1', "select public._podium_start($1, 14)", [t.users.Q1]) || ''), 'or start a pass');
ok((await t.err('Q1', 'select public.my_podium_pass()')) === null, 'but anyone can see theirs');

// --- the Pass+ Bundle is retired
const g5 = await grant('cs_p5', t.users.Q2 + '--passbundle', 300, 'pi_p5');
ok(!g5.item && g5.credits === 90000, 'a payment on the old Pass+ Bundle link is paid as credits ' + JSON.stringify(g5));
ok(/No such item/.test(await (async () => { try { await t.admin("select public.admin_set_money_link('passbundle', 'https://buy.stripe.com/x1')"); return ''; } catch (e) { return e.message; } })()), 'the admin can\'t sell it again');
await t.admin("select public.admin_set_money_link('podium', 'https://buy.stripe.com/pod1')");
const links = (await t.one('Q1', 'select public.shop_links() as j')).j;
ok(links.money.podium === 'https://buy.stripe.com/pod1' && !('passbundle' in links.money), 'the Podium Pass link is in the shop ' + JSON.stringify(links.money));
const st = (await t.admin('select public.admin_shop_stats() as j')).rows[0].j;
ok(Number(st.podiumActive) === 0 && 'podiumPaid' in st, 'admin stats count passes ' + JSON.stringify({ a: st.podiumActive, p: st.podiumPaid }));
done();
