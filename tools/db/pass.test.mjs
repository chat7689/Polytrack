// Paint finishes, the daily shop and the Race Pass: what boxes can hold,
// the shop's six items and prices, buying (once, with enough credits, only
// today's), the pass's tiers and both tracks, buying Pass+, claiming once,
// a new season starting the pass again, and that nothing pays more to sell
// than it cost.
import { makeDb, ok, done } from './db.mjs';
const t = await makeDb();
await t.owner("insert into public.access_codes (code, label, expires_at) values ('OPENOPEN', 'tests', now() + interval '1 day')");
const bal = async (name) => Number((await t.owner('select public._balance($1) as b', [t.users[name]])).rows[0].b);
const give = (name, n) => t.owner("insert into public.credit_events (uid, delta, kind, note) values ($1, $2, 'admin', 'test')", [t.users[name], n]);
const owns = async (name, item) => (await t.owner('select coalesce((select count from public.inventory where uid = $1 and item = $2), 0) as n', [t.users[name], item])).rows[0].n;
const boxes = async (name) => (await t.owner('select coalesce((select free_boxes from public.garage where uid = $1), 0) as n', [t.users[name]])).rows[0].n;

// --- items
const items = (await t.owner('select id, kind, source, sell from public.items')).rows;
ok(items.length === 123, '97 box items, 6 shop finishes, 12 pass items, 8 driver-level items, 2 money-only items = ' + items.length);
ok(items.filter((i) => i.kind === 'finish').length === 12 && items.filter((i) => i.source === 'pass').length === 12, 'finishes and pass-only items');
ok(items.filter((i) => i.source === 'box').length === 97, 'boxes hold the 96 from before and Slick');
await t.mkUser('Box');
await t.one('Box', "select public.redeem_access('OPENOPEN') as j");
await give('Box', 100 * 400);
for (let k = 0; k < 400; k++) await t.one('Box', 'select public.open_box(false) as j');
const got = (await t.owner("select i.source, count(*)::int n from public.inventory v join public.items i on i.id = v.item where v.uid = $1 group by i.source", [t.users.Box])).rows;
ok(got.length === 1 && got[0].source === 'box', 'no box ever holds a shop or pass item (400 boxes) ' + JSON.stringify(got));

// --- the shop
await t.mkUser('Sam');
const shop = (await t.one('Sam', 'select public.shop_today() as j')).j;
ok(shop.items.length === 6, 'six items today ' + shop.items.map((i) => i.item).join(', '));
ok(shop.items[0].kind === 'car' && shop.items[1].kind === 'finish' && shop.items[2].kind === 'anim', 'a car, a paint finish and an animated decal first');
ok(!shop.items.some((i) => /pass|neon|chrome/.test(i.item)), 'never a pass-only item');
const days = new Set();
for (const d of ['20261112', '20261113', '20261114', '20261115']) days.add((await t.owner('select public._shop_items($1) as a', [d])).rows[0].a.join());
ok(days.size >= 3, 'it changes from day to day');
ok((await t.owner("select public._shop_items('20261112') = public._shop_items('20261112') as s")).rows[0].s, 'and is the same for everyone on a day');
const car = shop.items[0];
ok(car.price === 12000 && !car.owned, 'a car costs 12 000');
ok(/costs 12000/.test(await t.err('Sam', 'select public.buy_item($1)', [car.item])), 'not without the credits');
await give('Sam', 20000);
const b1 = (await t.one('Sam', 'select public.buy_item($1) as j', [car.item])).j;
ok(b1.ok && b1.price === 12000 && (await bal('Sam')) === 8000 && (await owns('Sam', car.item)) === 1, 'bought: 12 000 off, the car owned');
ok(/already own/.test(await t.err('Sam', 'select public.buy_item($1)', [car.item])), 'not twice');
ok((await t.one('Sam', 'select public.shop_today() as j')).j.items[0].owned === true, 'the shop shows it owned');
ok(/isn't in the shop today/.test(await t.err('Sam', "select public.buy_item('finish:chrome')")), 'pass items can\'t be bought');
const notToday = items.find((i) => i.source === 'box' && i.kind === 'car' && i.id !== car.item);
ok(/isn't in the shop today/.test(await t.err('Sam', 'select public.buy_item($1)', [notToday.id])), 'nor anything not in today\'s six');
const fin = shop.items[1];
await t.one('Sam', 'select public.buy_item($1) as j', [fin.item]);
const lo = (await t.one('Sam', 'select public.set_loadout($1) as j', [JSON.stringify({ finish: fin.item })])).j;
ok(lo.finish === fin.item, 'a paint finish goes on the car');
ok(/own that/.test(await t.err('Sam', 'select public.set_loadout($1)', [JSON.stringify({ finish: 'finish:chrome' })])), 'only one you own');
// nothing sells for more than it costs
const worst = (await t.owner('select max(sell::float / public._shop_price(kind)) as r from public.items')).rows[0].r;
ok(worst < 0.15, 'every item sells back for well under its shop price (' + worst.toFixed(3) + ')');

