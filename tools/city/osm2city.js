// Turns an OpenStreetMap extract and a USGS height picture into the game's
// city file (maps/eugene.js).
//
//   node tools/city/osm2city.js <osm.json> <dem.tif> [out.js]
//
// The two inputs are downloads kept OUTSIDE the repo (see tools/city/README.md
// for the exact requests). Everything the game needs is in the output:
//   - a smoothed height grid (the creek's channel filled in; the game carves
//     it again where the stream runs in the open),
//   - the street network as junctions and the stretches between them,
//   - lanes (alleys, service roads, paths), areas (parks, pitches, car parks,
//     water), building outlines, the stream, a few point features, and the
//     names of public places.
// Private houses keep their outline and nothing else: no number, no name.
//
// Game coordinates: metres from the origin, +Z north, +X WEST (in the game
// +X is the driver's left when heading +Z), heights in metres above BASE.
const fs = require('fs');
const path = require('path');
const { readTiff } = require('./tiff.js');

// (the extract stops at 44.0290 N: the box's south edge is just inside it, so no strip is left bare)
const BOX = { s: 44.02893, n: 44.04095, w: -123.0979, e: -123.0806 };
const ORIGIN = { lat: 44.0347, lon: -123.0890 };
const M_LAT = 111132, M_LON = 111320 * Math.cos(ORIGIN.lat * Math.PI / 180);
const X = (lon) => (ORIGIN.lon - lon) * M_LON, Z = (lat) => (lat - ORIGIN.lat) * M_LAT;
const B = { x0: X(BOX.e), x1: X(BOX.w), z0: Z(BOX.s), z1: Z(BOX.n) };   // x0 east edge (most negative)

const [, , osmFile, demFile, chmFile, rgbFile, outFile] = process.argv;
if (!osmFile || !demFile) { console.error('usage: node osm2city.js <osm.json> <dem.tif> [<chm.tif> <photo_1m.rgb>] [out.js]'); process.exit(1); }
/* What really stands there, when the two extra files are given:
   chm.tif        the state lidar's height above the ground (feet), covering
                  BOX: how tall each building is, and every tree;
   photo_1m.rgb   the aerial photo over BOX at 1 m a pixel (tools/city/photo.py
                  writes it): the colour of each roof and each tree. */
const chm = chmFile && fs.existsSync(chmFile) ? readTiff(chmFile) : null;
const rgb = rgbFile && fs.existsSync(rgbFile) ? fs.readFileSync(rgbFile) : null;
const FT = 0.3048;
const raw = JSON.parse(fs.readFileSync(osmFile, 'utf8'));
const nodes = new Map(), ways = [], rels = [], wayById = new Map();
for (const e of raw.elements) {
  // (a node comes twice: once with its tags, once bare as part of a way)
  if (e.type === 'node') { const old = nodes.get(e.id); nodes.set(e.id, { id: e.id, x: X(e.lon), z: Z(e.lat), tags: e.tags || (old && old.tags) || null }); }
  else if (e.type === 'way') { ways.push(e); wayById.set(e.id, e); }
  else rels.push(e);
}
const T = (e) => e.tags || {};
const inBox = (x, z, m) => x >= B.x0 - (m || 0) && x <= B.x1 + (m || 0) && z >= B.z0 - (m || 0) && z <= B.z1 + (m || 0);
const ptsOf = (w) => w.nodes.map((id) => nodes.get(id)).filter(Boolean);
const r1 = (v) => Math.round(v * 10);            // decimetres
const flat = (pts) => { const o = []; for (const p of pts) o.push(r1(p.x), r1(p.z)); return o; };
const polyArea = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.z - q.x * p[i].z; } return a / 2; };
const centroid = (p) => { let x = 0, z = 0; for (const q of p) { x += q.x; z += q.z; } return { x: x / p.length, z: z / p.length }; };
const lenOf = (p) => { let L = 0; for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z); return L; };

