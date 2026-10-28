// The garage's boxes, end to end: the chances, splitting (never past 8
// boxes), credits and hue packs, selling (and that buying and selling can
// never make credits), loadouts, the guard on colours and loadouts, free
// boxes for finishing runs, and Coach's unbox news.
import { makeDb, ok, done } from './db.mjs';
const t = await makeDb();
const give = (name, n) => t.owner("insert into public.credit_events (uid, delta, kind) values ($1, $2, 'adjust')", [t.users[name], n]);
const bal = async (name) => Number((await t.owner('select public._balance($1) as b', [t.users[name]])).rows[0].b);
const open = async (name, free) => (await t.one(name, 'select public.open_box($1) as j', [!!free])).j;

// --- the arithmetic: selling everything a box gives is worth less than the box
const odds = (await t.owner('select public.box_odds() as j')).rows[0].j;
const items = (await t.owner('select kind, sell, count(*) over (partition by kind) n from public.items')).rows;
const sellOf = (k) => Number(items.find((i) => i.kind === k).sell);
for (const k of ['car', 'anim', 'decal', 'cel', 'boost', 'wheel', 'title', 'icon']) ok(items.every((i) => i.kind !== k || Number(i.sell) === sellOf(k)), 'every ' + k + ' sells for the same: ' + sellOf(k));
ok(items.filter((i) => i.kind === 'car').length === 8 && items.filter((i) => i.kind === 'decal').length === 8 && items.filter((i) => i.kind === 'anim').length === 8
  && items.filter((i) => i.kind === 'boost').length === 16 && items.filter((i) => i.kind === 'wheel').length === 16
  && items.filter((i) => i.kind === 'title').length === 16 && items.filter((i) => i.kind === 'icon').length === 16, '8 cars, 8 decals, 8 animated, 16 boosts, wheels, titles and icons');
const credAvg = (odds.credits[0] + odds.credits[1]) / 2;
for (const allHues of [false, true]) {
  const a = ['car', 'anim', 'decal', 'cel', 'boost', 'wheel', 'title', 'icon'].reduce((s, k) => s + odds[k] / 100 * sellOf(k), 0)
    + odds.rest / 100 * (0.5 * credAvg + 0.5 * (allHues ? credAvg : 0));
  const deepest = a + odds.split / 100 * (0.5 * credAvg + 0.5 * (allHues ? credAvg : 0));
  let v = deepest;
  for (let k = 0; k < 3; k++) v = a + 2 * odds.split / 100 * v;
  console.log('expected back from selling everything in one box' + (allHues ? ' (every hue owned)' : '') + ': ' + v.toFixed(2));
  ok(v < odds.price, 'sell everything from a box: ' + v.toFixed(2) + ' credits back on average for ' + odds.price + (allHues ? ' (every hue owned)' : '') + ', so no profit');
}
ok(odds.split + odds.car + odds.anim + odds.decal + odds.cel + odds.boost + odds.wheel + odds.title + odds.icon + odds.rest === 100, 'the chances add up to 100');

// --- buying boxes
await t.mkUser('Rich');
ok(/100 credits/.test(await t.err('Rich', 'select public.open_box(false)')), 'no credits, no box');
ok(/free boxes/i.test(await t.err('Rich', 'select public.open_box(true)')), 'no free box yet either');
await give('Rich', 1000000);
const N = 2500;
const tally = {}, hues = new Set();
let first = null, maxBoxes = 0, splits = 0, credits = 0, boxesTotal = 0, depth0 = 0;
const b0 = await bal('Rich');
for (let k = 0; k < N; k++) {
  const r = await open('Rich');
  if (!first) first = r;
  maxBoxes = Math.max(maxBoxes, r.boxes);
  boxesTotal += r.boxes;
  for (const x of r.results) {
    if (x.split) { splits++; continue; }
    const kind = x.kind || (x.hue !== undefined ? 'hue' : 'credits');
    tally[kind] = (tally[kind] || 0) + 1;
    if (x.credits) { credits += x.credits; ok(x.credits >= 1 && x.credits <= 25, 'credits 1-25'); }
    if (x.hue !== undefined) hues.add(x.hue);
  }
}
const b1 = await bal('Rich');
ok(b1 === b0 - N * 100 + credits, 'each box costs 100, and the credits in them are paid: ' + (b0 - b1) + ' spent');
ok(maxBoxes <= 8, 'a box never becomes more than 8: most seen ' + maxBoxes);
const opened = (await t.owner('select opened from public.garage where uid = $1', [t.users.Rich])).rows[0].opened;
ok(opened === boxesTotal, 'every box counted (' + boxesTotal + ' from ' + N + ' bought)');
const outcomes = boxesTotal + splits;                      // every box rolled: a split, or one thing
const pct = (k) => 100 * (tally[k] || 0) / outcomes;
const near = (k, want, tol) => ok(Math.abs(pct(k) - want) <= tol, k + ': ' + pct(k).toFixed(2) + '% (want about ' + want + '%)');
near('car', 1, 0.6); near('anim', 2, 0.9); near('decal', 3, 1.1); near('cel', 4, 1.2); near('boost', 5, 1.4); near('wheel', 5, 1.4);
near('title', 10, 1.9); near('icon', 10, 1.9);
ok(Math.abs(100 * splits / outcomes - 9.6) < 1.5, 'splits: ' + (100 * splits / outcomes).toFixed(1) + '% of boxes (10% of the ones that can still split)');
ok(Math.abs(pct('credits') + pct('hue') - 51) < 3.5, 'credits or a hue: ' + (pct('credits') + pct('hue')).toFixed(1) + '%');
const unl = (await t.owner('select unlocked from public.car_customization where uid = $1', [t.users.Rich])).rows[0].unlocked;
ok(hues.size === (tally.hue || 0) && unl.length === hues.size, 'every hue pack is a new hue, added to the list: ' + hues.size);