// --- the pass
await t.mkUser('Pia');
await t.one('Pia', "select public.redeem_access('OPENOPEN') as j");
let pass = (await t.one('Pia', 'select public.my_pass() as j')).j;
ok(pass.tier === 0 && pass.tiers === 50 && pass.perTier === 25 && pass.price === 30000 && !pass.plus && pass.rewards.length === 50, 'a fresh pass ' + JSON.stringify({ ...pass, rewards: pass.rewards.length }));
ok(pass.rewards[4].free.boxes === 1 && pass.rewards[3].free.credits === 100 && pass.rewards[29].plus.item === 'finish:chrome', 'the rewards');
// 3 finishes count
for (let k = 0; k < 3; k++) {
  const s = (await t.one('Pia', "select public.start_run('s4c1', $1, 'fp', false) as j", ['e'.repeat(32)])).j;
  await t.owner("update public.runs set started_at = now() - interval '30 seconds' where id = $1", [s.run]);
  const f = (await t.one('Pia', 'select public.finish_run($1, 20000, 100, false) as j', [s.run])).j;
  if (k === 2) ok(f.pass_runs === 3, 'finishes count toward the pass ' + f.pass_runs);
}
// jump to tier 6
await t.owner('update public.garage set pass_runs = 160 where uid = $1', [t.users.Pia]);
pass = (await t.one('Pia', 'select public.my_pass() as j')).j;
ok(pass.tier === 6, '160 finishes: tier 6');
const c0 = await bal('Pia'), bx0 = await boxes('Pia');
const cl = (await t.one('Pia', 'select public.claim_pass() as j')).j;
ok(cl.got.length === 6 && (await bal('Pia')) === c0 + 500 && (await boxes('Pia')) === bx0 + 1, 'the free track: 5 x 100 credits and a box ' + JSON.stringify(cl.got));
ok((await t.one('Pia', 'select public.claim_pass() as j')).j.got.length === 0, 'collected once');
ok(/Pass\+ costs 30000/.test(await t.err('Pia', 'select public.buy_pass()')), 'Pass+ needs 30 000 credits');
await give('Pia', 40000);
const c1 = await bal('Pia'), bx1 = await boxes('Pia');
const bp = (await t.one('Pia', 'select public.buy_pass() as j')).j;
ok(bp.got.length === 6 && bp.got.every((g) => g.plus), 'Pass+ collects the 6 tiers already reached at once');
ok((await bal('Pia')) === c1 - 30000 && (await boxes('Pia')) === bx1 + 5 && (await owns('Pia', 'title:pass-holder')) === 1, '30 000 off, 5 boxes and the Pass Holder title');
ok(/already have Pass\+/.test(await t.err('Pia', 'select public.buy_pass()')), 'bought once a season');
await t.owner('update public.garage set pass_runs = 10000 where uid = $1', [t.users.Pia]);
const all = (await t.one('Pia', 'select public.claim_pass() as j')).j;
ok(all.got.length === 88, 'the top of the pass: 44 more tiers on both tracks ' + all.got.length);
ok((await owns('Pia', 'finish:chrome')) === 1 && (await owns('Pia', 'finish:neon')) === 1 && (await owns('Pia', 'icon:pass-gem')) === 1, 'Chrome, Neon and the pass icons');
ok((await t.one('Pia', 'select public.my_pass() as j')).j.tier === 50, 'and it stops at tier 50');
ok(/permission denied/.test(await t.err('Pia', "select public._pass_give(auth.uid(), '{\"boxes\": 99}', 'x')")), 'no player can hand out rewards');
// a new season: the pass starts again
await t.owner("insert into public.season_awards (season, data) values ('final:Test season', '{}')");
pass = (await t.one('Pia', 'select public.my_pass() as j')).j;
ok(pass.tier === 0 && !pass.plus && pass.free_upto === 0, 'a season closes: a fresh pass, Pass+ to buy again');
const s = (await t.one('Pia', "select public.start_run('s4c1', $1, 'fp', false) as j", ['e'.repeat(32)])).j;
await t.owner("update public.runs set started_at = now() - interval '30 seconds' where id = $1", [s.run]);
ok((await t.one('Pia', 'select public.finish_run($1, 20000, 100, false) as j', [s.run])).j.pass_runs === 1, 'and counts from 1');
const st = (await t.admin('select public.admin_shop_stats() as j')).rows[0].j;
ok(st.shopCredits === 18000 && st.plus === 0, 'the admin sees shop takings ' + JSON.stringify(st));
done();