/** drop points nearer than d to the one before, then points that add less than tol of shape */
function simplify(pts, d, tol, closed) {
  let out = [];
  for (const p of pts) { const q = out[out.length - 1]; if (!q || Math.hypot(p.x - q.x, p.z - q.z) >= d) out.push(p); }
  if (closed && out.length > 1) { const a = out[0], b = out[out.length - 1]; if (Math.hypot(a.x - b.x, a.z - b.z) < d) out.pop(); }
  for (let pass = 0; pass < 3; pass++) {
    const keep = [];
    const n = out.length;
    for (let i = 0; i < n; i++) {
      if (!closed && (i === 0 || i === n - 1)) { keep.push(out[i]); continue; }
      const a = keep.length ? keep[keep.length - 1] : out[(i - 1 + n) % n], b = out[(i + 1) % n], p = out[i];
      const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const off = Math.abs((p.x - a.x) * (b.z - a.z) - (p.z - a.z) * (b.x - a.x)) / L;
      if (off >= tol) keep.push(p);
    }
    if (keep.length === out.length || keep.length < 3) break;
    out = keep;
  }
  return out;
}
/** a line clipped to the box (+margin): the pieces inside, cut ends marked */
function clipLine(pts, m) {
  const x0 = B.x0 - m, x1 = B.x1 + m, z0 = B.z0 - m, z1 = B.z1 + m;
  const pieces = [];
  let cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    let t0 = 0, t1 = 1;
    const dx = b.x - a.x, dz = b.z - a.z;
    let ok = true;
    for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dz, a.z - z0], [dz, z1 - a.z]]) {
      if (Math.abs(p) < 1e-12) { if (q < 0) ok = false; continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) ok = false; else if (r > t0) t0 = r; } else { if (r < t0) ok = false; else if (r < t1) t1 = r; }
    }
    if (!ok || t0 > t1) { if (cur) { pieces.push(cur); cur = null; } continue; }
    const A = t0 > 0 ? { x: a.x + dx * t0, z: a.z + dz * t0, cut: true } : a;
    const Bp = t1 < 1 ? { x: a.x + dx * t1, z: a.z + dz * t1, cut: true } : b;
    if (!cur) cur = [A];
    else if (cur[cur.length - 1] !== A) { pieces.push(cur); cur = [A]; }
    cur.push(Bp);
    if (t1 < 1) { pieces.push(cur); cur = null; }
  }
  if (cur) pieces.push(cur);
  return pieces.filter((p) => p.length > 1);
}
/** a polygon clipped to the box (+margin) */
function clipPoly(pts, m) {
  let out = pts;
  const edges = [[(p) => p.x >= B.x0 - m, 'x', B.x0 - m], [(p) => p.x <= B.x1 + m, 'x', B.x1 + m], [(p) => p.z >= B.z0 - m, 'z', B.z0 - m], [(p) => p.z <= B.z1 + m, 'z', B.z1 + m]];
  for (const [inside, ax, v] of edges) {
    const src = out; out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i], b = src[(i + 1) % src.length], ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) { const t = (v - a[ax]) / (b[ax] - a[ax]); out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }); }
    }
    if (out.length < 3) return [];
  }
  return out;
}
const ring = (w) => { const p = ptsOf(w); if (p.length > 3 && p[0] === p[p.length - 1]) p.pop(); return p; };

/* ------------------------------------------------------------------ streets */
const STREET = { primary: 14, secondary: 13, tertiary: 11.5, residential: 9.5, unclassified: 9.5, primary_link: 7.5, secondary_link: 7.5, tertiary_link: 7.5 };
const names = [''];
const nameId = (n) => { if (!n) return 0; let i = names.indexOf(n); if (i < 0) { i = names.length; names.push(n); } return i; };
function streetWidth(t) {
  let w = STREET[t.highway];
  const lanes = +t.lanes || 0, one = t.oneway === 'yes';
  if (one) w = Math.max(7.5, w - 2.5);
  if (lanes >= 3) w += (lanes - 2) * 2.6 - (one ? 0 : 0);
  if (one && lanes === 1) w = Math.min(w, 8);
  return Math.round(w * 2) / 2;
}
// pieces of street inside the box
let pieces = [];
let synth = -1;
for (const w of ways) {
  const t = T(w);
  if (!STREET[t.highway] || t.area === 'yes') continue;
  const width = streetWidth(t);
  for (const piece of clipLine(ptsOf(w), 0)) {
    for (const p of piece) if (p.cut) { p.id = synth--; }
    pieces.push({ pts: piece, name: t.name || '', k: t.highway.replace('_link', ''), w: width, one: t.oneway === 'yes' ? 1 : 0, lanes: +t.lanes || 0, bridge: t.bridge ? 1 : 0 });
  }
}
// split at every point used by two pieces (or twice by one)
{
  const use = new Map();
  for (const pc of pieces) pc.pts.forEach((p, i) => use.set(p.id, (use.get(p.id) || 0) + (i === 0 || i === pc.pts.length - 1 ? 2 : 1)));
  // (an end counts double so that a piece ending on the middle of another splits it)
  const out = [];
  for (const pc of pieces) {
    let cur = [pc.pts[0]];
    for (let i = 1; i < pc.pts.length; i++) {
      cur.push(pc.pts[i]);
      if (i < pc.pts.length - 1 && use.get(pc.pts[i].id) > 1) { out.push(Object.assign({}, pc, { pts: cur })); cur = [pc.pts[i]]; }
    }
    out.push(Object.assign({}, pc, { pts: cur }));
  }
  pieces = out.filter((p) => p.pts.length > 1);
}
// join pieces through points only two like pieces share
{
  let merged = true;
  while (merged) {
    merged = false;
    const ends = new Map();
    pieces.forEach((pc, i) => { for (const e of [pc.pts[0].id, pc.pts[pc.pts.length - 1].id]) { if (!ends.has(e)) ends.set(e, []); ends.get(e).push(i); } });
    for (const [id, list] of ends) {
      if (list.length !== 2 || list[0] === list[1]) continue;
      const a = pieces[list[0]], b = pieces[list[1]];
      if (!a || !b || a.name !== b.name || a.k !== b.k || a.w !== b.w || a.one !== b.one) continue;
      // orient: a ends at id, b starts at id (a one-way keeps its direction)
      const aEnds = a.pts[a.pts.length - 1].id === id, bStarts = b.pts[0].id === id;
      if (a.one && (!aEnds || !bStarts)) { if (!(a.pts[0].id === id && b.pts[b.pts.length - 1].id === id)) continue; }
      let pa = a.pts, pb = b.pts;
      if (a.pts[0].id === id && b.pts[b.pts.length - 1].id === id) { pa = b.pts; pb = a.pts; }
      else { if (!aEnds) pa = a.pts.slice().reverse(); if (!bStarts) pb = b.pts.slice().reverse(); }
      pieces[list[0]] = Object.assign({}, a, { pts: pa.concat(pb.slice(1)) });
      pieces[list[1]] = null;
      pieces = pieces.filter(Boolean);
      merged = true;
      break;
    }
  }
}
// junctions: the pieces' ends. Ends a few metres apart (an offset crossing, the
// two halves of a divided road) become one.
const jn = [];
{
  const idOf = new Map();
  const at = (p) => { if (!idOf.has(p.id)) { idOf.set(p.id, jn.length); jn.push({ x: p.x, z: p.z, cut: !!p.cut, n: 1 }); } return idOf.get(p.id); };
  for (const pc of pieces) { pc.a = at(pc.pts[0]); pc.b = at(pc.pts[pc.pts.length - 1]); pc.len = lenOf(pc.pts); }
  const parent = jn.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const pc of pieces) if (pc.len < 9 && pc.a !== pc.b) parent[find(pc.a)] = find(pc.b);
  const sum = new Map();
  jn.forEach((j, i) => { const r = find(i); const s = sum.get(r) || { x: 0, z: 0, n: 0, cut: false }; s.x += j.x; s.z += j.z; s.n++; s.cut = s.cut || j.cut; sum.set(r, s); });
  const newIdx = new Map(), out = [];
  for (const [r, s] of sum) { newIdx.set(r, out.length); out.push({ x: s.x / s.n, z: s.z / s.n, cut: s.cut }); }
  for (const pc of pieces) {
    pc.a = newIdx.get(find(pc.a)); pc.b = newIdx.get(find(pc.b));
    pc.pts = pc.pts.map((p) => ({ x: p.x, z: p.z }));
    pc.pts[0] = { x: out[pc.a].x, z: out[pc.a].z }; pc.pts[pc.pts.length - 1] = { x: out[pc.b].x, z: out[pc.b].z };
  }
  pieces = pieces.filter((pc) => !(pc.a === pc.b && pc.len < 14));
  jn.length = 0; for (const j of out) jn.push(j);
}
const edges = pieces.map((pc) => {
  const pts = simplify(pc.pts, 1.5, 0.25, false);
  return { a: pc.a, b: pc.b, k: pc.k[0], w: pc.w, n: nameId(pc.name), o: pc.one, p: flat(pts) };
});

