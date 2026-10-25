// Steep and off-camber banks on player tracks: every turn size with each
// bank, driven by test drivers on the centre line, either side and slow,
// counting pops (the car thrown off the deck), scrapes and failures.
// Usage: node banks.js [bank ...]
const h = require('./harness.js'); const m = h.load(); const B = require('./bot.js'); const K = m.TrackKit;
const banks = process.argv.slice(2).map(Number);
const list = banks.length ? banks : [-20, -10, 45, 55, 70];
const drivers = [{ aggr: 1.3, boost: 1 }, { aggr: 1, lane: 0.6 }, { aggr: 1, lane: -0.6 }, { aggr: 1, vbank: 20, lane: 0.5 }];
let bad = 0, n = 0;
for (const bank of list) for (const [r] of K.RADII) for (const a of [45, 90, 180]) {
  const w = Math.min(15, 2 * (r - 8));
  const t = { w, pieces: [['S', 80, w], ['T', r, a, bank, 0, w], ['S', 80, w]] };
  const c = K.check(t);
  if (!c.ok) { console.log('bank', bank, 'R', r, a + '°', 'REFUSED', c.error); continue; }
  const res = drivers.map((o) => B.run(m, c.data, o));
  n++;
  const worst = res.reduce((acc, x) => ({ pops: Math.max(acc.pops, x.pops), scrape: Math.max(acc.scrape, x.scrape), fail: acc.fail || (!x.finished && x.fail) }), { pops: 0, scrape: 0, fail: '' });
  if (worst.pops || worst.scrape > 0.2 || worst.fail) { bad++; console.log('bank', bank, 'R', r, a + '°', 'pops', worst.pops, 'scrape', worst.scrape.toFixed(2), worst.fail || ''); }
}
console.log(n - bad, 'of', n, 'clean');
