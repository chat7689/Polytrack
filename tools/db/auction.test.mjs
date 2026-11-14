// Limited items and auctions: 100 copies of each box and shop item at most
// (boxes skip what's sold out, the shop refuses it, selling one back frees
// a copy), pass/level/money items unlimited; listing, bidding (credits held,
// given back when outbid), the anti-snipe, buy-now, the 5% fee, unsold items
// coming back, cancelling, and that nothing can be duplicated.
import { makeDb, ok, done } from './db.mjs';
const t = await makeDb();
await t.owner("insert into public.access_codes (code, label, expires_at) values ('OPENOPEN', 'tests', now() + interval '1 day')");
const bal = async (n) => Number((await t.owner('select public._balance($1) as b', [t.users[n]])).rows[0].b);
const give = (n, c) => t.owner("insert into public.credit_events (uid, delta, kind, note) values ($1, $2, 'admin', 'test')", [t.users[n], c]);
const owns = async (n, item) => (await t.owner('select coalesce((select count from public.inventory where uid = $1 and item = $2), 0) as c', [t.users[n], item])).rows[0].c;
const left = async (item) => (await t.owner('select public._item_left($1) as l', [item])).rows[0].l;
async function player(n) { await t.mkUser(n); await t.one(n, "select public.redeem_access('OPENOPEN') as j"); }
for (const n of ['Sel', 'Bia', 'Bob', 'Cy']) await player(n);

// --- supply
const lim = (await t.owner("select source, count(*) filter (where max_supply = 100)::int lim, count(*)::int n from public.items group by source order by source")).rows;
ok(lim.every((r) => (['box', 'shop'].includes(r.source) ? r.lim === r.n : r.lim === 0)), 'box and shop items are limited to 100, pass/level/money ones aren\'t ' + JSON.stringify(lim));
ok((await left('title:slick')) === 100, '100 Slick titles left to find');
// 99 Slicks owned by someone already
await t.owner("insert into public.inventory (uid, item, count) values ($1, 'title:slick', 99)", [t.users.Cy]);
ok((await left('title:slick')) === 1, 'one left');
const sup = (await t.one('Sel', 'select public.item_supply() as j')).j;
ok(sup['title:slick'][0] === 99 && sup['title:slick'][1] === 100, 'the game sees 99 of 100 exist');
// every title but one sold out: boxes only give that one
await t.owner("insert into public.inventory (uid, item, count) select $1, id, 100 from public.items where kind = 'title' and source = 'box' and id <> 'title:slick' on conflict (uid, item) do update set count = 100", [t.users.Cy]);
await t.owner('insert into public.garage (uid, free_boxes) values ($1, 400) on conflict (uid) do update set free_boxes = 400', [t.users.Sel]);
const rows = (await t.as('Sel', 'select public.open_box(true) as j from generate_series(1, 400)')).rows;
const titles = rows.flatMap((r) => r.j.results).filter((x) => x.kind === 'title').map((x) => x.item);
ok(titles.length === 1 && titles[0] === 'title:slick', 'with every other title gone, boxes give the last Slick, once ' + JSON.stringify(titles));
ok((await left('title:slick')) === 0, 'now Slick is sold out');
const icons = rows.flatMap((r) => r.j.results).filter((x) => x.kind === 'icon').length;
ok(icons > 10, 'other kinds still come out (' + icons + ' icons)');
// selling one back frees a copy
await t.one('Cy', "select public.sell_item('title:slick', 1) as j");
ok((await left('title:slick')) === 1, 'selling a Slick back to the game frees a copy');
// the shop refuses a sold-out item
const sid = (await t.owner('select public._shop_items(null) as a')).rows[0].a[0];
await t.owner('insert into public.inventory (uid, item, count) values ($1, $2, 100) on conflict (uid, item) do update set count = 100', [t.users.Cy, sid]);
await give('Bob', 50000);
ok(/Sold out/.test(await t.err('Bob', 'select public.buy_item($1)', [sid])), 'the shop won\'t sell a sold-out item');
await t.owner('update public.inventory set count = 99 - (select coalesce(sum(count), 0) from public.inventory where item = $2 and uid <> $1) where uid = $1 and item = $2', [t.users.Cy, sid]);
ok((await t.one('Bob', 'select public.buy_item($1) as j', [sid])).j.ok, 'with one copy free, it will');
ok((await left(sid)) === 0, 'and that was the last');
// unlimited ones
ok((await left('finish:chrome')) > 1000000, 'pass rewards have no limit');