/* -------------------------------------------------------------------- lanes */
const areasRaw = [];
const parkingPolys = [];
for (const w of ways) { const t = T(w); if (t.amenity === 'parking' && !/underground|multi-storey/.test(t.parking || '')) { const p = ring(w); if (p.length >= 3) parkingPolys.push(p); } }
const inPoly = (pt, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.z > pt.z) !== (b.z > pt.z) && pt.x < (b.x - a.x) * (pt.z - a.z) / (b.z - a.z) + a.x) c = !c; } return c; };
const lanes = [];
for (const w of ways) {
  const t = T(w), h = t.highway;
  if (!h || STREET[h]) continue;
  let k = null, width = 0;
  if (h === 'service') {
    if (t.service === 'alley') { k = 'a'; width = 4.8; }
    else if (t.service === 'parking_aisle') { k = 's'; width = 6.2; }
    else if (t.service === 'driveway') { k = 's'; width = 3.6; }
    else { k = 's'; width = 5.6; }
  } else if (h === 'cycleway') { k = 'c'; width = 3.4; }
  else if (h === 'footway' || h === 'path' || h === 'pedestrian') {
    if (t.footway === 'sidewalk' || t.footway === 'crossing' || t.footway === 'traffic_island') continue;
    k = 'f'; width = h === 'pedestrian' ? 4 : 2.2;
  } else if (h === 'track') { k = 't'; width = 3; }
  else continue;
  if (t.tunnel || t.indoor) continue;
  for (const piece of clipLine(ptsOf(w), 0)) {
    const L = lenOf(piece);
    if (t.service === 'driveway' && L < 30) continue;
    if (k === 'f' && L < 12) continue;
    if (t.service === 'parking_aisle') {
      // the car park itself is drawn as tarmac: an aisle inside one adds nothing
      const mid = piece[Math.floor(piece.length / 2)];
      if (parkingPolys.some((p) => inPoly(mid, p))) continue;
    }
    const pts = simplify(piece, 1.2, 0.2, false);
    lanes.push({ k, w: width, n: /^[A-Za-z]/.test(t.name || '') ? nameId(t.name) : 0, p: flat(pts) });
  }
}

