// The server's recording check against real test-driver runs on every live
// map (make recs.json first: cd ../sim && node recs.js > ../db/recs.json).
import { readFileSync } from 'fs';
import { makeDb, ok, done } from './db.mjs';
const t = await makeDb();
const recs = JSON.parse(readFileSync(new URL('./recs.json', import.meta.url), 'utf8'));
for (const r of recs) {
  if (r.dnf) { console.log('(skipped: a test driver did not finish ' + r.id + ', so there is no run to check)'); continue; }
  const g = (await t.owner('select public._ghost_check($1, $2, $3) as g', [r.id, r.ms, r.samples])).rows[0].g;
  ok(g.ok && !(g.flags || []).length, r.id + ' ' + (r.ms / 1000).toFixed(3) + ' s: ' + JSON.stringify(g));
}
done();