// --- auctions
await t.owner("insert into public.inventory (uid, item, count) values ($1, 'car:wedge', 1) on conflict (uid, item) do update set count = 1", [t.users.Sel]);
await t.one('Sel', 'select public.set_loadout($1) as j', [JSON.stringify({ car: 'car:wedge' })]);
const wedgeLeft = await left('car:wedge');
ok(/1, 6, 12, 24 or 48/.test(await t.err('Sel', "select public.list_auction('car:wedge', 1000, null, 3)")), 'auctions run 1 to 48 hours');
ok(/below the starting/.test(await t.err('Sel', "select public.list_auction('car:wedge', 1000, 500, 1)")), 'buy-now can\'t be under the start');
const l1 = (await t.one('Sel', "select public.list_auction('car:wedge', 1000, 5000, 1) as j")).j;
ok(l1.ok && (await owns('Sel', 'car:wedge')) === 0, 'Sel lists the Wedge: it leaves the garage');
ok((await t.owner('select loadout from public.car_customization where uid = $1', [t.users.Sel])).rows[0].loadout.car === undefined, 'and comes off the car');
ok((await left('car:wedge')) === wedgeLeft, 'a car up for auction still counts as existing');
ok(/don't have/.test(await t.err('Sel', "select public.list_auction('car:wedge', 1000, null, 1)")), 'it can\'t be listed twice');
ok(/own auction/.test(await t.err('Sel', 'select public.bid_auction($1, 2000)', [l1.id])), 'no bidding on your own');
await give('Bia', 10000);
ok(/at least 1000/.test(await t.err('Bia', 'select public.bid_auction($1, 900)', [l1.id])), 'the first bid is at least the start');
const bia0 = await bal('Bia');
await t.one('Bia', 'select public.bid_auction($1, 1000) as j', [l1.id]);
ok((await bal('Bia')) === bia0 - 1000, 'a bid holds the credits');
ok(/at least 1050/.test(await t.err('Bob', 'select public.bid_auction($1, 1020)', [l1.id])), 'the next bid is 5% more (at least 10)');
const bob0 = await bal('Bob');
await t.one('Bob', 'select public.bid_auction($1, 1200) as j', [l1.id]);
ok((await bal('Bia')) === bia0 && (await bal('Bob')) === bob0 - 1200, 'outbid: Bia gets hers back, Bob\'s are held');
const list = (await t.one('Cy', 'select public.auction_list(null) as j')).j;
ok(list.length === 1 && list[0].bid === 1200 && list[0].next === 1260 && list[0].bids === 2, 'everyone sees the auction ' + JSON.stringify(list[0]));
ok((await t.one('Bob', "select public.auction_list('car') as j")).j[0].leading === true, 'Bob sees he is winning');
ok(/Someone has bid/.test(await t.err('Sel', 'select public.cancel_auction($1)', [l1.id])), 'no cancelling once someone has bid');
// anti-snipe
await t.owner("update public.auctions set ends_at = now() + interval '30 seconds' where id = $1", [l1.id]);
await t.one('Bia', 'select public.bid_auction($1, 1500) as j', [l1.id]);
const ends = (await t.owner('select extract(epoch from ends_at - now()) s from public.auctions where id = $1', [l1.id])).rows[0].s;
ok(ends > 100, 'a last-minute bid adds 2 minutes (' + Math.round(ends) + ' s left)');
// it ends
await t.owner("update public.auctions set ends_at = now() - interval '1 second' where id = $1", [l1.id]);
const sel0 = await bal('Sel');
await t.one('Cy', 'select public.auction_list(null) as j');
ok((await owns('Bia', 'car:wedge')) === 1, 'time\'s up: the best bidder gets the car');
ok((await bal('Sel')) === sel0 + 1500 - 75, 'and the seller the bid less the 5% fee');
ok((await bal('Bob')) === bob0, 'the loser kept nothing held');
ok((await left('car:wedge')) === wedgeLeft, 'still the same number of Wedges in the world');
// buy-now
await t.owner("insert into public.inventory (uid, item, count) values ($1, 'anim:lava', 2) on conflict (uid, item) do update set count = 2", [t.users.Sel]);
const l2 = (await t.one('Sel', "select public.list_auction('anim:lava', 500, 3000, 24) as j")).j;
await give('Cy', 5000);
const cy0 = await bal('Cy');
const bn = (await t.one('Cy', 'select public.bid_auction($1, 999999) as j', [l2.id])).j;
ok(bn.bought && (await bal('Cy')) === cy0 - 3000 && (await owns('Cy', 'anim:lava')) === 1, 'buy-now: paid the buy-now price, not the bid typed, and it\'s Cy\'s at once');
// unsold comes back; cancel
const l3 = (await t.one('Sel', "select public.list_auction('anim:lava', 500, null, 1) as j")).j;
ok((await owns('Sel', 'anim:lava')) === 0, 'the last Lava is up');
await t.owner("update public.auctions set ends_at = now() - interval '1 second' where id = $1", [l3.id]);
await t.one('Sel', 'select public.my_auctions() as j');
ok((await owns('Sel', 'anim:lava')) === 1, 'no bids: it comes back');
const l4 = (await t.one('Sel', "select public.list_auction('anim:lava', 500, null, 6) as j")).j;
await t.one('Sel', 'select public.cancel_auction($1) as j', [l4.id]);
ok((await owns('Sel', 'anim:lava')) === 1, 'cancelled before any bid: it comes back');
const mine = (await t.one('Sel', 'select public.my_auctions() as j')).j;
ok(mine.selling.length === 4 && mine.selling.some((a) => a.status === 'sold' && a.fee === 75), 'Sel\'s auctions, with what each made ' + mine.selling.map((a) => a.status).join(','));
ok((await t.one('Bia', 'select public.my_auctions() as j')).j.winning.some((a) => a.status === 'sold'), 'Bia sees what she won');
// limits and safety
ok(/permission denied/.test(await t.err('Bob', "select public._auction_give(auth.uid(), 'car:gt')")), 'nobody can give themselves items');
const upd = await t.as('Bob', "update public.auctions set status = 'sold' returning id").catch((e) => ({ rows: [], err: e.message }));
ok(upd.rows.length === 0, 'nor touch the auctions directly (no row changes)');
await t.owner("insert into public.inventory (uid, item, count) values ($1, 'icon:star', 20) on conflict (uid, item) do update set count = 20", [t.users.Bob]);
for (let k = 0; k < 10; k++) await t.one('Bob', "select public.list_auction('icon:star', 100, null, 1) as j");
ok(/10 auctions/.test(await t.err('Bob', "select public.list_auction('icon:star', 100, null, 1)")), 'ten auctions running at most');
const st = (await t.admin('select public.admin_shop_stats() as j')).rows[0].j;
ok(st.auctionsOpen === 10 && st.auctionFees === 75 + 150, 'the admin sees the auctions and the fees ' + JSON.stringify(st));
done();