// --- selling: everything, back to credits
const inv = (await t.one('Rich', 'select public.my_garage() as j')).j.inventory;
let sellAll = 0;
const price = Object.fromEntries((await t.owner('select id, sell from public.items')).rows.map((r) => [r.id, r.sell]));
await t.one('Rich', 'select public.set_loadout($1) as j', [{ car: inv.find((i) => i.item.startsWith('car:')).item, title: inv.find((i) => i.item.startsWith('title:')).item }]);
for (const i of inv) { const r = (await t.one('Rich', 'select public.sell_item($1, $2) as j', [i.item, i.count])).j; sellAll += r.credits; ok(r.credits === price[i.item] * i.count, 'sold ' + i.item); }
const b2 = await bal('Rich');
ok(b2 === b1 + sellAll, 'selling pays the price of each');
console.log('boxes: ' + N + ' bought gave ' + boxesTotal + ' (most from one: ' + maxBoxes + '); car ' + pct('car').toFixed(2) + '%, animated ' + pct('anim').toFixed(2) + '%, decal ' + pct('decal').toFixed(2) + '%; selling everything got back ' + ((sellAll + credits) / N).toFixed(1) + ' credits a box');
ok(b2 < b0, 'buying ' + N + ' boxes and selling everything loses credits: ' + (b2 - b0) + ' (' + ((b0 - b2) / N).toFixed(1) + ' a box)');
ok((await t.one('Rich', 'select public.my_garage() as j')).j.inventory.length === 0, 'nothing left');
const lo = (await t.one('Rich', 'select public.my_garage() as j')).j.loadout;
ok(!lo.car && !lo.title, 'what was on comes off when the last one is sold ' + JSON.stringify(lo));
ok(/that many/.test(await t.err('Rich', "select public.sell_item('car:wedge', 1)")), 'can\'t sell what you don\'t have');
ok(/can't be sold/.test(await t.err('Rich', "select public.sell_item('hue:3', 1)")), 'hues can\'t be sold');

// --- every hue owned: a hue result becomes credits
await t.mkUser('Full');
await give('Full', 100000);
await t.owner(`with s as (select set_config('app.garage', 'on', true) x)
  insert into public.car_customization (uid, unlocked, primary_color, secondary_color)
  select $1, (select jsonb_agg(c) from generate_series(0, 255) c), '{"h":0,"s":80,"l":55}', '{"h":10,"s":60,"l":37}' from s`, [t.users.Full]);
ok((await t.owner('select jsonb_array_length(unlocked) n from public.car_customization where uid = $1', [t.users.Full])).rows[0].n === 256, 'Full owns all 256 hues');
let fullHue = 0;
for (let k = 0; k < 150; k++) for (const x of (await open('Full')).results) if (x.hue !== undefined) fullHue++;
ok(fullHue === 0, 'with every hue owned, no hue packs: credits instead');