/* -------------------------------------------------------------------- areas */
function areaKind(t) {
  if (t.amenity === 'parking') return /underground|multi-storey/.test(t.parking || '') ? null : 'parking';
  if (t.leisure === 'pitch') return 'pitch';
  if (t.leisure === 'track') return 'track';
  if (t.leisure === 'swimming_pool') return 'pool';
  if (t.leisure === 'playground') return 'playground';
  if (t.leisure === 'park' || t.leisure === 'garden') return 'park';
  if (t.leisure === 'bleachers') return 'bleachers';
  if (t.natural === 'water') return 'water';
  if (t.natural === 'wood' || t.landuse === 'forest') return 'wood';
  if (t.natural === 'wetland') return 'wetland';
  if (t.natural === 'sand') return 'sand';
  if (t.natural === 'shrubbery') return 'shrub';
  if (t.landuse === 'grass' || t.landuse === 'recreation_ground') return 'grass';
  if (t.landuse === 'cemetery') return 'grass';
  if (t.amenity === 'school' && !t.building) return 'school';
  return null;
}
const areas = [];
const addArea = (t, pts) => {
  const k = areaKind(t);
  if (!k || t.building) return;
  const c = clipPoly(pts, 0);
  if (c.length < 3) return;
  const s = simplify(c, 0.6, 0.15, true);
  if (s.length < 3 || Math.abs(polyArea(s)) < 12) return;
  const a = { k, p: flat(s) };
  if (t.sport) a.s = t.sport;
  if (t.surface) a.f = t.surface;
  if (t.name && k !== 'parking') a.n = t.name;
  areas.push(a);
};
for (const w of ways) { if (w.nodes[0] === w.nodes[w.nodes.length - 1] && !T(w).highway) addArea(T(w), ring(w)); }
for (const r of rels) {
  if (T(r).type !== 'multipolygon' || T(r).building) continue;
  for (const m of r.members) if (m.type === 'way' && m.role !== 'inner' && wayById.has(m.ref)) { const w = wayById.get(m.ref); if (w.nodes[0] === w.nodes[w.nodes.length - 1]) addArea(T(r), ring(w)); }
}

