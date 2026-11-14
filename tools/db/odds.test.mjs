// The box odds, measured: 8 000 boxes opened, every kind comes out about as
// often as the garage says, every item in a kind about equally often, every
// box item (Slick too) can come out, and nothing that isn't a box item ever
// does.
import { makeDb, ok, done } from './db.mjs';
const t = await makeDb();
await t.owner("insert into public.access_codes (code, label, expires_at) values ('OPENOPEN', 'tests', now() + interval '1 day')");
await t.mkUser('Odds');
await t.one('Odds', "select public.redeem_access('OPENOPEN') as j");
const N = 8000;
await t.owner('insert into public.garage (uid, free_boxes) values ($1, $2) on conflict (uid) do update set free_boxes = excluded.free_boxes', [t.users.Odds, N]);
const leaves = [];
for (let k = 0; k < N / 500; k++) {
  const rows = (await t.as('Odds', 'select public.open_box(true) as j from generate_series(1, 500)')).rows;
  for (const r of rows) for (const x of r.j.results) if (!x.split) leaves.push(x);
}
const kindOf = (x) => x.kind || (x.hue !== undefined ? 'rest' : 'rest');
const count = {};
for (const x of leaves) count[kindOf(x)] = (count[kindOf(x)] || 0) + 1;
// the garage's numbers are for each roll; a box that splits isn't a prize, so among prizes each is pct / 90
// (a little less, as boxes 3 splits deep can't split and give the rest instead)
const odds = (await t.owner('select public.box_odds() as j')).rows[0].j;
const L = leaves.length;
for (const k of ['car', 'anim', 'decal', 'cel', 'boost', 'wheel', 'title', 'icon']) {
  const want = odds[k] / 90, got = (count[k] || 0) / L, sd = Math.sqrt(want * (1 - want) / L);
  ok(Math.abs(got - want) < 4 * sd, k + ': ' + (got * 100).toFixed(2) + '% of prizes, the garage says ' + odds[k] + '% of rolls (' + (want * 100).toFixed(2) + '% of prizes)');
}
ok(Math.abs((count.rest || 0) / L - 0.5 / 0.9) < 0.02, 'credits or a hue: ' + ((count.rest || 0) / L * 100).toFixed(1) + '% of prizes');
// every box item can come out, and only box items do
const items = (await t.owner('select id, kind, source from public.items')).rows;
const seen = {};
for (const x of leaves) if (x.item) seen[x.item] = (seen[x.item] || 0) + 1;
const boxItems = items.filter((i) => i.source === 'box');
const never = boxItems.filter((i) => !seen[i.id]).map((i) => i.id);
ok(never.length === 0, 'every one of the ' + boxItems.length + ' box items came out at least once' + (never.length ? ': not ' + never.join(', ') : ''));
ok(seen['title:slick'] > 0, 'Slick came out ' + (seen['title:slick'] || 0) + ' times');
const wrong = Object.keys(seen).filter((id) => (items.find((i) => i.id === id) || {}).source !== 'box');
ok(wrong.length === 0, 'no shop, pass, level or money item ever came out of a box ' + wrong.join(', '));
// within a kind, every item about as often as the others (chi-square, 99.9%)
const CHI = { 7: 24.3, 15: 37.7, 16: 39.3 };
for (const k of ['car', 'anim', 'decal', 'cel', 'boost', 'wheel', 'title', 'icon']) {
  const list = boxItems.filter((i) => i.kind === k);
  const n = list.reduce((a, i) => a + (seen[i.id] || 0), 0), e = n / list.length;
  const chi = list.reduce((a, i) => a + ((seen[i.id] || 0) - e) ** 2 / e, 0);
  ok(chi < CHI[list.length - 1], k + ': each of the ' + list.length + ' about equally likely (chi-square ' + chi.toFixed(1) + ' for ' + n + ')');
}
done();
