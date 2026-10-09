# Map tools (run with Node; not part of the game)

`npm i three@0.128.0` in this folder first. Everything loads the real physics,
track builder and maps straight out of `../../index.html`.

- `node check_next.js [s3c1 ...] [quick]` — next season's maps: layout problems
  (roads touching, a road buried under another's earth bank, crossings without
  a bridge) and the test driver at several levels (finish, time, checkpoints,
  roll, scraping, landings).
- `node plan.js s3c7` — where a map's road goes, and where it crosses itself.
- `node dbg.js s3c6 600 800` — the test driver's trace between two distances.
- `node gen_rules2.js [seasonOnly]` — the server's map rules (start, finish,
  checkpoints, fastest believable time) for `supabase/schema.sql`. Run it when
  maps are released or changed; dailies are generated through 2027-12-31.