/* ---------------------------------------------------------------- buildings */
const buildings = [];
const places = [];
const PUBLIC = (t) => t.amenity || t.shop || t.leisure || t.tourism || t.office || t.craft;
function buildingKind(t, area) {
  const b = t.building;
  if (t.amenity === 'place_of_worship') return 'w';
  if (t.amenity === 'fuel' || b === 'roof' || b === 'carport') return 'r';
  if (b === 'school' || t.amenity === 'school') return 'S';
  if (b === 'university' || b === 'dormitory') return 'a';
  if (b === 'grandstand' || b === 'dugout') return 'd';
  if (b === 'house' || b === 'detached' || b === 'residential' || b === 'terrace') return area > 420 ? 'a' : 'h';
  if (b === 'apartments') return 'a';
  if (b === 'retail' || b === 'commercial' || b === 'sports_centre') return 'c';
  if (b === 'garage' || b === 'garages') return 'g';
  if (b === 'shed') return 's';
  if (PUBLIC(t) || t.name) return 'c';
  if (area < 22) return 's';
  if (area < 62) return 'g';
  if (area < 380) return 'h';
  return 'c';
}
/** the lidar's height above the ground at (x, z), metres */
const chmAt = (x, z) => {
  const u = Math.floor(((ORIGIN.lon - x / M_LON) - chm.geo.w) / chm.geo.px), v = Math.floor((chm.geo.n - (ORIGIN.lat + z / M_LAT)) / chm.geo.py);
  if (u < 0 || v < 0 || u >= chm.w || v >= chm.h) return 0;
  const h = chm.data[v * chm.w + u];
  return h > 0 && h < 400 ? h * FT : 0;
};
const RW = Math.round(B.x1 - B.x0), RH = Math.round(B.z1 - B.z0);
/** the photo's colour at (x, z): [r, g, b] or null */
const rgbAt = (x, z) => {
  const i = Math.floor(B.x1 - x), j = Math.floor(B.z1 - z);
  if (i < 0 || j < 0 || i >= RW || j >= RH) return null;
  const k = (j * RW + i) * 3;
  return [rgb[k], rgb[k + 1], rgb[k + 2]];
};
const pointInPoly = (x, z, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) c = !c; } return c; };
const outlines = [];
const addBuilding = (t, pts) => {
  if (pts.length < 3) return;
  const c = centroid(pts);
  if (!inBox(c.x, c.z, 0)) return;
  let s = simplify(pts, 0.4, 0.12, true);
  if (s.length < 3) return;
  let area = polyArea(s);
  if (Math.abs(area) < 6) return;
  if (area < 0) { s = s.reverse(); area = -area; }       // anticlockwise seen from +Y... (x west): kept consistent, the game re-checks
  const b = { k: buildingKind(t, area), p: flat(s) };
  const lv = parseFloat(t['building:levels']);
  if (lv > 0) b.l = Math.min(8, Math.round(lv));
  // names only for public places (never a house or a block of flats)
  if (t.name && b.k !== 'h' && b.k !== 'a' && b.k !== 'g' && b.k !== 's') b.n = t.name;
  const tag = t.amenity || t.shop || t.leisure || '';
  if (tag && b.k !== 'h') b.t = tag;
  outlines.push(s);
  // its real height (the walls' and the roof's top) and the colour of its roof
  if (chm || rgb) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of s) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
    const hs = [], cr = [], cg = [], cb = [], step = Math.max(0.9, Math.sqrt(area) / 14);
    for (let z = z0 + 0.5; z < z1; z += step) for (let x = x0 + 0.5; x < x1; x += step) {
      // (well inside the outline: the survey's edge cells are half roof, half ground)
      if (![[0, 0], [0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8]].every(([dx, dz]) => pointInPoly(x + dx, z + dz, s))) continue;
      if (chm) hs.push(chmAt(x, z));
      if (rgb) { const c2 = rgbAt(x, z); if (c2) { cr.push(c2[0]); cg.push(c2[1]); cb.push(c2[2]); } }
    }
    const pct = (a, f) => { const q = a.slice().sort((m, n) => m - n); return q[Math.min(q.length - 1, Math.floor(q.length * f))]; };
    if (hs.length >= 6) { const e = pct(hs, 0.25), top = pct(hs, 0.9); if (top > 1.8) b.h = [Math.round(e * 10), Math.round(top * 10)]; }
    // A big building is rarely one height (a school's halls stand over its
    // wings): the parts well above the rest, as boxes [x0, z0, x1, z1, height].
    if (chm && b.h && area > 700 && b.h[1] - b.h[0] > 22 && !/^[hgs]$/.test(b.k)) {
      const G2 = 3, low = b.h[0] / 10, cols = Math.ceil((x1 - x0) / G2), rows = Math.ceil((z1 - z0) / G2), tall = new Float32Array(cols * rows);
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const cx = x0 + (i + 0.5) * G2, cz = z0 + (j + 0.5) * G2;
        if (![[-2, -2], [2, -2], [2, 2], [-2, 2], [0, 0]].every(([dx, dz]) => pointInPoly(cx + dx, cz + dz, s))) continue;
        let t = 0, n = 0; for (const [dx, dz] of [[0, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]]) { t += chmAt(cx + dx, cz + dz); n++; }
        if (t / n > low + 2) tall[j * cols + i] = t / n;
      }
      // runs along x, then runs of the same span and much the same height joined along z
      const runs = [];
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols;) {
        if (!tall[j * cols + i]) { i++; continue; }
        let k = i, sum = 0; const h0 = tall[j * cols + i];
        while (k < cols && tall[j * cols + k] && Math.abs(tall[j * cols + k] - h0) < 1.5) { sum += tall[j * cols + k]; k++; }
        runs.push({ i0: i, i1: k, j0: j, j1: j + 1, h: sum / (k - i) }); i = k;
      }
      const out2 = [];
      for (const r of runs) { const m = out2.find((o) => o.i0 === r.i0 && o.i1 === r.i1 && o.j1 === r.j0 && Math.abs(o.h - r.h) < 1.5); if (m) { m.h = (m.h * (m.j1 - m.j0) + r.h) / (m.j1 - m.j0 + 1); m.j1 = r.j1; } else out2.push(Object.assign({}, r)); }
      const big = out2.filter((o) => (o.i1 - o.i0) * (o.j1 - o.j0) >= 4).sort((p, q) => (q.i1 - q.i0) * (q.j1 - q.j0) - (p.i1 - p.i0) * (p.j1 - p.j0)).slice(0, 40);
      if (big.length) b.up = [].concat(...big.map((o) => [r1(x0 + o.i0 * G2), r1(z0 + o.j0 * G2), r1(x0 + o.i1 * G2), r1(z0 + o.j1 * G2), Math.round(o.h * 10)]));
    }
    if (cr.length >= 4) b.c = (pct(cr, 0.5) << 16) | (pct(cg, 0.5) << 8) | pct(cb, 0.5);
  }
  buildings.push(b);
};
for (const w of ways) { const t = T(w); if (t.building && w.nodes[0] === w.nodes[w.nodes.length - 1]) addBuilding(t, ring(w)); }
for (const r of rels) {
  if (!T(r).building) continue;
  for (const m of r.members) if (m.type === 'way' && m.role !== 'inner' && wayById.has(m.ref)) { const w = wayById.get(m.ref); if (w.nodes[0] === w.nodes[w.nodes.length - 1] && !T(w).building) addBuilding(T(r), ring(w)); }
}

/* ------------------------------------------------------------------- places */
const placeKind = (t) => t.amenity || t.shop && 'shop' || t.leisure || t.tourism || '';
const addPlace = (t, x, z) => {
  if (!t.name || !inBox(x, z, 0)) return;
  if (/^(house|apartments|residential|dormitory|detached|terrace)$/.test(t.building || '') || t.landuse === 'residential') return;
  const k = placeKind(t);
  if (!k || /parking|bench|bicycle_parking|vending_machine|atm|bus_station|waste/.test(k)) return;
  if (places.some((p) => p.n === t.name && Math.hypot(p.x - r1(x), p.z - r1(z)) < 1500)) return;
  places.push({ n: t.name, k, x: r1(x), z: r1(z) });
};
for (const w of ways) { const t = T(w); if (t.name && !t.highway && !t.waterway) { const c = centroid(ptsOf(w)); addPlace(t, c.x, c.z); } }
for (const n of nodes.values()) if (n.tags && n.tags.name && !n.tags.highway) addPlace(n.tags, n.x, n.z);
for (const r of rels) { const t = T(r); if (!t.name) continue; const ps = []; for (const m of r.members) if (m.type === 'way' && wayById.has(m.ref)) ps.push(...ptsOf(wayById.get(m.ref))); if (ps.length) { const c = centroid(ps); addPlace(t, c.x, c.z); } }

