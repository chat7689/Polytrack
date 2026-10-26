// Track data from the game's track builder ("Copy track data") into a
// season map: checks it the way the builder does, runs the test drivers on
// it, and prints a LEVELS entry to paste into index.html (NEXT_LEVELS for a
// next season, LEVELS for this one).
// Usage: node track2level.js <id> <section 0-3> "<track data>" ["blurb"]
//    or: node track2level.js <id> <section> @file.txt ["blurb"]
const fs = require('fs');
const h = require('./harness.js'); const m = h.load(); const B = require('./bot.js'); const K = m.TrackKit;
const [id, sec, raw, blurb] = process.argv.slice(2);
if (!id || sec === undefined || !raw) { console.log('Usage: node track2level.js <id> <section 0-3> "<track data>" ["blurb"]'); process.exit(1); }
const text = raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw;
const t = K.decode(text);
if (t.error) { console.log('Not track data:', t.error); process.exit(1); }
const c = K.check(t);
if (!c.ok) { console.log('The builder would refuse it:', c.error); process.exit(1); }
console.log('// ' + (c.len / 1000).toFixed(2) + ' km, ' + t.pieces.length + ' pieces');
for (const o of [{ aggr: 0.8 }, { aggr: 1 }, { aggr: 1.3, boost: 1 }, { aggr: 1.15, lane: 0.8 }]) {
  const r = B.run(m, c.data, o);
  console.log('// test driver ' + JSON.stringify(o) + ': ' + (r.finished ? r.time.toFixed(2) + ' s' : 'FAIL ' + r.fail + ' at ' + Math.round((r.progress || 0) * 100) + '%'));
}
const q = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
console.log(`  {
    id: ${q(id)}, section: ${+sec}, name: ${q(t.name || id)},
    blurb: ${q(blurb || '')},
    build() {
      return TrackKit.build({ w: ${t.w}, pieces: ${JSON.stringify(t.pieces).replace(/"/g, "'")} });
    }
  },`);
