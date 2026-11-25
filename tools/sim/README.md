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
- `node walls.js [s3c5 ...]` — maps with steep banks: off-centre, weaving and
  slow test drivers through them, counting pops (the car leaving the deck on a
  bank), scrapes and failures.
- `NEXT=1 node edges.js` — every map with drivers hugging either edge (compare
  with `node edges.js`, the live season, for a baseline).
- `node run.js s3c6 '[{"aggr":1.15,"lane":0.8}]'` — one map, chosen drivers.
- `node trace.js s3c5 '{"aggr":1,"lane":0.6}' 560 640` — a trace (speed,
  height, lane, wheel compression and loads) between two distances.
- `node where.js s3c6 x,y,z` — which part of the road a world position is
  next to; `node frames.js s3c6 400 470` — the road's frames between two
  distances; `node high_corners.js` — tight corners high above the ground;
  `node crossings.js` — any road passing over or under another (the user
  doesn't want any).
- `node live_sum.js` — the live season's test-driver total, for comparison.
- `node jumpwall.js [s5c10]` — falls short of every jump on purpose (coasting
  off each takeoff at speeds from far too slow to just enough, middle and both
  sides) and checks the car never travels inside the landing deck or its beam.
  Maps with `legacyHull` (the live season, until it closes) are skipped unless
  named.
- `VARIANT=... node variant.js s4m1,s4m12` with `SRC=` pointing at a copy of
  index.html — the test driver on chosen maps against a changed copy, to find
  which change moves a time.
- `node city_check.js [quick]` — the open-world city (`maps/city.js` with
  `maps/eugene.js`), without a browser: builds it; checks every flat layer
  stands clear of the ground, every street can be reached from the start, the
  real car drives every street both ways at two speeds without falling
  through, getting stuck or ending up inside a building, head-on hits on walls
  stay outside them, crashes into trees (dead centre, half way out and just
  clipping, at three speeds) never end inside a trunk or wedged, wild drives
  from spots all over the map never end inside a building, under the ground
  or wedged, and no two differently coloured faces share a plane (flicker).
  `quick` drives one street in six and far fewer crashes (about a minute; the
  full run takes a good quarter of an hour).
- `city_view.js` — load it into a test copy of the game in the browser (it
  needs `window.T` with `City`, `Game`, `App`, `Gfx`, `CAR`, `Input`, `THREE`):
  `await CV.open()`, then `CV.at(x, z, heading, 'name.jpg')`, `CV.over(...)`,
  `CV.top('name.jpg')` save pictures to `tools/shots/` with the frame's draw
  calls and triangles; `CV.breakdown()` splits those by kind; `CV.drive(sec,
  input)` steps the real game.
- `zfight.js` — paste into a test copy of the game in the browser (it needs
  `window.T`): `ZF.scan(k)` lists faces in preview map k's scenery that would
  flicker (two surfaces facing the same way in the same place), pieces built
  inside out, and faces lying on the ground plane.