/* ------------------------------------------------------------------ streams */
const streams = [];
for (const w of ways) {
  const t = T(w);
  if (t.waterway !== 'stream' && t.waterway !== 'ditch' && t.waterway !== 'drain') continue;
  for (const piece of clipLine(ptsOf(w), 60)) {
    const s = { p: flat(simplify(piece, 1.5, 0.3, false)) };
    if (t.tunnel) s.c = 1;
    streams.push(s);
  }
}

/* ------------------------------------------------------------------- points */
const points = { tree: [], signal: [], stop: [], crossing: [], bus: [], lamp: [] };
for (const n of nodes.values()) {
  if (!n.tags || !inBox(n.x, n.z, 0)) continue;
  const t = n.tags;
  const put = (k) => points[k].push(r1(n.x), r1(n.z));
  if (t.natural === 'tree') put('tree');
  else if (t.highway === 'traffic_signals') put('signal');
  else if (t.highway === 'stop') put('stop');
  else if (t.highway === 'crossing' && (t.crossing === 'marked' || t['crossing:markings'] && t['crossing:markings'] !== 'no' || t.crossing === 'zebra' || t.crossing === 'traffic_signals')) put('crossing');
  else if (t.highway === 'bus_stop') put('bus');
  else if (t.highway === 'street_lamp') put('lamp');
}

/* ------------------------------------------------------------------ heights */
const dem = readTiff(demFile);
if (!dem.geo) throw new Error('the height picture does not say where it lies');
if (dem.geo.w > BOX.w || dem.geo.e < BOX.e || dem.geo.s > BOX.s || dem.geo.n < BOX.n) console.warn('WARNING: the height picture does not cover the whole box');
const demAt = (x, z) => {
  // (x west-positive) -> lon, lat -> the picture's pixel, bilinear
  const lon = ORIGIN.lon - x / M_LON, lat = ORIGIN.lat + z / M_LAT;
  let u = (lon - dem.geo.w) / dem.geo.px - 0.5, v = (dem.geo.n - lat) / dem.geo.py - 0.5;
  u = Math.max(0, Math.min(dem.w - 1.001, u)); v = Math.max(0, Math.min(dem.h - 1.001, v));
  const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
  const d = dem.data, w = dem.w;
  return (d[j * w + i] * (1 - fu) + d[j * w + i + 1] * fu) * (1 - fv) + (d[(j + 1) * w + i] * (1 - fu) + d[(j + 1) * w + i + 1] * fu) * fv;
};
// a working grid, 4 m, 100 m past the box
const GS = 4, GM = 100;
const gx0 = B.x0 - GM, gz0 = B.z0 - GM, gnx = Math.ceil((B.x1 - B.x0 + 2 * GM) / GS) + 1, gnz = Math.ceil((B.z1 - B.z0 + 2 * GM) / GS) + 1;
let G = new Float32Array(gnx * gnz);
for (let j = 0; j < gnz; j++) for (let i = 0; i < gnx; i++) G[j * gnx + i] = demAt(gx0 + i * GS, gz0 + j * GS);
// the stream's channel (and, with it, the gaps the survey leaves where a road
// bridges it) filled in from the ground either side
{
  const mask = new Uint8Array(gnx * gnz);
  const R = 13;
  for (const w of ways) {
    const t = T(w);
    if (t.waterway !== 'stream') continue;
    const p = ptsOf(w);
    for (let s = 0; s < p.length - 1; s++) {
      const a = p[s], b = p[s + 1], L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(L / 2));
      for (let k = 0; k <= n; k++) {
        const x = a.x + (b.x - a.x) * k / n, z = a.z + (b.z - a.z) * k / n;
        const i0 = Math.floor((x - R - gx0) / GS), i1 = Math.ceil((x + R - gx0) / GS), j0 = Math.floor((z - R - gz0) / GS), j1 = Math.ceil((z + R - gz0) / GS);
        for (let j = Math.max(0, j0); j <= Math.min(gnz - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(gnx - 1, i1); i++) {
          if (Math.hypot(gx0 + i * GS - x, gz0 + j * GS - z) <= R) mask[j * gnx + i] = 1;
        }
      }
    }
  }
  for (let it = 0; it < 600; it++) {
    for (let j = 1; j < gnz - 1; j++) for (let i = 1; i < gnx - 1; i++) {
      const k = j * gnx + i;
      if (mask[k]) G[k] = (G[k - 1] + G[k + 1] + G[k - gnx] + G[k + gnx]) / 4;
    }
  }
}
// smoothed: three passes of a box blur come close to a Gaussian (sigma ~ 14 m), which keeps
// the hills and loses the ripples no one would see (and every triangle spent on them)
{
  const blur = (src, r) => {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    for (let j = 0; j < gnz; j++) for (let i = 0; i < gnx; i++) { let s = 0, n = 0; for (let d = -r; d <= r; d++) { const q = Math.max(0, Math.min(gnx - 1, i + d)); s += src[j * gnx + q]; n++; } tmp[j * gnx + i] = s / n; }
    for (let j = 0; j < gnz; j++) for (let i = 0; i < gnx; i++) { let s = 0, n = 0; for (let d = -r; d <= r; d++) { const q = Math.max(0, Math.min(gnz - 1, j + d)); s += tmp[q * gnx + i]; n++; } out[j * gnx + i] = s / n; }
    return out;
  };
  G = blur(blur(blur(G, 3), 3), 3);
}
// what the game gets: 10 m, 60 m past the box, centimetres above BASE
const HS = 10, HM = 60;
const hx0 = B.x0 - HM, hz0 = B.z0 - HM, hnx = Math.round((B.x1 - B.x0 + 2 * HM) / HS) + 1, hnz = Math.round((B.z1 - B.z0 + 2 * HM) / HS) + 1;
const gAt = (x, z) => {
  let u = (x - gx0) / GS, v = (z - gz0) / GS;
  u = Math.max(0, Math.min(gnx - 1.001, u)); v = Math.max(0, Math.min(gnz - 1.001, v));
  const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
  return (G[j * gnx + i] * (1 - fu) + G[j * gnx + i + 1] * fu) * (1 - fv) + (G[(j + 1) * gnx + i] * (1 - fu) + G[(j + 1) * gnx + i + 1] * fu) * fv;
};
let lo = Infinity, hi = -Infinity;
const H = new Float32Array(hnx * hnz);
for (let j = 0; j < hnz; j++) for (let i = 0; i < hnx; i++) { const v = gAt(hx0 + i * HS, hz0 + j * HS); H[j * hnx + i] = v; lo = Math.min(lo, v); hi = Math.max(hi, v); }
const BASE = Math.floor(lo) - 1;
const q = Buffer.alloc(hnx * hnz * 2);
let maxCurv = 0;
for (let k = 0; k < H.length; k++) q.writeUInt16LE(Math.round((H[k] - BASE) * 100), k * 2);
for (let j = 1; j < hnz - 1; j++) for (let i = 1; i < hnx - 1; i++) {
  const k = j * hnx + i;
  maxCurv = Math.max(maxCurv, Math.abs(H[k - 1] + H[k + 1] - 2 * H[k]) / (HS * HS), Math.abs(H[k - hnx] + H[k + hnx] - 2 * H[k]) / (HS * HS));
}