// --- loadouts and the guard
await t.mkUser('Pat');
await give('Pat', 100000);
let got = null;
for (let k = 0; k < 400 && !got; k++) for (const x of (await open('Pat')).results) if (x.kind === 'wheel') got = x.item;
ok(got, 'Pat unboxes a wheel');
const L = (await t.one('Pat', 'select public.set_loadout($1) as j', [{ wheel: got, title: 'season', num: 140 }])).j;
ok(L.wheel === got && L.title === 'season' && L.num === 99, 'an owned wheel goes on; the season title is allowed; the number is kept to 0-99 ' + JSON.stringify(L));
const patOwns = (await t.one('Pat', 'select public.my_garage() as j')).j.inventory.map((i) => i.item);
const notCar = ['car:wedge', 'car:gt', 'car:proto', 'car:rally', 'car:muscle', 'car:stinger', 'car:bulldog', 'car:manta'].find((c) => !patOwns.includes(c));
ok(/own that/.test(await t.err('Pat', 'select public.set_loadout($1)', [{ car: notCar }])), 'a car you don\'t own can\'t go on');
const before9 = (await t.owner('select unlocked from public.car_customization where uid = $1', [t.users.Pat])).rows[0].unlocked;
await t.as('Pat', `update public.car_customization set loadout = $1, unlocked = '[1,2,3,4,5,6,7,8,9,10,11,12]' where uid = auth.uid()`, [{ car: notCar }]);
const row = (await t.owner('select loadout, unlocked from public.car_customization where uid = $1', [t.users.Pat])).rows[0];
ok(row.loadout.car !== notCar && JSON.stringify(row.unlocked) === JSON.stringify(before9), 'a player can\'t write their own loadout or hue list ' + JSON.stringify(row));
const cells = row.unlocked.filter((x) => typeof x === 'number');
const curCell = Math.round((await t.owner('select primary_color from public.car_customization where uid = $1', [t.users.Pat])).rows[0].primary_color.h * 256 / 360) % 256;
const notMine = [...Array(256).keys()].find((c) => !cells.includes(c) && c !== curCell && c > 3);
const h = Math.round(notMine * 360 / 256);
await t.as('Pat', `update public.car_customization set primary_color = $1 where uid = auth.uid()`, [{ h, s: 70, l: 50 }]);
ok((await t.owner('select primary_color from public.car_customization where uid = $1', [t.users.Pat])).rows[0].primary_color.h !== h, 'a hue you don\'t own can\'t go on the car');
if (cells.length) {
  const own = Math.round(cells[0] * 360 / 256);
  await t.as('Pat', `update public.car_customization set primary_color = $1 where uid = auth.uid()`, [{ h: own, s: 70, l: 50 }]);
  ok((await t.owner('select primary_color from public.car_customization where uid = $1', [t.users.Pat])).rows[0].primary_color.h === own, 'one you own can');
}
ok(/boxes now/.test(await t.err('Pat', 'select public.buy_color()')), 'hue packs can\'t be bought any more');
await t.mkUser('Newbie');
await t.as('Newbie', `insert into public.car_customization (uid, unlocked, primary_color, secondary_color) values (auth.uid(), '[1,2,3,4,5]', '{"h":3,"s":60,"l":50}', '{"h":200,"s":60,"l":40}')`);
const nb = (await t.owner('select unlocked from public.car_customization where uid = $1', [t.users.Newbie])).rows[0].unlocked;
ok(nb.length === 2, 'a new account starts with its two starter hues, not more ' + JSON.stringify(nb));

// --- free boxes: one every 50 counted finishes
await t.mkUser('Grinder');
await t.owner("insert into public.access_codes (code, label, expires_at) values ('BOXTEST', 'tests', now() + interval '1 day')");
await t.one('Grinder', "select public.redeem_access('BOXTEST') as j");
await t.owner('insert into public.garage (uid, runs) values ($1, 48)', [t.users.Grinder]);
let last = null;
for (let k = 0; k < 2; k++) {
  const s = (await t.one('Grinder', "select public.start_run('s4c1', $1, 'fp', false) as j", ['d'.repeat(32)])).j;
  await t.owner("update public.runs set started_at = now() - interval '30 seconds' where id = $1", [s.run]);
  last = (await t.one('Grinder', 'select public.finish_run($1, 20000, 100, false) as j', [s.run])).j;
}
ok(last.ok && last.free_box === true && last.box_runs === 0, 'the 50th finish earns a free box ' + JSON.stringify(last));
const fb = await open('Grinder', true);
ok(fb.results.length >= 1 && fb.free_boxes === 0, 'and it opens without spending credits');
ok(/free boxes/i.test(await t.err('Grinder', 'select public.open_box(true)')), 'only one');

// --- Coach's news
const news0 = (await t.one('Pat', 'select public.unbox_news(null) as j')).j;
const cars = (await t.owner("select count(*)::int n from public.unbox_news where kind in ('car', 'anim')")).rows[0].n;
ok(cars > 0 && news0.last > 0 && news0.news.length === 0, 'cars and animated decals make news (' + cars + '); the first ask just learns where it is');
const before = news0.last;
let made = false;
await give('Pat', 200000);
for (let k = 0; k < 600 && !made; k++) for (const x of (await open('Pat')).results) if (x.kind === 'car' || x.kind === 'anim') made = true;
const news1 = (await t.one('Rich', 'select public.unbox_news($1) as j', [before])).j;
ok(made && news1.news.some((n) => n.name === 'Pat' && (n.kind === 'car' || n.kind === 'anim')), 'everyone hears about it: ' + JSON.stringify(news1.news.slice(-1)));

// --- only the admin sees the totals
ok((await t.admin('select public.admin_box_stats() as j')).rows[0].j.opened >= N, 'the admin sees how many boxes were opened');
ok(/admin/i.test(await t.err('Pat', 'select public.admin_box_stats()')), 'players don\'t');
ok((await t.as('Pat', 'select * from public.inventory')).rows.every((r) => r.uid === t.users.Pat), 'players only see their own items');
done();