/* ---------------------------------------------------------------- the trees
   Every real tree: the tops in the lidar's canopy (a cell higher than all
   round it), tallest first, each keeping others its own crown's width away. */
let treeBuf = null, treeN = 0;
if (chm) {
  const W = RW, Hh = RH, C = new Float32Array(W * Hh);
  for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) C[j * W + i] = chmAt(B.x1 - i - 0.5, B.z1 - j - 0.5);
  // not the buildings (nor the metre round them, where the survey smears a roof's edge)
  for (const P of outlines) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of P) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
    for (let j = Math.max(0, Math.floor(B.z1 - z1 - 2)); j <= Math.min(Hh - 1, Math.ceil(B.z1 - z0 + 2)); j++) for (let i = Math.max(0, Math.floor(B.x1 - x1 - 2)); i <= Math.min(W - 1, Math.ceil(B.x1 - x0 + 2)); i++) {
      const x = B.x1 - i - 0.5, z = B.z1 - j - 0.5;
      if ([[0, 0], [1.3, 0], [-1.3, 0], [0, 1.3], [0, -1.3]].some(([dx, dz]) => pointInPoly(x + dx, z + dz, P))) C[j * W + i] = 0;
    }
  }
  const S2 = new Float32Array(W * Hh);
  for (let j = 1; j < Hh - 1; j++) for (let i = 1; i < W - 1; i++) { let t = 0; for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) t += C[(j + b) * W + i + a]; S2[j * W + i] = t / 9; }
  const tops = [];
  for (let j = 3; j < Hh - 3; j++) for (let i = 3; i < W - 3; i++) {
    const h = S2[j * W + i];
    if (h < 4.5) continue;
    let top = true;
    for (let b = -2; b <= 2 && top; b++) for (let a = -2; a <= 2; a++) if ((a || b) && S2[(j + b) * W + i + a] > h) { top = false; break; }
    if (top) tops.push({ i, j, h: Math.max(h, C[j * W + i]) });
  }
  tops.sort((a, b) => b.h - a.h);
  const cell = new Map(), kept = [];
  const near = (t, fn) => { for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) { const L = cell.get((Math.floor(t.i / 10) + a) + ':' + (Math.floor(t.j / 10) + b)); if (L) for (const o of L) fn(o); } };
  for (const t of tops) {
    const need = Math.max(3.5, Math.min(9, 0.22 * t.h + 2.2));
    let ok = true;
    near(t, (o) => { if (Math.hypot(o.i - t.i, o.j - t.j) < Math.max(need, o.need * 0.8)) ok = false; });
    if (!ok) continue;
    t.need = need;
    const k = Math.floor(t.i / 10) + ':' + Math.floor(t.j / 10);
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(t); kept.push(t);
  }
  treeBuf = Buffer.alloc(kept.length * 10);
  kept.forEach((t, n) => {
    let d = 30; near(t, (o) => { if (o !== t) d = Math.min(d, Math.hypot(o.i - t.i, o.j - t.j)); });
    const r = Math.max(1.5, Math.min(8, Math.min(0.6 * d, 0.2 * t.h + 1.6)));
    const x = B.x1 - t.i - 0.5, z = B.z1 - t.j - 0.5;
    let cr = 70, cg = 105, cb = 55;
    if (rgb) { let a = 0, b = 0, c = 0, m = 0; for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) { const q = rgbAt(x + dx, z + dz); if (q) { a += q[0]; b += q[1]; c += q[2]; m++; } } if (m) { cr = a / m; cg = b / m; cb = c / m; } }
    const lum = 0.3 * cr + 0.59 * cg + 0.11 * cb;
    const fir = t.h >= 21 || (t.h >= 12 && lum < 66);
    treeBuf.writeInt16LE(Math.round(x * 10), n * 10); treeBuf.writeInt16LE(Math.round(z * 10), n * 10 + 2);
    treeBuf[n * 10 + 4] = Math.min(255, Math.round(t.h * 5)); treeBuf[n * 10 + 5] = Math.round(r * 10);
    treeBuf[n * 10 + 6] = Math.round(cr); treeBuf[n * 10 + 7] = Math.round(cg); treeBuf[n * 10 + 8] = Math.round(cb); treeBuf[n * 10 + 9] = fir ? 1 : 0;
  });
  treeN = kept.length;
}

/* ------------------------------------------------------------------- output */
const out = {
  name: 'South Eugene',
  credit: 'Map data © OpenStreetMap contributors (ODbL). Heights: U.S. Geological Survey 3DEP.',
  origin: ORIGIN,
  box: { x0: Math.round(B.x0), x1: Math.round(B.x1), z0: Math.round(B.z0), z1: Math.round(B.z1) },
  dem: { x0: hx0, z0: hz0, step: HS, nx: hnx, nz: hnz, base: BASE, q: q.toString('base64') },
  names, nodes: jn.map((j) => [r1(j.x), r1(j.z), j.cut ? 1 : 0]), edges, lanes, areas, buildings, streams, points, places
};
if (rgb) {
  // the aerial photo, as textures (tools/city/photo.py): four quarters of the 1536 m square round the origin, and the whole of it small
  out.photo = { dir: 'eugene/', half: 768, quarters: ['q00.jpg', 'q01.jpg', 'q10.jpg', 'q11.jpg'], all: 'all.jpg' };
  out.credit = 'Map data \u00a9 OpenStreetMap contributors (ODbL). Aerial photo: Oregon Statewide Imagery Program, 2022. Heights: USGS 3DEP and Oregon DOGAMI lidar.';
}
if (treeBuf) out.trees = { n: treeN, q: treeBuf.toString('base64') };
const js = '/* aiPolytrack city data: South Eugene. Made by tools/city/osm2city.js: edit that, not this.\n' +
  '   Map data (c) OpenStreetMap contributors, Open Database License (openstreetmap.org/copyright).\n' +
  '   Heights: U.S. Geological Survey 3D Elevation Program (public domain). */\n' +
  '(function (g) { (g.CityData = g.CityData || {}).eugene = ' + JSON.stringify(out) + '; })(typeof self !== \'undefined\' ? self : globalThis);\n';
const dest = outFile || path.join(__dirname, '..', '..', 'maps', 'eugene.js');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, js);
const kinds = {}; for (const b of buildings) kinds[b.k] = (kinds[b.k] || 0) + 1;
const ak = {}; for (const a of areas) ak[a.k] = (ak[a.k] || 0) + 1;
console.log('box', out.box, 'size', out.box.x1 - out.box.x0, 'x', out.box.z1 - out.box.z0, 'm');
console.log('junctions', jn.length, 'street stretches', edges.length, 'street km', (pieces.reduce((s, p) => s + lenOf(p.pts), 0) / 1000).toFixed(1), 'names', names.length - 1);
console.log('lanes', lanes.length, 'areas', JSON.stringify(ak), 'buildings', buildings.length, JSON.stringify(kinds));
console.log('streams', streams.length, 'points', Object.entries(points).map(([k, v]) => k + ':' + v.length / 2).join(' '), 'places', places.length);
console.log('heights', hnx, 'x', hnz, 'range', (lo - BASE).toFixed(1), '..', (hi - BASE).toFixed(1), 'm above', BASE, 'max curvature', maxCurv.toFixed(4), '/m');
console.log('lidar: buildings with a real height', buildings.filter((b) => b.h).length, 'of', buildings.length, '| real trees', treeN, '| roofs with a real colour', buildings.filter((b) => b.c !== undefined).length);
console.log('wrote', dest, (js.length / 1024).toFixed(0), 'KB');
