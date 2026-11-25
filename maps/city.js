/* aiPolytrack: the open-world city builder.
   Loaded only when a city map is opened (index.html stays as it was for
   everyone else). It turns a city file (maps/eugene.js, made by
   tools/city/osm2city.js) into:
     - the ground: a height field the physics reads directly (no triangles),
       drawn as a grid whose detail follows the land (fine on hills and along
       the creek, coarse on the flat);
     - everything flat, as layers draped over the ground a few centimetres
       apart: sports ground, pavement, verge, kerb, car parks and lanes,
       street tarmac, road paint. A street is a ribbon in each layer and a
       disc at each junction, so where streets meet the layers simply
       overlap: no seams to line up, and the same picture for the physics;
     - buildings on their real outlines, solid, with roofs that sit on the
       walls; trees; street furniture.
   Coordinates: metres, +Z north, +X west (the driver's left heading +Z).

   CityKit(env) -> { build(data, opts) }   env: { THREE, GROUND_Y }
   build() returns the city: { field, phys, solids, root (if opts.visual),
   spawn, nearestStreet(), streetName(), ... }                              */
(function (g) {
'use strict';
g.CityKit = function (env) {
  const THREE = env.THREE, GY = env.GROUND_Y;
  const FS = 4, TILE = 128, TN = TILE / FS, APRON = 192, CHUNK = 256;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const BIAS = 0.03;                     // the ground is drawn this far under the height the layers stand on
  const TOL = 0.01;                      // how far a tile's coarser ground may stray from the survey, per stride (so a crease bends a road by 2% at most)
  /* the flat layers, bottom to top: lift above the ground, colour, and whether a wheel can stand on it */
  const LAYER = {
    ground: { lift: 0.02, off: 1 }, pitch: { lift: 0.04, off: 2 }, mark: { lift: 0.052, off: 3 }, walk: { lift: 0.07, off: 4, phys: 1 },
    verge: { lift: 0.09, off: 5 }, kerb: { lift: 0.11, off: 6 }, lot: { lift: 0.13, off: 7, phys: 1 },
    road: { lift: 0.15, off: 8, phys: 1 }, paint: { lift: 0.165, off: 9 }
  };
  const COL = {
    road: 0x55585d, lot: 0x6b6d70, alley: 0x6b6d70, kerb: 0xc9c8c2, walk: 0xb3b2ac, verge: 0x5f9447,
    yellow: 0xe3b31e, white: 0xf0f0ec, turf: 0x4f9a48, court: 0x3f7fa3, courtOut: 0x4a8a58, clay: 0xb5714a, track: 0xa85640,
    bark: 0x9a7a55, sand: 0xd6c595, water: 0x4a8fb5, grass: 0x639b49, park: 0x6aa64d, wood: 0x44733a, mud: 0x6b6957, yard: 0x67a04c
  };
  /* Every colour here is written as it should LOOK in full sun. The game
     draws with ACES tone mapping under bright lights, which turns a plain
     mid colour nearly white, so rgb() works back from the look to the paint
     that gives it (per channel: the tone curve undone, over the light a
     sunlit surface gets). */
  const LREF = 2.05;
  const aces = (v) => clamp((v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081), 0, 1);
  const tone1 = (v8) => {
    const s = v8 / 255, target = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    let lo = 0, hi = 8;
    for (let k = 0; k < 26; k++) { const m = (lo + hi) / 2; if (aces(m) < target) lo = m; else hi = m; }
    return lo * 0.6 / LREF;
  };
  const TONE = new Float32Array(256); for (let k = 0; k < 256; k++) TONE[k] = tone1(k);
  const rgb = (hex) => [TONE[(hex >> 16) & 255], TONE[(hex >> 8) & 255], TONE[hex & 255]];
  const sstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };
  const hash2 = (x, z) => { let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

  /* ---------------------------------------------------------------- decoding */
  const pairs = (a) => { const o = []; for (let i = 0; i < a.length; i += 2) o.push({ x: a[i] / 10, z: a[i + 1] / 10 }); return o; };
  function b64(s) {
    if (typeof atob === 'function') { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
    return new Uint8Array(Buffer.from(s, 'base64'));
  }

  /** ear clipping: a simple polygon (points {x,z}) -> triangles as index triples */
  function triangulate(P) {
    const n = P.length, out = [];
    if (n < 3) return out;
    let area = 0;
    for (let i = 0; i < n; i++) { const a = P[i], b = P[(i + 1) % n]; area += a.x * b.z - b.x * a.z; }
    const idx = []; for (let i = 0; i < n; i++) idx.push(area > 0 ? i : n - 1 - i);
    const cross = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    const inside = (a, b, c, p) => cross(a, b, p) >= -1e-9 && cross(b, c, p) >= -1e-9 && cross(c, a, p) >= -1e-9;
    let guard = 0;
    while (idx.length > 3 && guard++ < 20000) {
      let cut = false;
      for (let i = 0; i < idx.length; i++) {
        const i0 = idx[(i + idx.length - 1) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length];
        const a = P[i0], b = P[i1], c = P[i2];
        if (cross(a, b, c) <= 1e-9) continue;
        let ear = true;
        for (const k of idx) { if (k === i0 || k === i1 || k === i2) continue; const p = P[k]; if ((p.x === a.x && p.z === a.z) || (p.x === b.x && p.z === b.z) || (p.x === c.x && p.z === c.z)) continue; if (inside(a, b, c, p)) { ear = false; break; } }
        if (!ear) continue;
        out.push([i0, i1, i2]); idx.splice(i, 1); cut = true; break;
      }
      if (!cut) { idx.splice(0, 1); }                 // a bad outline (touching itself): drop a point and go on
    }
    if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
    return out;
  }
  const inPoly = (x, z, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) c = !c; } return c; };
  const polyArea = (P) => { let a = 0; for (let i = 0; i < P.length; i++) { const q = P[(i + 1) % P.length]; a += P[i].x * q.z - q.x * P[i].z; } return a / 2; };
  const distSeg = (x, z, a, b) => { const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1e-9; const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / L2, 0, 1); return Math.hypot(x - a.x - dx * t, z - a.z - dz * t); };

  function build(data, opts) {
    opts = opts || {};
    const detail = opts.detail === undefined ? 2 : opts.detail;        // the scenery setting: 0 light, 1 medium, 2 full
    const BOX = data.box;
    const city = { name: data.name, credit: data.credit, box: BOX, places: [], data, opts };

    /* ---------------------------------------------------------------- heights */
    const D = data.dem, raw = b64(D.q), H = new Float32Array(D.nx * D.nz);
    let hmin = Infinity;
    for (let k = 0; k < H.length; k++) { H[k] = (raw[k * 2] | (raw[k * 2 + 1] << 8)) / 100; if (H[k] < hmin) hmin = H[k]; }
    const Y0 = GY + 3.6 - hmin;                       // the lowest ground stands this far clear of the flat floor (the creek cuts under it)
    const dx1 = D.x0 + (D.nx - 1) * D.step, dz1 = D.z0 + (D.nz - 1) * D.step;
    const cr = (p0, p1, p2, p3, t) => 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
    const hRaw = (x, z) => {
      const u = clamp((x - D.x0) / D.step, 0, D.nx - 1.0001), v = clamp((z - D.z0) / D.step, 0, D.nz - 1.0001);
      const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
      const row = (jj) => { const r = clamp(jj, 0, D.nz - 1) * D.nx; return cr(H[r + clamp(i - 1, 0, D.nx - 1)], H[r + i], H[r + clamp(i + 1, 0, D.nx - 1)], H[r + clamp(i + 2, 0, D.nx - 1)], fu); };
      return cr(row(j - 1), row(j), row(j + 1), row(j + 2), fv);
    };
    /** how far (x, z) is outside the surveyed ground */
    const outside = (x, z) => Math.hypot(Math.max(D.x0 - x, 0, x - dx1), Math.max(D.z0 - z, 0, z - dz1));
    /** the surveyed ground, smooth (no creek in it), in game Y */
    const smooth = (x, z) => {
      const d = outside(x, z);
      const h = hRaw(x, z) + Y0;
      return d > 0 ? h + (GY - 1 - h) * sstep(d / APRON) : h;
    };
    const HsN = (x, z, out) => {
      const e = 2, gx = (smooth(x + e, z) - smooth(x - e, z)) / (2 * e), gz = (smooth(x, z + e) - smooth(x, z - e)) / (2 * e), l = Math.hypot(gx, 1, gz);
      out[0] = -gx / l; out[1] = 1 / l; out[2] = -gz / l; return out;
    };

    /* ------------------------------------------------------------ the streets */
    const nodes = data.nodes.map((n, i) => ({ i, x: n[0] / 10, z: n[1] / 10, cut: !!n[2], edges: [] }));
    const KW = { p: 'primary', s: 'secondary', t: 'tertiary', r: 'residential', u: 'residential' };
    const edges = data.edges.map((e, i) => {
      const pts = pairs(e.p), cum = [0];
      for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
      const E = { i, a: e.a, b: e.b, k: e.k, cls: KW[e.k] || 'residential', w: e.w, hw: e.w / 2, name: data.names[e.n] || '', one: !!e.o, pts, cum, len: cum[cum.length - 1] };
      // the bands beside the tarmac: a kerb, then (on the quieter streets) a grass verge, then the pavement
      E.verge = !(e.k === 'p' || e.k === 's');
      E.hKerb = E.hw + 0.3; E.hVerge = E.hKerb + (E.verge ? 1.7 : 0); E.hWalk = E.hVerge + (E.verge ? 1.6 : 3.2);
      nodes[e.a].edges.push(E); nodes[e.b].edges.push(E);
      return E;
    });
    city.nodes = nodes; city.edges = edges;
    const lanes = data.lanes.map((l) => ({ k: l.k, w: l.w, name: data.names[l.n] || '', pts: pairs(l.p) }));
    const areas = data.areas.map((a) => ({ k: a.k, s: a.s || '', f: a.f || '', name: a.n || '', P: pairs(a.p) }));
    const streams = data.streams.map((s) => ({ culvert: !!s.c, pts: pairs(s.p) }));

    /* -------------------------------------------- the ground's height field */
    const fx0 = Math.floor((D.x0 - APRON) / TILE) * TILE, fz0 = Math.floor((D.z0 - APRON) / TILE) * TILE;
    const tnx = Math.ceil((dx1 + APRON - fx0) / TILE), tnz = Math.ceil((dz1 + APRON - fz0) / TILE);
    const nx = tnx * TN + 1, nz = tnz * TN + 1;
    const fh = new Float32Array(nx * nz), R = new Float32Array(nx * nz);
    /** visits the lattice points within r of a polyline: fn(index, distance) */
    const nearLine = (pts, r, fn) => {
      for (let s = 0; s < pts.length - 1; s++) {
        const a = pts[s], b = pts[s + 1];
        const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - r - fx0) / FS)), i1 = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x) + r - fx0) / FS));
        const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - r - fz0) / FS)), j1 = Math.min(nz - 1, Math.ceil((Math.max(a.z, b.z) + r - fz0) / FS));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const d = distSeg(fx0 + i * FS, fz0 + j * FS, a, b); if (d <= r) fn(j * nx + i, d); }
      }
    };
    const inArea = (P, fn) => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const p of P) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
      for (let j = Math.max(0, Math.ceil((z0 - fz0) / FS)); j <= Math.min(nz - 1, Math.floor((z1 - fz0) / FS)); j++)
        for (let i = Math.max(0, Math.ceil((x0 - fx0) / FS)); i <= Math.min(nx - 1, Math.floor((x1 - fx0) / FS)); i++)
          if (inPoly(fx0 + i * FS, fz0 + j * FS, P)) fn(j * nx + i);
    };
    // the creek: a channel where it runs in the open, none where a street or lane crosses (a culvert)
    const CREEK = { depth: 2.3, bed: 2.2, top: 8.5 };
    const carve = new Float32Array(nx * nz), paved = new Uint8Array(nx * nz);
    for (const E of edges) nearLine(E.pts, E.hWalk + 3, (k) => { paved[k] = 1; });
    for (const l of lanes) if (l.k === 'a' || l.k === 's') nearLine(l.pts, l.w / 2 + 3, (k) => { paved[k] = 1; });
    for (const s of streams) {
      if (s.culvert) continue;
      nearLine(s.pts, CREEK.top, (k, d) => { const c = CREEK.depth * sstep((CREEK.top - d) / (CREEK.top - CREEK.bed)); if (c > carve[k]) carve[k] = c; });
    }
    // (a long thin "water" outline with the stream running through it is the creek's own channel: the stream's cut does that)
    for (const a of areas) if (a.k === 'water') { a.channel = streams.some((s) => s.pts.some((p) => inPoly(p.x, p.z, a.P))); if (!a.channel) inArea(a.P, (k) => { carve[k] = Math.max(carve[k], 0.9); }); }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, x = fx0 + i * FS, z = fz0 + j * FS;
      let c = paved[k] ? 0 : carve[k];
      if (c > 0) c *= 1 - sstep(outside(x, z) / 40);
      carve[k] = c;
      R[k] = smooth(x, z);
    }
    // Each tile as coarse as its ground allows (4, 8, 16 or 32 m; 4 m where
    // the creek is cut), the tiles' shared edges as coarse as the coarser one.
    // R is that simplified ground: everything stands on it, so nothing has to
    // follow the survey's every ripple and nothing can poke through anything.
    const exact = R.slice();
    const stride = new Uint8Array(tnx * tnz);
    const tri = (h00, h10, h01, h11, fx, fz) => (fx >= fz ? h00 + (h10 - h00) * fx + (h11 - h10) * fz : h00 + (h11 - h01) * fx + (h01 - h00) * fz);
    const coarse = (src, tx, tz, s, li, lj) => {
      const ci = Math.min(Math.floor(li / s) * s, TN - s), cj = Math.min(Math.floor(lj / s) * s, TN - s);
      const b = (tz * TN + cj) * nx + tx * TN + ci;
      return tri(src[b], src[b + s], src[b + s * nx], src[b + s * nx + s], (li - ci) / s, (lj - cj) / s);
    };
    for (let tz = 0; tz < tnz; tz++) for (let tx = 0; tx < tnx; tx++) {
      const x0 = fx0 + tx * TILE, z0 = fz0 + tz * TILE;
      const far = x0 > BOX.x1 + 30 || x0 + TILE < BOX.x0 - 30 || z0 > BOX.z1 + 30 || z0 + TILE < BOX.z0 - 30;
      let pick = 1, cut = false;
      for (let lj = 0; lj <= TN && !cut; lj++) for (let li = 0; li <= TN; li++) if (carve[(tz * TN + lj) * nx + tx * TN + li] > 0) { cut = true; break; }
      if (far) pick = 8;
      else if (!cut) for (const s of [8, 4, 2]) {
        let worst = 0;
        for (let lj = 0; lj <= TN && worst <= TOL * s; lj++) for (let li = 0; li <= TN; li++) {
          const e = Math.abs(exact[(tz * TN + lj) * nx + tx * TN + li] - coarse(exact, tx, tz, s, li, lj));
          if (e > worst) worst = e;
        }
        if (worst <= TOL * s) { pick = s; break; }
      }
      stride[tz * tnx + tx] = pick;
    }
    const sOf = (tx, tz) => (tx < 0 || tz < 0 || tx >= tnx || tz >= tnz ? 0 : stride[tz * tnx + tx]);
    for (let tz = 0; tz < tnz; tz++) for (let tx = 0; tx <= tnx; tx++) {          // the edges that run north-south
      const es = Math.max(sOf(tx - 1, tz), sOf(tx, tz));
      if (es < 2) continue;
      const i = tx * TN;
      for (let lj = 0; lj < TN; lj++) { if (lj % es === 0) continue; const j0 = tz * TN + Math.floor(lj / es) * es, t = (lj % es) / es; R[(tz * TN + lj) * nx + i] = exact[j0 * nx + i] * (1 - t) + exact[(j0 + es) * nx + i] * t; }
    }
    for (let tz = 0; tz <= tnz; tz++) for (let tx = 0; tx < tnx; tx++) {          // and those that run east-west
      const es = Math.max(sOf(tx, tz - 1), sOf(tx, tz));
      if (es < 2) continue;
      const j = tz * TN;
      for (let li = 0; li < TN; li++) { if (li % es === 0) continue; const i0 = tx * TN + Math.floor(li / es) * es, t = (li % es) / es; R[j * nx + tx * TN + li] = exact[j * nx + i0] * (1 - t) + exact[j * nx + i0 + es] * t; }
    }
    for (let tz = 0; tz < tnz; tz++) for (let tx = 0; tx < tnx; tx++) {
      const s = stride[tz * tnx + tx];
      if (s < 2) continue;
      const tmp = [];
      for (let lj = 1; lj < TN; lj++) for (let li = 1; li < TN; li++) if (li % s || lj % s) tmp.push((tz * TN + lj) * nx + tx * TN + li, coarse(R, tx, tz, s, li, lj));
      for (let k = 0; k < tmp.length; k += 2) R[tmp[k]] = tmp[k + 1];
    }
    for (let k = 0; k < fh.length; k++) fh[k] = R[k] - BIAS - carve[k];
    /** the ground everything stands on (the creek not cut into it) */
    const Hs = (x, z) => {
      const u = clamp((x - fx0) / FS, 0, nx - 1.0001), v = clamp((z - fz0) / FS, 0, nz - 1.0001);
      const i = Math.floor(u), j = Math.floor(v), k = j * nx + i;
      return tri(R[k], R[k + 1], R[k + nx], R[k + nx + 1], u - i, v - j);
    };
    city.Hs = Hs; city.smooth = smooth;
    const field = { x0: fx0, z0: fz0, step: FS, inv: 1 / FS, nx, nz, h: fh, grip: 0.5 };
    /** the ground's height at (x, z), exactly as the physics and the drawn grid have it */
    const groundY = (x, z) => {
      const u = clamp((x - fx0) / FS, 0, nx - 1.0001), v = clamp((z - fz0) / FS, 0, nz - 1.0001);
      const i = Math.floor(u), j = Math.floor(v), k = j * nx + i;
      return tri(fh[k], fh[k + 1], fh[k + nx], fh[k + nx + 1], u - i, v - j);
    };
    city.field = field; city.groundY = groundY;

    /* --------------------------------------- what stands where (a 2 m grid) */
    // 1 street tarmac, 2 pavement/verge, 3 lane or car park, 4 building, 5 water, 6 sports ground
    const OS = 2, onx = Math.ceil((BOX.x1 - BOX.x0) / OS) + 1, onz = Math.ceil((BOX.z1 - BOX.z0) / OS) + 1;
    const occ = new Uint8Array(onx * onz);
    const occLine = (pts, r, v, keep) => {
      for (let s = 0; s < pts.length - 1; s++) {
        const a = pts[s], b = pts[s + 1];
        const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - r - BOX.x0) / OS)), i1 = Math.min(onx - 1, Math.ceil((Math.max(a.x, b.x) + r - BOX.x0) / OS));
        const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - r - BOX.z0) / OS)), j1 = Math.min(onz - 1, Math.ceil((Math.max(a.z, b.z) + r - BOX.z0) / OS));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = j * onx + i; if (keep && occ[k]) continue; if (distSeg(BOX.x0 + i * OS, BOX.z0 + j * OS, a, b) <= r) occ[k] = v; }
      }
    };
    const occPoly = (P, v, grow) => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const p of P) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
      const gr = grow || 0;
      for (let j = Math.max(0, Math.floor((z0 - gr - BOX.z0) / OS)); j <= Math.min(onz - 1, Math.ceil((z1 + gr - BOX.z0) / OS)); j++)
        for (let i = Math.max(0, Math.floor((x0 - gr - BOX.x0) / OS)); i <= Math.min(onx - 1, Math.ceil((x1 + gr - BOX.x0) / OS)); i++) {
          const x = BOX.x0 + i * OS, z = BOX.z0 + j * OS;
          let hit = inPoly(x, z, P);
          if (!hit && gr) for (let q = 0; q < P.length && !hit; q++) hit = distSeg(x, z, P[q], P[(q + 1) % P.length]) <= gr;
          if (hit) occ[j * onx + i] = v;
        }
    };
    const occAt = (x, z) => { const i = Math.round((x - BOX.x0) / OS), j = Math.round((z - BOX.z0) / OS); return i < 0 || j < 0 || i >= onx || j >= onz ? 255 : occ[j * onx + i]; };
    city.occAt = occAt;

    /* -------------------------------------------------- collecting geometry */
    // drawn geometry, by chunk and group; and what the physics needs
    const accs = new Map();
    const acc = (x, z, group) => {
      const key = Math.floor(x / CHUNK) + ':' + Math.floor(z / CHUNK) + ':' + group;
      let a = accs.get(key);
      if (!a) { a = { group, p: [], n: [], c: [], u: [] }; accs.set(key, a); }
      return a;
    };
    const phys = [];                 // flat triangles a wheel can stand on: 9 positions + 9 normals each
    const solids = [];               // walls: quads as 12 numbers + 3 (a point inside)
    city.phys = phys; city.solids = solids;
    const nA = [0, 0, 0], nB = [0, 0, 0], nC = [0, 0, 0];
    let flatTris = 0, physOnly = false, noPhys = false;
    /**
     * A flat triangle, laid on the ground `lift` above it. Split wherever the
     * ground bends away from it (tested at the middle of each edge, so two
     * triangles that share an edge split it alike and no gap opens).
     */
    const drape = (group, lift, col, ax, az, bx, bz, cx, cz, physOn, depth) => {
      const ya = Hs(ax, az), yb = Hs(bx, bz), yc = Hs(cx, cz);
      const rec = (ax, az, ya, bx, bz, yb, cx, cz, yc, lvl) => {
        let sab = false, sbc = false, sca = false, mab, mbc, mca;
        if (lvl < 6) {
          const test = (x0, z0, y0, x1, z1, y1) => { const L2 = (x1 - x0) * (x1 - x0) + (z1 - z0) * (z1 - z0); if (L2 < 9) return null; const y = Hs((x0 + x1) / 2, (z0 + z1) / 2); return Math.abs(y - (y0 + y1) / 2) > 0.022 || L2 > 1600 ? y : null; };
          mab = test(ax, az, ya, bx, bz, yb); mbc = test(bx, bz, yb, cx, cz, yc); mca = test(cx, cz, yc, ax, az, ya);
          sab = mab !== null; sbc = mbc !== null; sca = mca !== null;
        }
        const n = (sab ? 1 : 0) + (sbc ? 1 : 0) + (sca ? 1 : 0);
        if (!n) { emit(ax, az, ya, bx, bz, yb, cx, cz, yc); return; }
        const abx = (ax + bx) / 2, abz = (az + bz) / 2, bcx = (bx + cx) / 2, bcz = (bz + cz) / 2, cax = (cx + ax) / 2, caz = (cz + az) / 2;
        if (n === 3) {
          rec(ax, az, ya, abx, abz, mab, cax, caz, mca, lvl + 1); rec(abx, abz, mab, bx, bz, yb, bcx, bcz, mbc, lvl + 1);
          rec(cax, caz, mca, bcx, bcz, mbc, cx, cz, yc, lvl + 1); rec(abx, abz, mab, bcx, bcz, mbc, cax, caz, mca, lvl + 1);
        } else if (n === 1) {
          if (sab) { rec(ax, az, ya, abx, abz, mab, cx, cz, yc, lvl + 1); rec(abx, abz, mab, bx, bz, yb, cx, cz, yc, lvl + 1); }
          else if (sbc) { rec(ax, az, ya, bx, bz, yb, bcx, bcz, mbc, lvl + 1); rec(ax, az, ya, bcx, bcz, mbc, cx, cz, yc, lvl + 1); }
          else { rec(ax, az, ya, bx, bz, yb, cax, caz, mca, lvl + 1); rec(cax, caz, mca, bx, bz, yb, cx, cz, yc, lvl + 1); }
        } else if (!sab) { rec(ax, az, ya, bx, bz, yb, cax, caz, mca, lvl + 1); rec(bx, bz, yb, bcx, bcz, mbc, cax, caz, mca, lvl + 1); rec(cax, caz, mca, bcx, bcz, mbc, cx, cz, yc, lvl + 1); }
        else if (!sbc) { rec(ax, az, ya, abx, abz, mab, cax, caz, mca, lvl + 1); rec(abx, abz, mab, bx, bz, yb, cx, cz, yc, lvl + 1); rec(abx, abz, mab, cx, cz, yc, cax, caz, mca, lvl + 1); }
        else { rec(ax, az, ya, abx, abz, mab, cx, cz, yc, lvl + 1); rec(abx, abz, mab, bx, bz, yb, bcx, bcz, mbc, lvl + 1); rec(abx, abz, mab, bcx, bcz, mbc, cx, cz, yc, lvl + 1); }
      };
      const emit = (ax, az, ya, bx, bz, yb, cx, cz, yc) => {
        // facing up
        if ((bz - az) * (cx - ax) - (bx - ax) * (cz - az) < 0) { let t = bx; bx = cx; cx = t; t = bz; bz = cz; cz = t; t = yb; yb = yc; yc = t; }
        HsN(ax, az, nA); HsN(bx, bz, nB); HsN(cx, cz, nC);
        flatTris++;
        if (opts.visual !== false && group && !physOnly) {
          const a = acc((ax + bx + cx) / 3, (az + bz + cz) / 3, group);
          a.p.push(ax, ya + lift, az, bx, yb + lift, bz, cx, yc + lift, cz);
          a.n.push(nA[0], nA[1], nA[2], nB[0], nB[1], nB[2], nC[0], nC[1], nC[2]);
          a.c.push(col[0], col[1], col[2], col[0], col[1], col[2], col[0], col[1], col[2]);
        }
        if (physOn && !noPhys) phys.push(ax, ya + lift, az, bx, yb + lift, bz, cx, yc + lift, cz, nA[0], nA[1], nA[2], nB[0], nB[1], nB[2], nC[0], nC[1], nC[2], depth || 0.5);
      };
      rec(ax, az, ya, bx, bz, yb, cx, cz, yc, 0);
    };
    const flatQuad = (layer, col, a, b, c, d, group) => {
      const L = LAYER[layer];
      drape(group || layer, L.lift, col, a.x, a.z, b.x, b.z, c.x, c.z, L.phys);
      drape(group || layer, L.lift, col, a.x, a.z, c.x, c.z, d.x, d.z, L.phys);
    };
    const flatPoly = (layer, col, P, group) => {
      const L = LAYER[layer];
      for (const t of triangulate(P)) drape(group || layer, L.lift, col, P[t[0]].x, P[t[0]].z, P[t[1]].x, P[t[1]].z, P[t[2]].x, P[t[2]].z, L.phys);
    };
    const flatDisc = (layer, col, x, z, r) => {
      const L = LAYER[layer], n = r > 9 ? 20 : 14;
      for (let k = 0; k < n; k++) {
        const a0 = k / n * Math.PI * 2, a1 = (k + 1) / n * Math.PI * 2;
        drape(layer, L.lift, col, x, z, x + Math.cos(a0) * r, z + Math.sin(a0) * r, x + Math.cos(a1) * r, z + Math.sin(a1) * r, L.phys);
      }
    };
    /** stations along a line, no more than `gap` apart, each with its left-hand normal (mitred at a bend) */
    const stations = (pts, gap, d0, d1) => {
      const cum = [0];
      for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
      const len = cum[cum.length - 1];
      d0 = d0 || 0; d1 = d1 === undefined ? len : d1;
      if (d1 - d0 < 0.5) return [];
      const at = (d) => {
        let k = 0; while (k < pts.length - 2 && cum[k + 1] < d) k++;
        const t = clamp((d - cum[k]) / Math.max(cum[k + 1] - cum[k], 1e-6), 0, 1), a = pts[k], b = pts[k + 1], L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, tx: (b.x - a.x) / L, tz: (b.z - a.z) / L, d };
      };
      const ds = [d0];
      for (let k = 0; k < pts.length - 1; k++) {
        const s0 = Math.max(cum[k], d0), s1 = Math.min(cum[k + 1], d1);
        if (s1 <= s0) continue;
        const n = Math.max(1, Math.ceil((s1 - s0) / gap));
        for (let q = 1; q <= n; q++) ds.push(s0 + (s1 - s0) * q / n);
      }
      const out = [];
      for (let q = 0; q < ds.length; q++) {
        const s = at(ds[q]);
        // at a bend: the mean of the two directions, the offset stretched so the band keeps its width
        let tx = s.tx, tz = s.tz, m = 1;
        const k = cum.indexOf(ds[q]);
        if (k > 0 && k < pts.length - 1) {
          const a = pts[k - 1], b = pts[k], c = pts[k + 1];
          const L0 = Math.hypot(b.x - a.x, b.z - a.z) || 1, L1 = Math.hypot(c.x - b.x, c.z - b.z) || 1;
          const ux = (b.x - a.x) / L0, uz = (b.z - a.z) / L0, vx = (c.x - b.x) / L1, vz = (c.z - b.z) / L1;
          const sx = ux + vx, sz = uz + vz, sl = Math.hypot(sx, sz);
          if (sl > 0.3) { tx = sx / sl; tz = sz / sl; m = Math.min(1.5, 1 / Math.max(0.3, tx * ux + tz * uz)); s.bend = Math.acos(clamp(ux * vx + uz * vz, -1, 1)); }
        }
        s.tx = tx; s.tz = tz; s.lx = tz * m; s.lz = -tx * m;          // left of travel
        out.push(s);
      }
      return out;
    };
    /** a band of the given half-width along a line (or between two offsets) */
    const ribbon = (layer, col, pts, hw, o) => {
      o = o || {};
      const S = stations(pts, o.gap || 24, o.d0, o.d1), off = o.off || 0;
      for (let q = 0; q < S.length - 1; q++) {
        const a = S[q], b = S[q + 1];
        flatQuad(layer, col, { x: a.x + a.lx * (off + hw), z: a.z + a.lz * (off + hw) }, { x: a.x + a.lx * (off - hw), z: a.z + a.lz * (off - hw) },
          { x: b.x + b.lx * (off - hw), z: b.z + b.lz * (off - hw) }, { x: b.x + b.lx * (off + hw), z: b.z + b.lz * (off + hw) }, o.group);
      }
      return S;
    };

    /* ----------------------------------------------------- streets as layers */
    const C = {}; for (const k in COL) C[k] = rgb(COL[k]);
    /* With the aerial photo on the ground, the photo IS the verges, drives,
       car parks, paths and pitches: those layers are still there for the
       wheels but are not drawn. The streets keep their own clean tarmac, kerb,
       paint and a strip of pavement (a photo at 40 cm a pixel is a blur under
       the car, and half the streets lie under trees in it). */
    const photo = !!data.photo && opts.photo !== false;
    city.photo = photo;
    for (const E of edges) {
      physOnly = true;
      ribbon('walk', C.walk, E.pts, (E.hWalk - E.hw) / 2 + 0.2, { off: (E.hWalk + E.hw) / 2 - 0.2 });
      ribbon('walk', C.walk, E.pts, (E.hWalk - E.hw) / 2 + 0.2, { off: -(E.hWalk + E.hw) / 2 + 0.2 });
      physOnly = false; noPhys = true;
      if (!photo) ribbon('walk', C.walk, E.pts, E.hWalk);
      else for (const sd of [1, -1]) {
        if (E.verge) ribbon('walk', C.walk, E.pts, 0.8, { off: sd * (E.hVerge + 0.8) });
        else ribbon('walk', C.walk, E.pts, (E.hWalk - E.hKerb) / 2 + 0.1, { off: sd * (E.hWalk + E.hKerb) / 2 });
      }
      noPhys = false;
      if (E.verge && !photo) ribbon('verge', C.verge, E.pts, E.hVerge);
      ribbon('kerb', C.kerb, E.pts, E.hKerb);
      const S = ribbon('road', C.road, E.pts, E.hw);
      occLine(E.pts, E.hWalk, 2, true);
      // a sharp bend inside a stretch: rounded like a junction
      for (const s of S) if (s.bend > 0.5) { flatDisc('walk', C.walk, s.x, s.z, E.hWalk); flatDisc('kerb', C.kerb, s.x, s.z, E.hKerb); flatDisc('road', C.road, s.x, s.z, E.hw); }
    }
    for (const E of edges) occLine(E.pts, E.hw, 1);
    for (const n of nodes) {
      if (!n.edges.length) continue;
      let straight = false;
      if (n.edges.length === 2 && n.edges[0].w === n.edges[1].w) {
        const dir = (E) => { const P = E.pts, k = E.a === n.i ? 1 : P.length - 2, q = E.a === n.i ? P[0] : P[P.length - 1]; const L = Math.hypot(P[k].x - q.x, P[k].z - q.z) || 1; return [(P[k].x - q.x) / L, (P[k].z - q.z) / L]; };
        const d0 = dir(n.edges[0]), d1 = dir(n.edges[1]);
        straight = d0[0] * d1[0] + d0[1] * d1[1] < -0.985;
      }
      n.rRoad = Math.max.apply(null, n.edges.map((E) => E.hw));
      if (straight || (n.cut && n.edges.length === 1)) continue;
      noPhys = true;
      if (!photo) flatDisc('walk', C.walk, n.x, n.z, Math.max.apply(null, n.edges.map((E) => E.hWalk)));
      noPhys = false;
      if (!photo && n.edges.some((E) => E.verge)) flatDisc('verge', C.verge, n.x, n.z, Math.max.apply(null, n.edges.map((E) => (E.verge ? E.hVerge : 0))));
      flatDisc('kerb', C.kerb, n.x, n.z, Math.max.apply(null, n.edges.map((E) => E.hKerb)));
      flatDisc('road', C.road, n.x, n.z, n.rRoad);
    }
    /* the paint: a double yellow line down the middle of the main two-way
       streets, a broken white one between the lanes of the one-way ones, a
       stop bar where a smaller street meets a bigger one */
    const RANK = { p: 4, s: 3, t: 2, r: 1, u: 1 };
    for (const E of edges) {
      const na = nodes[E.a], nb = nodes[E.b];
      const clearOf = (n) => (n.edges.length < 2 || (n.edges.length === 2 && !n.cut && n.rRoad === E.hw) ? 0 : Math.max.apply(null, n.edges.map((F) => (F === E ? 0 : F.hw))) + 2.5);
      const d0 = clearOf(na), d1 = E.len - clearOf(nb);
      if (d1 - d0 < 6) continue;
      if (RANK[E.k] >= 2 && !E.one) {
        ribbon('paint', C.yellow, E.pts, 0.06, { off: 0.13, d0, d1, gap: 20 });
        ribbon('paint', C.yellow, E.pts, 0.06, { off: -0.13, d0, d1, gap: 20 });
      } else if (RANK[E.k] >= 2 && E.one && E.w >= 9) {
        for (let d = d0 + 2; d + 3 < d1; d += 12) ribbon('paint', C.white, E.pts, 0.06, { d0: d, d1: d + 3, gap: 20 });
      }
      // stop bars, across the lane that arrives at the junction (traffic keeps right)
      const bar = (n, atEnd) => {
        if (n.edges.length < 3) return;
        const top = Math.max.apply(null, n.edges.map((F) => RANK[F.k]));
        if (RANK[E.k] >= top && top < 3) { if (hash2(n.i, 7) < 0.5) return; }      // equal residential streets: some are four-way stops
        else if (RANK[E.k] >= top) return;
        if (E.one && !atEnd) return;
        const d = atEnd ? d1 - 0.6 : d0 + 0.6;
        const half = E.one ? E.hw - 0.4 : E.hw / 2 - 0.3, off = E.one ? 0 : (atEnd ? -1 : 1) * (E.hw / 2);
        ribbon('paint', C.white, E.pts, half, { off, d0: d - 0.25, d1: d + 0.25, gap: 20 });
        n.stops = n.stops || []; n.stops.push({ E, atEnd, d });
      };
      bar(nb, true); bar(na, false);
    }

    /* ------------------------------------------------ lanes, paths, car parks */
    physOnly = photo;
    for (const l of lanes) {
      if (l.k === 'f') { ribbon('walk', C.walk, l.pts, l.w / 2, { gap: 12 }); occLine(l.pts, l.w / 2, 2, true); }
      else { ribbon('lot', C.lot, l.pts, l.w / 2, { gap: 12 }); occLine(l.pts, l.w / 2, 3, true); }
    }
    for (const a of areas) {
      if (a.k === 'parking') { flatPoly('lot', C.lot, a.P); occPoly(a.P, 3); }
      else if (a.k === 'pitch') {
        const s = a.s;
        const col = /tennis|basketball|pickleball/.test(s) ? C.court : /beachvolleyball/.test(s) ? C.sand : C.turf;
        flatPoly('pitch', col, a.P); occPoly(a.P, 6);
        if (a.P.length === 4 && /tennis|football|soccer|ultimate/.test(s)) {
          // its lines: the boundary, and what crosses it
          const P = a.P, seg = (p, q, w) => { const L = Math.hypot(q.x - p.x, q.z - p.z) || 1, nx = (q.z - p.z) / L * w, nz = -(q.x - p.x) / L * w; flatQuad('mark', C.white, { x: p.x + nx, z: p.z + nz }, { x: p.x - nx, z: p.z - nz }, { x: q.x - nx, z: q.z - nz }, { x: q.x + nx, z: q.z + nz }); };
          const mid = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t });
          const inset = P.map((p, i) => { const c = { x: (P[0].x + P[1].x + P[2].x + P[3].x) / 4, z: (P[0].z + P[1].z + P[2].z + P[3].z) / 4 }, L = Math.hypot(c.x - p.x, c.z - p.z) || 1, d = /tennis/.test(s) ? 1.4 : 2.2; return { x: p.x + (c.x - p.x) / L * d, z: p.z + (c.z - p.z) / L * d }; });
          const w = /tennis/.test(s) ? 0.04 : 0.07;
          for (let i = 0; i < 4; i++) seg(inset[i], inset[(i + 1) % 4], w);
          // the long sides are 0-1 and 2-3, or 1-2 and 3-0
          const long01 = Math.hypot(inset[1].x - inset[0].x, inset[1].z - inset[0].z) > Math.hypot(inset[2].x - inset[1].x, inset[2].z - inset[1].z);
          const A = long01 ? [inset[0], inset[1], inset[3], inset[2]] : [inset[1], inset[2], inset[0], inset[3]];
          const len = Math.hypot(A[1].x - A[0].x, A[1].z - A[0].z);
          if (/american_football/.test(s)) for (let d = 9.144; d < len - 1; d += 9.144) seg(mid(A[0], A[1], d / len), mid(A[2], A[3], d / len), 0.05);
          else seg(mid(A[0], A[1], 0.5), mid(A[2], A[3], 0.5), w);
          a.long = A; a.len = len;
        }
      } else if (a.k === 'track') {
        if (Math.abs(polyArea(a.P)) > 4000) {
          // a running track: the outline is its middle. Grass inside, the track as a band on it, white lane lines
          const loop = a.P.concat([a.P[0], a.P[1]]);
          flatPoly('ground', C.turf, a.P);
          ribbon('pitch', C.track, loop, 4.9, { gap: 10 });
          for (const o of [-4.8, -2.4, 0, 2.4, 4.8]) ribbon('mark', C.white, loop, 0.05, { off: o, gap: 10 });
          occLine(loop, 5, 6);
        } else flatPoly('ground', C.track, a.P);
        occPoly(a.P, 6);
      }
      else if (a.k === 'playground') { flatPoly('ground', C.bark, a.P); occPoly(a.P, 6); }
      else if (a.k === 'sand') { flatPoly('ground', C.sand, a.P); }
      else if (a.k === 'water' && !a.channel) occPoly(a.P, 5, 1);
    }
    for (const s of streams) if (!s.culvert) occLine(s.pts, CREEK.top, 5, true);
    physOnly = false;
    // marked crossings: white bars along the road, side by side across it
    {
      const cr = (data.points && data.points.crossing) || [];
      for (let k = 0; k < cr.length; k += 2) {
        const x = cr[k] / 10, z = cr[k + 1] / 10;
        let best = null, bd = 3;
        for (const E of edges) for (let q = 0; q < E.pts.length - 1; q++) {
          const a = E.pts[q], b = E.pts[q + 1], dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1e-9, t = clamp(((x - a.x) * dx + (z - a.z) * dz) / L2, 0, 1);
          const d = Math.hypot(x - a.x - dx * t, z - a.z - dz * t);
          if (d < bd) { bd = d; best = { E, d: E.cum[q] + Math.sqrt(L2) * t }; }
        }
        if (!best || best.d < 2 || best.d > best.E.len - 2) continue;
        const E = best.E;
        for (let o = -E.hw + 0.7; o <= E.hw - 0.7; o += 1.25) ribbon('paint', C.white, E.pts, 0.27, { off: o, d0: best.d - 1.5, d1: best.d + 1.5, gap: 20 });
      }
    }

    city.areas = areas; city.lanes = lanes; city.streams = streams;
    city.CREEK = CREEK; city.carve = carve;
    city._ = { acc, accs, drape, flatQuad, flatPoly, flatDisc, ribbon, stations, occ, occLine, occPoly, onx, onz, OS, C, rgb, Hs, HsN, smooth, groundY, R, tnx, tnz, stride, nx, nz, fx0, fz0, fh, triangulate, inPoly, polyArea, distSeg, hash2, rng, pairs, detail, LAYER, COL, exact };

    /* -------------------------------------------------------------- buildings */
    city.buildings = data.buildings.map((b, i) => ({ i, k: b.k, lv: b.l || 0, name: b.n || '', tag: b.t || '', P: pairs(b.p),
      hh: b.h ? [b.h[0] / 10, b.h[1] / 10] : null, rc: b.c, up: b.up || null }));
    const vis = opts.visual !== false;
    if (opts.special) city.special = opts.special;
    dress(city, vis);

    /* ---------------------------------------------------------------- places */
    city.places = (data.places || []).map((p) => ({ name: p.n, kind: p.k, x: p.x / 10, z: p.z / 10 }));
    // where a car can be put down: points along the streets, facing along them
    const spots = [];
    for (const E of edges) {
      const S = stations(E.pts, 18);
      for (const s of S) {
        if (s.d < 8 || s.d > E.len - 8) continue;
        // on the right-hand side of a two-way street
        const off = E.one ? 0 : -E.hw / 2;
        spots.push({ x: s.x + s.lx * off, z: s.z + s.lz * off, heading: Math.atan2(s.tx, s.tz), name: E.name, E });
      }
    }
    city.spots = spots;
    city.nearestStreet = (x, z) => { let best = null, bd = Infinity; for (const s of spots) { const d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z); if (d < bd) { bd = d; best = s; } } return best; };
    /** the street (x, z) is on, or '' */
    city.streetName = (x, z) => {
      let best = '', bd = Infinity;
      for (const E of edges) {
        if (!E.name) continue;
        for (let k = 0; k < E.pts.length - 1; k++) { const d = distSeg(x, z, E.pts[k], E.pts[k + 1]) - E.hw; if (d < bd) { bd = d; best = E.name; } }
      }
      return bd < 6 ? best : '';
    };
    // the start: on East 19th Avenue in front of the school, heading east
    {
      const school = city.places.find((p) => /South Eugene High School$/.test(p.name)) || { x: 0, z: 0 };
      let best = spots[0], bd = Infinity;
      for (const s of spots) { if (!/19th Avenue/.test(s.name)) continue; const d = Math.hypot(s.x - school.x, s.z - school.z) + (Math.sin(s.heading) < -0.5 ? 0 : 400); if (d < bd) { bd = d; best = s; } }
      city.spawn = { x: best.x, y: Hs(best.x, best.z) + LAYER.road.lift, z: best.z, heading: best.heading };
    }
    city.stats = { flatTris, physTris: phys.length / 19, solids: solids.length / 15, tiles: tnx * tnz, strides: Array.from(stride).reduce((m, s) => { m[s] = (m[s] || 0) + 1; return m; }, {}) };
    city.intoWorld = (world) => intoWorld(city, world);
    if (vis) city.root = assemble(city);
    city.stats.trees = city.trees.length; city.stats.solids = solids.length / 15;
    return city;
  }

  /** solid walls round an outline, from y0 up to y1 */
  function wallSolids(city, P, y0, y1) {
    const sg = wind(P);
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length], I = within(P, i, sg);
      city.solids.push(a.x, y0, a.z, b.x, y0, b.z, b.x, y1, b.z, a.x, y1, a.z, I.x, (y0 + y1) / 2, I.z);
    }
  }
  /** which way round an outline runs, and a point just inside its i-th wall (by the outline itself: its middle
      is no guide, since an outline with a notch has walls that face its own middle) */
  function wind(P) { let a = 0; for (let i = 0; i < P.length; i++) { const q = P[(i + 1) % P.length]; a += P[i].x * q.z - q.x * P[i].z; } return a >= 0 ? 1 : -1; }
  function within(P, i, sg) {
    const p = P[i], q = P[(i + 1) % P.length], L = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    return { x: (p.x + q.x) / 2 - sg * (q.z - p.z) / L * 0.4, z: (p.z + q.z) / 2 + sg * (q.x - p.x) / L * 0.4 };
  }

  /* ======================================================== what stands on it
     Buildings, trees and street furniture. Their solid parts are always made
     (the physics is the same on every computer and under Node); what is
     drawn is made only when `vis`. Every building keeps its real outline; a
     house gets one of a few local looks, picked from its position, never
     anything that identifies it.                                            */
  const PAL = {
    wall: [0xd8d2c0, 0x8c9aa3, 0x7d8f6f, 0xb5a27a, 0x9c5a44, 0x6f7f8c, 0xe6e2d8, 0xc7a85a, 0x7a6a5a, 0x5f6f66, 0xa3b3bd, 0xb98a70, 0xcfc8b4, 0x86705c],
    roof: [0x3e4046, 0x55504a, 0x4a4f57, 0x5d4a3e, 0x6a6e72, 0x44484a],
    door: [0x8a2f2a, 0x2f5a6a, 0x6a4a2a, 0x2a2f36, 0xd9b23a, 0x3f6a4a],
    shop: [0xb8b2a6, 0x9a7a62, 0xc9c4b8, 0x7f8790, 0xa85a44, 0xd6cdb4, 0x8f9a8a],
    flats: [0xc9c0aa, 0x9aa3a8, 0xb59a7a, 0x8a9a86, 0xd9d4c6, 0xa88a72],
    awning: [0x2f5a4a, 0x7a2f2a, 0x2a3f6a, 0x3a3a3a, 0x8a6a2a],
    leaf: [0x4f8f42, 0x5a9a48, 0x67a34c, 0x4a8440, 0x78a850],
    autumn: [0xc9a227, 0xd98a2a, 0xb9541f, 0xa83a24, 0xd9b84a],
    fir: [0x3a6b40, 0x34603a, 0x417245, 0x2f5836]
  };
  const TRIM = 0xecebe6, GLASS = 0x26343f, CONCRETE = 0x9a9b97, TAR = 0x4a4b4e, TRUNK = 0x4f3f30;
  /* One picture holds every wall: sixteen rows, each one bay wide (it repeats
     along a wall) and one storey tall. A wall's own colour multiplies it, so
     the picture is in greys: the wall at 80%, trim white, glass dark. Row 0
     is plain white, for everything that has no picture. */
  const ROWS = 16, WALLK = 0.6;          // (80% grey is 0.6 of the light: a wall's colour is divided by it)
  const ROW = { plain: 0, win: 1, siding: 2, flats: 3, shop: 4, masonry: 5, school: 6, church: 7, garage: 8, brick: 9, panel: 10, gym: 11, entry: 12, band2: 13 };
  const rowV = (r) => [1 - (r + 1) / ROWS + 0.004, 1 - r / ROWS - 0.004];
  function facades() {
    if (typeof document === 'undefined') return null;
    // two drawings: the picture, and a mask saying which of it takes the wall's colour
    // (white: the wall, in greys) and which keeps its own (black: glass, frames)
    const W = 256, RH = 128, H = RH * ROWS, mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
    const cv = mk(), cm = mk(), g = cv.getContext('2d'), gm = cm.getContext('2d');
    const enc = (v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
    const own = (hex) => { const c = rgb(hex); return 'rgb(' + enc(c[0]) + ',' + enc(c[1]) + ',' + enc(c[2]) + ')'; };
    const WALL = '#cccccc', LINE = '#bdbdbd', WHITE = own(0xf2f1eb), GL = own(0x33424f), GL2 = own(0x566777), DARK = own(0x2f343a), DOORP = own(0xdededa), DOORL = own(0xb9b9b4);
    let oy = 0;
    const row = (r, fn) => { oy = r * RH; for (const c of [g, gm]) { c.save(); c.beginPath(); c.rect(0, oy, W, RH); c.clip(); } fn(); g.restore(); gm.restore(); };
    /** a wall-coloured patch (a grey) */
    const R = (c, x, y, w, h) => { g.fillStyle = c; g.fillRect(x, oy + y, w, h); gm.fillStyle = '#fff'; gm.fillRect(x, oy + y, w, h); };
    /** a patch with its own colour */
    const O = (c, x, y, w, h) => { g.fillStyle = c; g.fillRect(x, oy + y, w, h); gm.fillStyle = '#000'; gm.fillRect(x, oy + y, w, h); };
    const siding = () => { R(WALL, 0, 0, W, RH); for (let y = 6; y < RH; y += 9) R(LINE, 0, y, W, 1.5); };
    row(0, () => R('#ffffff', 0, 0, W, RH));
    row(ROW.win, () => {                 // a house: lap siding, one sash window in its frame
      siding(); O(WHITE, 76, 22, 104, 70); O(GL, 83, 27, 90, 60); O(GL2, 83, 27, 90, 12); O(WHITE, 83, 55, 90, 3); O(WHITE, 126.5, 27, 3, 60); O(WHITE, 72, 91, 112, 4);
    });
    row(ROW.siding, siding);
    row(ROW.flats, () => {               // flats: plain render, a wide sliding window, a line at each floor
      R(WALL, 0, 0, W, RH); R(LINE, 0, 0, W, 3); O(WHITE, 62, 30, 132, 62); O(GL, 68, 35, 120, 52); O(GL2, 68, 35, 120, 10); O(WHITE, 126, 35, 4, 52);
    });
    row(ROW.shop, () => {                // a shop front: glass from knee to head height between slim posts
      R(WALL, 0, 0, W, RH); O(DARK, 0, 46, W, 70); O(GL, 5, 49, 118, 64); O(GL, 133, 49, 118, 64); O(GL2, 5, 49, 118, 9); O(GL2, 133, 49, 118, 9); R(LINE, 0, 116, W, 12);
    });
    row(ROW.masonry, () => {             // the other walls of a shop: block courses
      R(WALL, 0, 0, W, RH); for (let y = 0; y < RH; y += 16) R(LINE, 0, y, W, 1.5); for (let y = 0, k = 0; y < RH; y += 16, k++) for (let x = (k % 2) * 32; x < W; x += 64) R(LINE, x, y, 1.5, 16);
    });
    row(ROW.school, () => {              // a school wing: a band of windows the length of the wall
      R(WALL, 0, 0, W, RH); O(WHITE, 0, 34, W, 62); O(GL, 0, 39, W, 52); O(GL2, 0, 39, W, 9); for (let x = 0; x < W; x += 64) O(WHITE, x - 2, 39, 4, 52); R(LINE, 0, 100, W, 2); R(LINE, 0, 28, W, 2);
    });
    row(ROW.church, () => {              // a church: one tall narrow window with a round head
      R(WALL, 0, 0, W, RH);
      for (const [c, col, mcol] of [[g, WHITE, '#000'], [gm, '#000', '#000']]) { c.fillStyle = c === g ? col : mcol; c.fillRect(104, oy + 34, 48, 62); c.beginPath(); c.arc(128, oy + 34, 24, Math.PI, 0); c.fill(); }
      for (const c of [g, gm]) { c.fillStyle = c === g ? own(0x4a5f7a) : '#000'; c.fillRect(110, oy + 36, 36, 56); c.beginPath(); c.arc(128, oy + 36, 18, Math.PI, 0); c.fill(); }
      O(WHITE, 126.5, 20, 3, 72);
    });
    row(ROW.garage, () => {              // a garage: its door, in panels
      siding(); O(WHITE, 22, 16, 212, 112); O(DOORP, 28, 22, 200, 106); for (let y = 22; y < RH; y += 26) O(DOORL, 28, y, 200, 2);
    });
    row(ROW.brick, () => {               // brick
      R(WALL, 0, 0, W, RH); for (let y = 0, k = 0; y < RH; y += 8, k++) { R('#b4b4b4', 0, y, W, 1.2); for (let x = (k % 2) * 16; x < W; x += 32) R('#b4b4b4', x, y, 1.2, 8); }
    });
    row(ROW.panel, () => {               // a big plain building: panels with a joint each bay
      R(WALL, 0, 0, W, RH); R(LINE, 0, 0, 2, RH); R(LINE, 0, 62, W, 2);
    });
    row(ROW.gym, () => {                 // a hall: a strip of high windows
      R(WALL, 0, 0, W, RH); O(WHITE, 0, 18, W, 30); O(GL, 0, 22, W, 22); for (let x = 0; x < W; x += 51.2) O(WHITE, x - 2, 22, 4, 22); R(LINE, 0, 0, 2, RH);
    });
    row(ROW.entry, () => {               // a public building's entrance: glass doors and a glazed screen, full height
      R(WALL, 0, 0, W, RH); O(DARK, 0, 20, W, 108); for (let x = 0; x < W; x += 64) { O(GL, x + 3, 24, 58, 100); O(GL2, x + 3, 24, 58, 14); } O(DARK, 0, 62, W, 3);
    });
    row(ROW.band2, () => {               // a modern wing: two rows of square windows in panels
      R(WALL, 0, 0, W, RH); R(LINE, 0, 0, 2, RH); for (const x of [34, 150]) { O(WHITE, x - 4, 30, 80, 62); O(GL, x, 34, 72, 54); O(GL2, x, 34, 72, 10); }
    });
    // one picture with the mask as its alpha (the canvas would lose the colour of see-through pixels)
    const px = g.getImageData(0, 0, W, H).data, mp = gm.getImageData(0, 0, W, H).data, data = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = ((H - 1 - y) * W + x) * 4, d = (y * W + x) * 4; data[d] = px[s]; data[d + 1] = px[s + 1]; data[d + 2] = px[s + 2]; data[d + 3] = mp[s]; }
    const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    t.wrapS = THREE.RepeatWrapping; t.encoding = THREE.sRGBEncoding; t.anisotropy = 4;
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }

  function dress(city, vis) {
    const U = city._, Hs = U.Hs, rgb = U.rgb, hash2 = U.hash2, occAt = city.occAt, edges = city.edges;
    const detail = U.detail;
    const T = (hex) => rgb(hex);
    // drawing helpers: one bucket per 128 m tile
    const bucket = (x, z, group) => U.acc(x, z, group);
    const PV = (rowV(0)[0] + rowV(0)[1]) / 2;
    const tri = (a, c, p1, p2, p3, t1, t2, t3) => {
      a.p.push(p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2]); a.c.push(c[0], c[1], c[2], c[0], c[1], c[2], c[0], c[1], c[2]);
      if (a.group === 'bld' || a.group === 'bldx') { if (t1) a.u.push(t1[0], t1[1], t2[0], t2[1], t3[0], t3[1]); else a.u.push(0.5, PV, 0.5, PV, 0.5, PV); }
    };
    /** a piece of wall from p to q between two heights, showing bays u0..u1 of a row of the picture */
    const wallUV = (a, c, p, q, y0, y1, r, u0, u1, I, v0f, v1f) => {
      const V = rowV(r), va = V[0] + (V[1] - V[0]) * (v0f || 0), vb = V[0] + (V[1] - V[0]) * (v1f === undefined ? 1 : v1f);
      const P1 = [p.x, y0, p.z], P2 = [q.x, y0, q.z], P3 = [q.x, y1, q.z], P4 = [p.x, y1, p.z];
      const nx = (P2[1] - P1[1]) * (P3[2] - P1[2]) - (P2[2] - P1[2]) * (P3[1] - P1[1]), nz = (P2[0] - P1[0]) * (P3[1] - P1[1]) - (P2[1] - P1[1]) * (P3[0] - P1[0]);
      if (nx * (P1[0] - I[0]) + nz * (P1[2] - I[2]) >= 0) { tri(a, c, P1, P2, P3, [u0, va], [u1, va], [u1, vb]); tri(a, c, P1, P3, P4, [u0, va], [u1, vb], [u0, vb]); }
      else { tri(a, c, P1, P3, P2, [u0, va], [u1, vb], [u1, va]); tri(a, c, P1, P4, P3, [u0, va], [u0, vb], [u1, vb]); }
    };
    /** a quad seen from the side `inside` is not on */
    const quad = (a, c, p1, p2, p3, p4, inside) => {
      const nx = (p2[1] - p1[1]) * (p3[2] - p1[2]) - (p2[2] - p1[2]) * (p3[1] - p1[1]);
      const ny = (p2[2] - p1[2]) * (p3[0] - p1[0]) - (p2[0] - p1[0]) * (p3[2] - p1[2]);
      const nz = (p2[0] - p1[0]) * (p3[1] - p1[1]) - (p2[1] - p1[1]) * (p3[0] - p1[0]);
      if (nx * (p1[0] - inside[0]) + ny * (p1[1] - inside[1]) + nz * (p1[2] - inside[2]) >= 0) { tri(a, c, p1, p2, p3); tri(a, c, p1, p3, p4); }
      else { tri(a, c, p1, p3, p2); tri(a, c, p1, p4, p3); }
    };
    const triOut = (a, c, p1, p2, p3, inside) => {
      const nx = (p2[1] - p1[1]) * (p3[2] - p1[2]) - (p2[2] - p1[2]) * (p3[1] - p1[1]);
      const ny = (p2[2] - p1[2]) * (p3[0] - p1[0]) - (p2[0] - p1[0]) * (p3[2] - p1[2]);
      const nz = (p2[0] - p1[0]) * (p3[1] - p1[1]) - (p2[1] - p1[1]) * (p3[0] - p1[0]);
      if (nx * (p1[0] - inside[0]) + ny * (p1[1] - inside[1]) + nz * (p1[2] - inside[2]) >= 0) tri(a, c, p1, p2, p3); else tri(a, c, p1, p3, p2);
    };
    /** a box: centre (x, y, z), half sizes, turned by yaw; `open` leaves the bottom off */
    const box = (a, c, x, y, z, hx, hy, hz, yaw, noBottom) => {
      const cs = Math.cos(yaw || 0), sn = Math.sin(yaw || 0);
      const P = (sx, sy, sz) => [x + sx * hx * cs + sz * hz * sn, y + sy * hy, z - sx * hx * sn + sz * hz * cs];
      const I = [x, y, z];
      const v = [P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1)];
      quad(a, c, v[4], v[5], v[6], v[7], I);
      quad(a, c, v[0], v[1], v[5], v[4], I); quad(a, c, v[1], v[2], v[6], v[5], I);
      quad(a, c, v[2], v[3], v[7], v[6], I); quad(a, c, v[3], v[0], v[4], v[7], I);
      if (!noBottom) quad(a, c, v[0], v[3], v[2], v[1], I);
    };
    const solidBox = (x, y0, y1, z, hx, hz, yaw) => {
      const cs = Math.cos(yaw || 0), sn = Math.sin(yaw || 0);
      const P = (sx, sz) => ({ x: x + sx * hx * cs + sz * hz * sn, z: z - sx * hx * sn + sz * hz * cs });
      wallSolids(city, [P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)], y0, y1, x, z);
    };
    const nearestStreetDist = (x, z) => { let bd = Infinity, be = null; for (const E of edges) { if (Math.abs(E.pts[0].x - x) > E.len + 60 && Math.abs(E.pts[0].z - z) > E.len + 60) continue; for (let k = 0; k < E.pts.length - 1; k++) { const d = U.distSeg(x, z, E.pts[k], E.pts[k + 1]) - E.hw; if (d < bd) { bd = d; be = E; } } } return { d: bd, E: be }; };

    /* ------------------------------------------------------------- buildings */
    /** the smallest rectangle round an outline: centre, long axis (ux, uz), half sizes */
    const obb = (P) => {
      let best = null;
      for (let i = 0; i < P.length; i++) {
        const a = P[i], b = P[(i + 1) % P.length], L = Math.hypot(b.x - a.x, b.z - a.z);
        if (L < 0.5) continue;
        const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
        let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
        for (const p of P) { const s = p.x * ux + p.z * uz, t = -p.x * uz + p.z * ux; a0 = Math.min(a0, s); a1 = Math.max(a1, s); b0 = Math.min(b0, t); b1 = Math.max(b1, t); }
        const area = (a1 - a0) * (b1 - b0);
        if (!best || area < best.area - 1e-6) best = { area, ux, uz, a0, a1, b0, b1 };
      }
      if (!best) return null;
      let { ux, uz, a0, a1, b0, b1 } = best;
      if (b1 - b0 > a1 - a0) { const t0 = a0, t1 = a1; a0 = b0; a1 = b1; b0 = -t1; b1 = -t0; const tx = ux; ux = -uz; uz = tx; }
      return { ux, uz, vx: -uz, vz: ux, a0, a1, b0, b1, area: best.area };
    };
    /** an outline whose walls all run along its box's two axes, as rectangles (in the box's own coordinates) */
    const rectsOf = (P, O) => {
      const Q = P.map((p) => ({ a: p.x * O.ux + p.z * O.uz, b: p.x * O.vx + p.z * O.vz }));
      for (let i = 0; i < Q.length; i++) {
        const p = Q[i], q = Q[(i + 1) % Q.length], L = Math.hypot(q.a - p.a, q.b - p.b);
        if (L < 0.7) continue;
        if (Math.min(Math.abs(q.a - p.a), Math.abs(q.b - p.b)) / L > 0.2) return null;
      }
      const bs = [];
      for (const q of Q.map((q) => q.b).sort((x, y) => x - y)) if (!bs.length || q - bs[bs.length - 1] > 0.45) bs.push(q);
      let out = [];
      for (let i = 0; i < bs.length - 1; i++) {
        const mid = (bs[i] + bs[i + 1]) / 2, xs = [];
        for (let k = 0; k < Q.length; k++) { const p = Q[k], q = Q[(k + 1) % Q.length]; if ((p.b > mid) !== (q.b > mid)) xs.push(p.a + (mid - p.b) / (q.b - p.b) * (q.a - p.a)); }
        xs.sort((x, y) => x - y);
        for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1] - xs[k] > 0.6) out.push({ a0: xs[k], a1: xs[k + 1], b0: bs[i], b1: bs[i + 1] });
      }
      // slabs of the same width, one on top of the other, are one rectangle
      let merged = true;
      while (merged) {
        merged = false;
        for (let i = 0; i < out.length && !merged; i++) for (let j = 0; j < out.length; j++) {
          if (i === j) continue;
          const r = out[i], s = out[j];
          if (Math.abs(r.a0 - s.a0) < 0.5 && Math.abs(r.a1 - s.a1) < 0.5 && Math.abs(r.b1 - s.b0) < 0.05) { r.b1 = s.b1; out.splice(j, 1); merged = true; break; }
        }
      }
      return out.length && out.length <= 7 ? out : null;
    };

    const wallAcc = (b) => bucket(b.cx, b.cz, 'bld');
    /** the walls of an outline between two heights; `under` (if given) colours the part below `yf` as footing */
    const walls = (a, P, y0, y1, col) => {
      const sg = wind(P);
      for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length], I = within(P, i, sg); quad(a, col, [p.x, y0, p.z], [q.x, y0, q.z], [q.x, y1, q.z], [p.x, y1, p.z], [I.x, (y0 + y1) / 2, I.z]); }
    };
    const flatRoof = (a, P, y, col) => { for (const t of U.triangulate(P)) triOut(a, col, [P[t[0]].x, y, P[t[0]].z], [P[t[1]].x, y, P[t[1]].z], [P[t[2]].x, y, P[t[2]].z], [P[t[0]].x, y - 5, P[t[0]].z]); };
    /** a pitched roof on a rectangle (the box's coordinates), sitting on the walls at `ye` */
    const pitched = (a, O, r, ye, pitch, hip, roofCol, wallCol, ov, ax) => {
      const W = (s, t, y) => [s * O.ux + t * O.vx, y, s * O.uz + t * O.vz];
      const alongA = r.a1 - r.a0 >= r.b1 - r.b0;
      // (p, q): p along the ridge, q across it
      const p0 = alongA ? r.a0 : r.b0, p1 = alongA ? r.a1 : r.b1, q0 = alongA ? r.b0 : r.a0, q1 = alongA ? r.b1 : r.a1;
      const PT = (p, q, y) => (alongA ? W(p, q, y) : W(q, p, y));
      const half = (q1 - q0) / 2, qm = (q0 + q1) / 2, hR = Math.min(pitch * half, 4.2), yr = ye + hR, sl = hR / half;
      const I = PT((p0 + p1) / 2, qm, ye - 1);
      const yo = ye - sl * ov;                                     // the eave, out past the wall
      if (hip && p1 - p0 > 2 * half + 0.6) {
        const r0 = p0 + half, r1 = p1 - half;
        quad(a, roofCol, PT(p0 - ov, q0 - ov, yo), PT(p1 + ov, q0 - ov, yo), PT(r1, qm, yr), PT(r0, qm, yr), I);
        quad(a, roofCol, PT(p1 + ov, q1 + ov, yo), PT(p0 - ov, q1 + ov, yo), PT(r0, qm, yr), PT(r1, qm, yr), I);
        triOut(a, roofCol, PT(p0 - ov, q1 + ov, yo), PT(p0 - ov, q0 - ov, yo), PT(r0, qm, yr), I);
        triOut(a, roofCol, PT(p1 + ov, q0 - ov, yo), PT(p1 + ov, q1 + ov, yo), PT(r1, qm, yr), I);
      } else if (hip) {
        const pm = (p0 + p1) / 2, top = PT(pm, qm, yr);
        triOut(a, roofCol, PT(p0 - ov, q0 - ov, yo), PT(p1 + ov, q0 - ov, yo), top, I); triOut(a, roofCol, PT(p1 + ov, q0 - ov, yo), PT(p1 + ov, q1 + ov, yo), top, I);
        triOut(a, roofCol, PT(p1 + ov, q1 + ov, yo), PT(p0 - ov, q1 + ov, yo), top, I); triOut(a, roofCol, PT(p0 - ov, q1 + ov, yo), PT(p0 - ov, q0 - ov, yo), top, I);
      } else {
        quad(a, roofCol, PT(p0, q0 - ov, yo), PT(p1, q0 - ov, yo), PT(p1, qm, yr), PT(p0, qm, yr), I);
        quad(a, roofCol, PT(p1, q1 + ov, yo), PT(p0, q1 + ov, yo), PT(p0, qm, yr), PT(p1, qm, yr), I);
        // the gable ends carry the wall up to the ridge
        triOut(a, wallCol, PT(p0, q0, ye), PT(p0, q1, ye), PT(p0, qm, yr), I);
        triOut(a, wallCol, PT(p1, q1, ye), PT(p1, q0, ye), PT(p1, qm, yr), I);
      }
      // under the eaves (seen from the street, looking up)
      if (ov > 0.05) {
        const up = PT((p0 + p1) / 2, qm, ye + 9), e0 = hip ? p0 - ov : p0, e1 = hip ? p1 + ov : p1;
        quad(ax || a, roofCol, PT(e0, q0 - ov, yo), PT(e1, q0 - ov, yo), PT(e1, q0, ye - 0.02), PT(e0, q0, ye - 0.02), up);
        quad(ax || a, roofCol, PT(e0, q1 + ov, yo), PT(e1, q1 + ov, yo), PT(e1, q1, ye - 0.02), PT(e0, q1, ye - 0.02), up);
      }
      return { yr, alongA, p0, p1, qm, PT };
    };
    /** the outward normal of wall i of an outline */
    const wallOut = (P, i, cx, cz) => {
      const p = P[i], q = P[(i + 1) % P.length], L = Math.hypot(q.x - p.x, q.z - p.z) || 1;
      const sg = P.sg || (P.sg = wind(P)), nx = sg * (q.z - p.z) / L, nz = -sg * (q.x - p.x) / L;
      const mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2;
      return { nx, nz, L, mx, mz, p, q };
    };

    const specials = city.specials = [];
    /** a wall's colour for a pictured wall (the picture's wall is 80% grey) */
    const WK = (hex) => { const c = T(hex); return [Math.min(1, c[0] / WALLK), Math.min(1, c[1] / WALLK), Math.min(1, c[2] / WALLK)]; };
    /**
     * One storey of an outline's walls. A wall long enough gets whole bays of
     * `row` (windows never cut in half); a short one, and every wall when row
     * is a blank kind, runs the blank row on. rowFor(i, L) can say otherwise
     * for a wall, or return null to leave it to the caller.
     */
    const storey = (a, P, y0, y1, row, blank, bay, col, I0, rowFor) => {
      const sg = wind(P);
      for (let i = 0; i < P.length; i++) {
        const In = within(P, i, sg), I = [In.x, y0, In.z];
        const p = P[i], q = P[(i + 1) % P.length], L = Math.hypot(q.x - p.x, q.z - p.z);
        if (L < 0.05) continue;
        let r = L < bay * 0.85 ? blank : row;
        if (rowFor) { const x = rowFor(i, L); if (x === null) continue; if (x !== undefined) r = x; }
        const whole = r !== blank && r !== ROW.siding && r !== ROW.masonry && r !== ROW.brick && r !== ROW.panel;
        wallUV(a, col, p, q, y0, y1, r, 0, whole ? Math.max(1, Math.round(L / bay)) : L / bay, I);
      }
    };
    const lerpP = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t });
    /* The public buildings people know, each with its own look (colours,
       windows, roof), on its real outline. A building is known by its name,
       or by a named place that lies inside its outline. */
    const placePts = (city.data.places || []).map((p) => ({ name: p.n, x: p.x / 10, z: p.z / 10 }));
    const lookFor = (b) => {
      let n = b.name || '';
      if (!n) for (const p of placePts) if (U.inPoly(p.x, p.z, b.P)) { n = p.name; break; }
      b.place = n;
      if (b.k === 'c' && /Church|Lutheran|Fellowship|Chapel/.test(n)) b.k = 'w';
      if (/South Eugene High School|Eugene International High School/.test(n) || (b.k === 'S' && b.area > 15000)) return { id: 'sehs', levels: 2, st: 3.5, wall: 0xebe8dc, row: ROW.school, blank: ROW.panel, bay: 3.4, minWin: 7, cap: 0xf6f5f0, roof: 0xc4c4be };
      if (/Roosevelt Middle School/.test(n)) return { id: 'rms', levels: 2, st: 3.9, wall: 0xba8c5e, row: ROW.band2, blank: ROW.panel, bay: 5, minWin: 8, cap: 0x5f646b, roof: 0xb9bab6 };
      if (/YMCA/.test(n)) return { id: 'ymca', levels: 2, st: 4.4, wall: 0x737a81, row: ROW.band2, blank: ROW.panel, bay: 6, minWin: 9, front: ROW.entry, cap: 0xc4823f, roof: 0xb9bab6 };
      if (/Kidsports/.test(n)) return { id: 'kids', levels: 1, st: 8, wall: 0xcfd2d4, row: ROW.gym, blank: ROW.panel, bay: 6, minWin: 10, front: ROW.entry, pitch: 0.26, roof: 0x7d8790 };
      if (/Safeway/.test(n)) return { id: 'safeway', levels: 1, st: 7, wall: 0xd4c5a5, row: null, blank: ROW.panel, bay: 6, front: ROW.shop, cap: 0xa8402f, roof: 0xb9bab6 };
      if (b.tag === 'supermarket' || /Sundance Natural Foods|Humble Bagel/.test(n)) return { id: 'market', levels: 1, st: 5.6, wall: 0xcfc4a8, row: null, blank: ROW.masonry, bay: 4, front: ROW.shop, fascia: 0x2f5a4a, cap: 0x2f5a4a, roof: 0xb9bab6 };
      if (/Amazon Pool/.test(n)) return { id: 'pool', levels: 1, st: 4.2, wall: 0xdfe3e2, row: ROW.gym, blank: ROW.panel, bay: 5, minWin: 8, cap: 0x3f8fb0, roof: 0xb9bab6 };
      if (/Community Center|Theater/.test(n)) return { id: 'hall', levels: 1, st: 5.2, wall: 0xb9a183, row: ROW.gym, blank: ROW.brick, bay: 5, minWin: 9, front: ROW.entry, cap: 0x6b5a48, roof: TAR };
      return null;
    };
    /** South Eugene High School: its entrance block (pale purple, as the real one is) on the 19th Avenue side, and a sign by the street */
    const sehsExtras = (b, a, ax, yf, ye) => {
      const P = b.P, sch = placePts.find((p) => /^South Eugene High School$/.test(p.name)) || { x: b.cx, z: b.cz };
      let best = null, bd = Infinity;
      // (the front: the northmost long wall that faces north, about in line with the school's marker)
      for (let i = 0; i < P.length; i++) { const w = wallOut(P, i, b.cx, b.cz); if (w.nz < 0.85 || w.L < 12 || Math.abs(w.mx - sch.x) > 70) continue; const d = -w.mz; if (d < bd) { bd = d; best = w; } }
      if (!best) return;
      const purple = T(0xa99dbd), white = T(0xf6f5f0), yaw = Math.atan2((best.q.x - best.p.x) / best.L, (best.q.z - best.p.z) / best.L), w = Math.min(9, best.L / 2 - 1);
      const cx = best.mx + best.nx * 2.6, cz = best.mz + best.nz * 2.6, h = ye - yf + 0.9;
      box(a, purple, cx, yf + h / 2 - 0.2, cz, 2.6, h / 2 + 0.2, w, yaw, true);
      solidBox(cx, yf - 2, yf + h, cz, 2.6, w, yaw);
      // glass doors in its face, a white canopy over them
      const fx = best.mx + best.nx * 5.26, fz = best.mz + best.nz * 5.26, ux = Math.sin(yaw), uz = Math.cos(yaw), In = [best.mx, yf + 1, best.mz];
      const Wd = (s, y) => [fx + ux * s, y, fz + uz * s];
      quad(ax, T(0x2f3d4a), Wd(-w * 0.55, yf), Wd(w * 0.55, yf), Wd(w * 0.55, yf + 2.7), Wd(-w * 0.55, yf + 2.7), In);
      box(ax, white, best.mx + best.nx * 6.6, yf + 3.0, best.mz + best.nz * 6.6, 1.5, 0.12, w * 0.7, yaw, false);
      // the sign: a low purple wall with a white band, on the lawn by the pavement
      let d = 8; for (; d < 140; d += 2) { const o = occAt(best.mx + best.nx * d, best.mz + best.nz * d); if (o === 2 || o === 1) break; }
      if (d < 140) {
        const sx = best.mx + best.nx * (d - 6), sz = best.mz + best.nz * (d - 6), sy = Hs(sx, sz);
        box(ax, purple, sx, sy + 0.75, sz, 0.3, 0.75, 3.6, yaw, true); box(ax, white, sx, sy + 1.0, sz, 0.36, 0.22, 3.0, yaw, true);
        solidBox(sx, sy - 1, sy + 1.5, sz, 0.3, 3.6, yaw);
        // and a flagpole beside it
        const px = sx + ux * 6, pz = sz + uz * 6, py = Hs(px, pz);
        box(ax, T(0xc9ccce), px, py + 5, pz, 0.06, 5, 0.06, 0, true);
      }
    };
    /** how a building is drawn from far off: its outline's rectangle as plain walls (a small simple outline keeps its own shape), and the roof */
    const shell = (b, wallHex, roofHex, pitch, yBase) => {
      const O = b.O, a = bucket(b.cx, b.cz, 'bldf'), wc = T(wallHex), rc = T(roofHex), I = [b.cx, b.ye - 1, b.cz];
      if (!O) return;
      const own = b.P.length <= 6 || b.area < 0.7 * O.area;
      const R = own ? b.P : [[O.a0, O.b0], [O.a1, O.b0], [O.a1, O.b1], [O.a0, O.b1]].map(([s, t]) => ({ x: s * O.ux + t * O.vx, z: s * O.uz + t * O.vz }));
      walls(a, R, yBase, b.ye, wc, I);
      if (pitch > 0) pitched(a, O, O, b.ye, pitch, false, rc, wc, 0, null);
      else flatRoof(a, R, b.ye, rc);
    };
    city.buildingKit = { storey, wallUV, WK, ROW, lerpP };
    /* Two buildings drawn against each other (a garage on a house, a wing on a
       hall) can have walls in one plane, facing the same way, overlapping:
       they would flicker. Such neighbours are drawn in a few centimetres,
       each by a different amount, so one wall always stands clear of the other. */
    {
      const cell = new Map(), W = [];
      for (const b of city.buildings) {
        let cx = 0, cz = 0; for (const p of b.P) { cx += p.x; cz += p.z; } cx /= b.P.length; cz /= b.P.length;
        for (let i = 0; i < b.P.length; i++) {
          const w = wallOut(b.P, i, cx, cz);
          if (w.L < 0.4) continue;
          w.b = b; W.push(w);
          for (let t = 0; t <= w.L; t += 6) { const x = w.p.x + (w.q.x - w.p.x) * t / w.L, z = w.p.z + (w.q.z - w.p.z) * t / w.L, k = Math.floor(x / 12) + ':' + Math.floor(z / 12); if (!cell.has(k)) cell.set(k, new Set()); cell.get(k).add(w); }
        }
      }
      const clash = new Map();
      for (const set of cell.values()) { const L = Array.from(set); for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
        const a = L[i], c = L[j];
        if (a.b === c.b || a.nx * c.nx + a.nz * c.nz < 0.995) continue;
        if (Math.abs((c.p.x - a.p.x) * a.nx + (c.p.z - a.p.z) * a.nz) > 0.06) continue;
        const ux = (a.q.x - a.p.x) / a.L, uz = (a.q.z - a.p.z) / a.L, s0 = (c.p.x - a.p.x) * ux + (c.p.z - a.p.z) * uz, s1 = (c.q.x - a.p.x) * ux + (c.q.z - a.p.z) * uz;
        if (Math.min(a.L, Math.max(s0, s1)) - Math.max(0, Math.min(s0, s1)) < 0.25) continue;
        for (const [x, y] of [[a.b, c.b], [c.b, a.b]]) { if (!clash.has(x)) clash.set(x, new Set()); clash.get(x).add(y); }
      } }
      const level = new Map();
      // (the bigger building keeps its outline; the smaller ones step in)
      for (const b of Array.from(clash.keys()).sort((x, y) => Math.abs(U.polyArea(y.P)) - Math.abs(U.polyArea(x.P)))) {
        const used = new Set(); for (const o of clash.get(b)) if (level.has(o)) used.add(level.get(o));
        let lv = 0; while (used.has(lv)) lv++;
        level.set(b, lv);
        if (!lv) continue;
        const P = b.P, d = lv * 0.07, n = P.length, out = [];
        let cx = 0, cz = 0; for (const p of P) { cx += p.x; cz += p.z; } cx /= n; cz /= n;
        for (let i = 0; i < n; i++) {
          const w0 = wallOut(P, (i + n - 1) % n, cx, cz), w1 = wallOut(P, i, cx, cz);
          let bx = w0.nx + w1.nx, bz = w0.nz + w1.nz; const bl = Math.hypot(bx, bz);
          if (bl < 0.2) { out.push({ x: P[i].x - w1.nx * d, z: P[i].z - w1.nz * d }); continue; }
          bx /= bl; bz /= bl;
          const k = d / Math.max(0.35, bx * w1.nx + bz * w1.nz);
          out.push({ x: P[i].x - bx * k, z: P[i].z - bz * k });
        }
        b.P = out;
      }
      city.stats = city.stats || {}; city.clashes = clash.size;
    }
    for (const b of city.buildings) {
      const P = b.P;
      let y0 = Infinity, y1 = -Infinity, cx = 0, cz = 0;
      for (const p of P) { const y = Hs(p.x, p.z); y0 = Math.min(y0, y); y1 = Math.max(y1, y); cx += p.x; cz += p.z; }
      cx /= P.length; cz /= P.length;
      b.cx = cx; b.cz = cz; b.y0 = y0; b.y1 = y1;
      b.area = Math.abs(U.polyArea(P));
      const O = b.O = obb(P);
      const h1 = hash2(Math.round(cx * 3), Math.round(cz * 3)), h2 = hash2(Math.round(cz * 7) + 11, Math.round(cx * 5) - 3), h3 = hash2(Math.round(cx) * 13 + 5, Math.round(cz) * 17);
      const pick = (arr, h) => arr[Math.floor(h * arr.length) % arr.length];
      // how tall, and what kind of roof
      let levels = b.lv, st = 2.9, floorUp = 0.35, roof = 'gable', wallHex, roofHex = pick(PAL.roof, h2);
      if (b.k === 'h') { levels = levels || (b.area < 150 && h1 < 0.36 ? 2 : 1); if (levels > 2) levels = 2; wallHex = pick(PAL.wall, h1 * 7.3 % 1); roof = h3 < 0.3 ? 'hip' : 'gable'; }
      else if (b.k === 'g') { levels = 1; st = 2.5; floorUp = 0.05; wallHex = pick(PAL.wall, h1 * 3.1 % 1); }
      else if (b.k === 's') { levels = 1; st = 2.2; floorUp = 0.05; wallHex = pick(PAL.wall, h1 * 5.7 % 1); }
      else if (b.k === 'a') { levels = levels || (b.area > 500 ? 3 : 2); st = 2.85; floorUp = 0.3; wallHex = pick(PAL.flats, h1); roof = b.area > 420 || h3 < 0.5 ? 'flat' : 'hip'; }
      else if (b.k === 'c') { levels = levels || (b.area > 1500 && h1 < 0.3 ? 2 : 1); st = levels === 1 ? 4.6 : 3.8; floorUp = 0.12; wallHex = pick(PAL.shop, h1); roof = 'flat'; }
      else if (b.k === 'S') { levels = levels || 2; st = 3.9; floorUp = 0.2; wallHex = 0xcdbb9c; roof = 'flat'; }
      else if (b.k === 'w') { levels = 1; st = 6.5; floorUp = 0.3; wallHex = pick([0xe6e2d8, 0xb5a27a, 0x9a7a62], h1); roof = 'gable'; }
      else if (b.k === 'd') { levels = 1; st = 2.6; floorUp = 0.05; wallHex = 0x6f7f8c; roof = 'flat'; }
      else if (b.k === 'r') { levels = 1; st = 4.6; floorUp = 0; wallHex = 0xd9d9d6; roof = 'canopy'; }
      else { levels = levels || 1; wallHex = pick(PAL.shop, h1); roof = 'flat'; }
      const LK = b.k === 'c' || b.k === 'S' || b.k === 'w' ? lookFor(b) : null;
      if (LK) { levels = LK.levels || levels; st = LK.st || st; wallHex = LK.wall || wallHex; if (LK.pitch) roof = 'gable'; else if (b.k !== 'w') roof = 'flat'; if (LK.roof) roofHex = LK.roof; }
      /* How tall it really is (the lidar: the height of the lower quarter of
         its roof, and of the top tenth). A pitched roof's eaves and ridge
         follow from those two; a flat-roofed building's walls stand to the
         lower figure, and its taller parts are boxes on top (b.up). Trees
         overhang houses, so a house's figures are kept within reason. */
      let rise = -1;
      if (b.hh && b.k !== 'r') {
        const small = b.k === 'h' || b.k === 'g' || b.k === 's' || b.k === 'w' || (b.k === 'a' && roof !== 'flat');
        let eave;
        if (small) { rise = Math.min((b.hh[1] - b.hh[0]) / 0.65, b.k === 'w' ? 9 : 4.6); eave = Math.max(2.2, Math.min(b.k === 'w' ? 12 : 7.5, b.hh[0] - 0.25 * rise)); if (rise < 1) { eave += rise * 0.5; rise = 0; } }
        else { eave = Math.max(2.6, Math.min(40, b.hh[0])); rise = LK && LK.pitch ? Math.min(6, (b.hh[1] - b.hh[0]) / 0.65) : 0; if (LK && LK.pitch) eave = Math.max(3, b.hh[0] - 0.25 * rise); }
        const nominal = b.k === 'c' || b.k === 'S' ? 4.2 : b.k === 'w' ? 9 : b.k === 'g' || b.k === 's' ? 9 : 2.9;
        levels = LK && LK.levels && b.k === 'S' ? LK.levels : Math.max(1, Math.round((eave - floorUp) / nominal));
        st = (eave - floorUp) / levels;
        if (rise === 0 && b.k !== 'w') roof = 'flat'; else if (roof === 'flat' && small) roof = h3 < 0.3 ? 'hip' : 'gable';
      }
      if (b.rc !== undefined) roofHex = b.rc;
      const yf = y1 + floorUp, ye = yf + levels * st;
      b.yf = yf; b.ye = ye; b.levels = levels; b.storey = st; b.top = ye;
      U.occPoly(P, b.k === 'r' ? 7 : 4, 0.6);
      b.wallHex = wallHex; b.roofHex = roofHex; b.roof = roof; b.h = [h1, h2, h3];
      // a named public building can have its own look (city.special); it says what it built
      if (city.special) { const sp = city.special(b, vis); if (sp) { specials.push(b); continue; } }
      if (vis) shell(b, wallHex, b.rc !== undefined ? b.rc : roof === 'flat' || roof === 'canopy' ? (LK && LK.roof ? LK.roof : b.k === 'h' || b.k === 'a' ? TAR : 0xb9bab6) : roofHex, roof !== 'flat' && roof !== 'canopy' && O && O.b1 - O.b0 <= 15 ? (b.k === 'w' ? 0.95 : 0.5) : 0, roof === 'canopy' ? ye - 0.1 : y0 - 0.4);
      if (roof === 'canopy') {
        // a roof on posts (a filling station's canopy, a car port): only the posts are solid
        if (O) for (const [s, t] of [[O.a0 + 0.6, O.b0 + 0.6], [O.a1 - 0.6, O.b0 + 0.6], [O.a1 - 0.6, O.b1 - 0.6], [O.a0 + 0.6, O.b1 - 0.6]]) {
          const x = s * O.ux + t * O.vx, z = s * O.uz + t * O.vz;
          solidBox(x, y0 - 1, ye, z, 0.22, 0.22, 0);
          if (vis) box(wallAcc(b), T(0xb9bcc0), x, (y0 - 0.5 + ye) / 2, z, 0.2, (ye - y0 + 0.5) / 2, 0.2, 0, true);
        }
        if (vis) { const a = wallAcc(b); walls(a, P, ye - 0.1, ye + 0.55, T(wallHex), [cx, ye + 0.2, cz]); flatRoof(a, P, ye + 0.55, T(0xc9cbcc)); for (const t of U.triangulate(P)) triOut(a, T(0xe9eaea), [P[t[0]].x, ye - 0.1, P[t[0]].z], [P[t[1]].x, ye - 0.1, P[t[1]].z], [P[t[2]].x, ye - 0.1, P[t[2]].z], [cx, ye + 3, cz]); }
        continue;
      }
      wallSolids(city, P, y0 - 1.2, Math.min(ye, yf + 7), cx, cz);
      if (!vis) continue;
      const a = wallAcc(b), ax = bucket(cx, cz, 'bldx'), wc = T(wallHex), wk = WK(wallHex), rc = T(roofHex), I = [cx, (y0 + ye) / 2, cz];
      // the wall that faces the street carries the door
      let front = -1, fd = Infinity;
      for (let i = 0; i < P.length; i++) { const w = wallOut(P, i, cx, cz); if (w.L < 2.6) continue; const d = nearestStreetDist(w.mx + w.nx * 2, w.mz + w.nz * 2).d - w.L * 0.15; if (d < fd) { fd = d; front = i; } }
      b.front = front;
      // the footing: down into the ground, and up to the floor where the ground falls away
      walls(a, P, y0 - 0.4, yf, T(yf - y0 > 0.7 ? CONCRETE : wallHex), I);
      const FW = front >= 0 ? wallOut(P, front, cx, cz) : null, IF = FW ? [FW.mx - FW.nx * 0.4, yf, FW.mz - FW.nz * 0.4] : I;
      if (b.k === 'h') {
        const bay = 3.1, nF = FW ? Math.max(1, Math.round(FW.L / bay)) : 1, dB = Math.floor(nF / 2);
        for (let lv = 0; lv < levels; lv++) storey(a, P, yf + lv * st, yf + (lv + 1) * st, ROW.win, ROW.siding, bay, wk, I, lv === 0 && FW ? (i) => (i === front ? null : undefined) : null);
        if (FW) {
          // the front wall's ground floor: windows either side of the door's bay
          const A = lerpP(FW.p, FW.q, dB / nF), Bq = lerpP(FW.p, FW.q, (dB + 1) / nF);
          if (dB > 0) wallUV(a, wk, FW.p, A, yf, yf + st, ROW.win, 0, dB, IF);
          wallUV(a, wk, A, Bq, yf, yf + st, ROW.siding, 0, 1, IF);
          if (nF - dB - 1 > 0) wallUV(a, wk, Bq, FW.q, yf, yf + st, ROW.win, 0, nF - dB - 1, IF);
          const mx = (A.x + Bq.x) / 2, mz = (A.z + Bq.z) / 2, ux = (FW.q.x - FW.p.x) / FW.L, uz = (FW.q.z - FW.p.z) / FW.L, In = [mx - FW.nx, yf + 1, mz - FW.nz];
          const Wd = (s, y, o) => [mx + ux * s + FW.nx * o, y, mz + uz * s + FW.nz * o];
          quad(ax, T(TRIM), Wd(-0.62, yf, 0.05), Wd(0.62, yf, 0.05), Wd(0.62, yf + 2.2, 0.05), Wd(-0.62, yf + 2.2, 0.05), In);
          quad(ax, T(pick(PAL.door, h2 * 3.7 % 1)), Wd(-0.5, yf, 0.1), Wd(0.5, yf, 0.1), Wd(0.5, yf + 2.08, 0.1), Wd(-0.5, yf + 2.08, 0.1), In);
          // a step up to it and, on some houses, a porch roof on two posts
          const yaw = Math.atan2(ux, uz), pc = Wd(0, 0, 0.9), gy = Hs(pc[0], pc[2]);
          box(ax, T(CONCRETE), pc[0], (gy - 0.2 + yf - 0.03) / 2, pc[2], 0.9, Math.max(0.05, (yf - 0.03 - gy + 0.2) / 2), 1.3, yaw, true);
          if (h1 > 0.42) {
            const room = Math.min(Math.hypot(mx - FW.p.x, mz - FW.p.z), Math.hypot(mx - FW.q.x, mz - FW.q.z)) - 0.3;
            const ph = yf + 2.55, pw = Math.min(room, 2.2 + h2), c0 = Wd(0, 0, 1.0);
            if (pw >= 0.9) {
            box(ax, rc, c0[0], ph + 0.09, c0[2], 1.15, 0.09, pw, yaw, false);
            for (const s of [-pw + 0.15, pw - 0.15]) { const pp = Wd(s, 0, 1.95); box(ax, T(TRIM), pp[0], (yf + ph) / 2, pp[2], 0.09, (ph - yf) / 2, 0.09, yaw, true); }
            }
          }
        }
      } else if (b.k === 'g' || b.k === 's' || b.k === 'd') {
        storey(a, P, yf, ye, ROW.siding, ROW.siding, 3.1, wk, I, b.k === 'g' && FW && FW.L > 3.2 ? (i) => (i === front ? null : undefined) : null);
        if (b.k === 'g' && FW && FW.L > 3.2) {
          // the garage door in the middle of its wall
          const dw = Math.min(FW.L - 0.6, 5.2), f0 = (1 - dw / FW.L) / 2, A = lerpP(FW.p, FW.q, f0), Bq = lerpP(FW.p, FW.q, 1 - f0);
          wallUV(a, wk, FW.p, A, yf, ye, ROW.siding, 0, f0 * FW.L / 3.1, IF);
          wallUV(a, wk, A, Bq, yf, ye, ROW.garage, 0, 1, IF);
          wallUV(a, wk, Bq, FW.q, yf, ye, ROW.siding, 0, f0 * FW.L / 3.1, IF);
        }
      } else if (b.k === 'a') {
        for (let lv = 0; lv < levels; lv++) storey(a, P, yf + lv * st, yf + (lv + 1) * st, ROW.flats, ROW.panel, 3.0, wk, I);
        if (FW) {
          const mx = FW.mx, mz = FW.mz, ux = (FW.q.x - FW.p.x) / FW.L, uz = (FW.q.z - FW.p.z) / FW.L, In = [mx - FW.nx, yf + 1, mz - FW.nz];
          const Wd = (s, y, o) => [mx + ux * s + FW.nx * o, y, mz + uz * s + FW.nz * o];
          quad(ax, T(0x3a4047), Wd(-0.75, yf, 0.07), Wd(0.75, yf, 0.07), Wd(0.75, yf + 2.15, 0.07), Wd(-0.75, yf + 2.15, 0.07), In);
          const yaw = Math.atan2(ux, uz), c0 = Wd(0, 0, 0.8);
          box(ax, T(pick(PAL.awning, h3)), c0[0], yf + 2.45, c0[2], 0.9, 0.08, 1.4, yaw, false);
        }
      } else if (b.k === 'c' || b.k === 'S') {
        const big = b.area > 900;
        const L = LK || (b.k === 'S' ? { row: ROW.school, blank: ROW.panel, bay: 3.4, minWin: 6 }
          : { row: null, blank: big ? ROW.panel : (h2 < 0.45 ? ROW.brick : ROW.masonry), bay: 3.4, front: ROW.shop, upper: ROW.flats, fascia: pick(PAL.awning, h3) });
        for (let lv = 0; lv < levels; lv++) storey(a, P, yf + lv * st, yf + (lv + 1) * st, L.row || L.blank, L.blank, L.bay, wk, I, (i, len) => {
          if (lv === 0 && i === front && len > 4 && L.front) return L.front;
          if (lv > 0 && L.upper) return len < L.bay * 0.85 ? L.blank : L.upper;
          if (!L.row || len < (L.minWin || 0)) return L.blank;
          return undefined;
        });
        if (FW && FW.L > 4 && L.fascia) {
          // a band of colour over the shop's windows
          const ux = (FW.q.x - FW.p.x) / FW.L, uz = (FW.q.z - FW.p.z) / FW.L, dw = FW.L / 2 - 0.2, In = [FW.mx - FW.nx, yf + 1, FW.mz - FW.nz], f0 = st * 0.665, f1 = Math.min(st - 0.1, st * 0.82);
          const Wd = (s, y, o) => [FW.mx + ux * s + FW.nx * o, y, FW.mz + uz * s + FW.nz * o];
          quad(ax, T(L.fascia), Wd(-dw, yf + f0, 0.06), Wd(dw, yf + f0, 0.06), Wd(dw, yf + f1, 0.06), Wd(-dw, yf + f1, 0.06), In);
        }
        if (LK && LK.id === 'sehs') sehsExtras(b, a, ax, yf, ye);
      } else if (b.k === 'w') {
        storey(a, P, yf, ye, ROW.church, ROW.masonry, 3.6, wk, I, (i, L) => (i === front || L < 7 ? ROW.masonry : undefined));
        if (FW) {
          const ux = (FW.q.x - FW.p.x) / FW.L, uz = (FW.q.z - FW.p.z) / FW.L, In = [FW.mx - FW.nx, yf + 1, FW.mz - FW.nz];
          const Wd = (s, y, o) => [FW.mx + ux * s + FW.nx * o, y, FW.mz + uz * s + FW.nz * o];
          quad(ax, T(0x5a3a2a), Wd(-1.0, yf, 0.07), Wd(1.0, yf, 0.07), Wd(1.0, yf + 2.6, 0.07), Wd(-1.0, yf + 2.6, 0.07), In);
        }
      } else storey(a, P, yf, ye, ROW.panel, ROW.panel, 3.4, wk, I);
      // the roof
      let ridge = null;
      const rects = O && roof !== 'flat' ? rectsOf(P, O) : null;
      let pitch = b.k === 'w' ? 0.95 : b.k === 'g' || b.k === 's' ? 0.38 : 0.42 + h2 * 0.22;
      if (rise > 0 && O) { const half = (rects && rects.length ? Math.max.apply(null, rects.map((r) => Math.min(r.a1 - r.a0, r.b1 - r.b0))) : O.b1 - O.b0) / 2; pitch = Math.max(0.18, Math.min(1.3, rise / Math.max(half, 1.5))); }
      if (roof !== 'flat' && rects && Math.max.apply(null, rects.map((r) => Math.min(r.a1 - r.a0, r.b1 - r.b0))) <= 15) {
        for (const r of rects) {
          if (Math.min(r.a1 - r.a0, r.b1 - r.b0) < 1.6) { quad(a, rc, [r.a0 * O.ux + r.b0 * O.vx, ye + 0.02, r.a0 * O.uz + r.b0 * O.vz], [r.a1 * O.ux + r.b0 * O.vx, ye + 0.02, r.a1 * O.uz + r.b0 * O.vz], [r.a1 * O.ux + r.b1 * O.vx, ye + 0.02, r.a1 * O.uz + r.b1 * O.vz], [r.a0 * O.ux + r.b1 * O.vx, ye + 0.02, r.a0 * O.uz + r.b1 * O.vz], [cx, ye - 3, cz]); continue; }
          const R = pitched(a, O, r, ye, pitch, roof === 'hip', rc, wc, 0.4, ax);
          if (!ridge || (R.p1 - R.p0) > (ridge.p1 - ridge.p0)) ridge = R;
        }
      } else if (roof !== 'flat' && O && (b.area > 0.72 * O.area || (LK && LK.pitch)) && (O.b1 - O.b0 <= 15 || (LK && LK.pitch))) {
        ridge = pitched(a, O, O, ye, LK && LK.pitch ? LK.pitch : pitch, roof === 'hip', rc, wc, LK && LK.pitch ? 0.7 : 0.4, ax);
        flatRoof(a, P, ye + 0.01, rc);
      } else {
        // a flat roof behind a low parapet
        walls(a, P, ye, ye + (LK && LK.cap ? 0.75 : 0.5), LK && LK.cap ? T(LK.cap) : wc, I);
        flatRoof(a, P, ye + 0.12, T(b.rc !== undefined ? b.rc : LK && LK.roof ? LK.roof : b.k === 'c' || b.k === 'S' ? (h3 < 0.5 ? TAR : 0xb9bab6) : TAR));
        // its taller parts (a hall, a stage, a second floor): each a box on the roof
        if (b.up) for (let k = 0; k < b.up.length; k += 5) {
          const R = [{ x: b.up[k] / 10, z: b.up[k + 1] / 10 }, { x: b.up[k + 2] / 10, z: b.up[k + 1] / 10 }, { x: b.up[k + 2] / 10, z: b.up[k + 3] / 10 }, { x: b.up[k] / 10, z: b.up[k + 3] / 10 }], top = y1 + b.up[k + 4] / 10;
          if (top < ye + 1.2) continue;
          walls(a, R, ye + 0.1, top, wc); flatRoof(a, R, top, rc);
        }
        if ((b.k === 'c' || b.k === 'S' || b.k === 'a') && b.area > 160 && O) {
          const n = b.area > 900 ? 3 : b.area > 350 ? 2 : 1;
          for (let k = 0; k < n; k++) { const s = O.a0 + (O.a1 - O.a0) * (0.25 + 0.5 * hash2(b.i, k * 3 + 1)), t = O.b0 + (O.b1 - O.b0) * (0.3 + 0.4 * hash2(b.i, k * 3 + 2)), x = s * O.ux + t * O.vx, z = s * O.uz + t * O.vz; if ([[0, 0], [2.2, 0], [-2.2, 0], [0, 2.2], [0, -2.2], [1.8, 1.8], [-1.8, 1.8], [1.8, -1.8], [-1.8, -1.8]].every(([dx, dz]) => U.inPoly(x + dx, z + dz, P))) box(ax, T(0x8f9396), x, ye + 0.12 + 0.55, z, 1.1, 0.55, 0.8, Math.atan2(O.ux, O.uz), true); }
        }
      }
      // the chimney: through the roof beside the ridge, and past it
      if (ridge && b.k === 'h' && h3 > 0.45) {
        const pp = ridge.p0 + (ridge.p1 - ridge.p0) * (0.3 + 0.4 * h1), base = ridge.PT(pp, ridge.qm + 0.75, ye);
        box(ax, T(h2 < 0.5 ? 0x8a5a48 : 0x8f8f8a), base[0], (ye + ridge.yr + 0.75) / 2, base[2], 0.32, (ridge.yr + 0.75 - ye) / 2, 0.32, Math.atan2(O.ux, O.uz), true);
      }
      // a church: a small spire at one end of the ridge
      if (b.k === 'w' && ridge) {
        const e = ridge.PT(ridge.p0 + 1.6, ridge.qm, 0);
        box(a, wc, e[0], ridge.yr + 1.4, e[2], 1.1, 1.6, 1.1, Math.atan2(O.ux, O.uz), true);
        const top = [e[0], ridge.yr + 3 + 4.5, e[2]], yb = ridge.yr + 3, cs = O.ux, sn = O.uz;
        const cr = [[-1.25, -1.25], [1.25, -1.25], [1.25, 1.25], [-1.25, 1.25]].map(([s, t]) => [e[0] + s * cs + t * -sn, yb, e[2] + s * sn + t * cs]);
        for (let k = 0; k < 4; k++) triOut(a, rc, cr[k], cr[(k + 1) % 4], top, [e[0], yb - 1, e[2]]);
      }
    }

    /* ------------------------------------------------------------------ trees */
    // every tree is there for everyone (the trunks are solid); the scenery
    // setting only chooses how many facets a crown is drawn with
    const trees = city.trees = [];
    const treeOK = (x, z, r) => {
      for (const [dx, dz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) { const o = occAt(x + dx, z + dz); if (o !== 0 && o !== 2) return false; }
      return true;
    };
    const R0 = U.rng(20261121);
    const real = city.data.trees;
    if (real) {
      // every real tree, from the lidar: where it stands, how tall, how wide, and its colour in the photo
      // (the 2 m grid of what stands where is too coarse for a trunk at a kerb: the streets themselves are asked)
      const segs = []; for (const E of edges) for (let k = 0; k < E.pts.length - 1; k++) segs.push([E.pts[k], E.pts[k + 1], E.hw + 0.7]);
      const onRoad = (x, z) => { for (const g of segs) { if (Math.abs(g[0].x - x) > 90 && Math.abs(g[1].x - x) > 90) continue; if (U.distSeg(x, z, g[0], g[1]) < g[2]) return true; } for (const n of city.nodes) if (n.rRoad && Math.hypot(n.x - x, n.z - z) < n.rRoad + 0.7) return true; return false; };
      const q = b64(real.q), free = (x, z) => { const o = occAt(x, z); return (o === 0 || o === 2 || o === 6) && !onRoad(x, z); };
      for (let n = 0; n < real.n; n++) {
        const k = n * 10, i16 = (o) => { const v = q[o] | (q[o + 1] << 8); return v > 32767 ? v - 65536 : v; };
        let x = i16(k) / 10, z = i16(k + 2) / 10;
        // (its top is not always over its foot: a trunk never stands in a road, a car park or a wall)
        if (!free(x, z)) { let moved = false; for (const d of [1.6, 3.2, 4.8]) { for (let a = 0; a < 8 && !moved; a++) { const nx2 = x + Math.cos(a * 0.785) * d, nz2 = z + Math.sin(a * 0.785) * d; if (free(nx2, nz2)) { x = nx2; z = nz2; moved = true; } } if (moved) break; } if (!moved) continue; }
        trees.push({ x, z, h: q[k + 4] / 5, r: q[k + 5] / 10, col: (q[k + 6] << 16) | (q[k + 7] << 8) | q[k + 8], fir: !!q[k + 9] });
      }
    }
    // along the streets, in the verge
    for (const E of edges) {
      if (real || !E.verge || E.len < 40) continue;
      const S = U.stations(E.pts, 4);
      for (const side of [1, -1]) {
        let next = 12 + R0() * 8;
        for (const s of S) {
          if (s.d < next || s.d > E.len - 12) continue;
          next = s.d + 13 + R0() * 9;
          if (R0() < 0.22) continue;
          const off = side * (E.hKerb + 0.85), x = s.x + s.lx * off, z = s.z + s.lz * off;
          if (occAt(x, z) !== 2) continue;
          // not in the mouth of an alley or a drive
          let blocked = false;
          for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) { const o = occAt(x + dx, z + dz); if (o === 3 || o === 1) blocked = true; }
          if (blocked) continue;
          trees.push({ x, z, fir: R0() < 0.08, h: 8 + R0() * 6, street: true });
        }
      }
    }
    // woods, parks, and back gardens
    const scatter = (P, step, chance, firShare, big) => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const p of P) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
      for (let z = z0; z < z1; z += step) for (let x = x0; x < x1; x += step) {
        const jx = x + (R0() - 0.5) * step * 0.8, jz = z + (R0() - 0.5) * step * 0.8, c = R0(), f = R0(), hh = R0();
        if (c > chance || !U.inPoly(jx, jz, P) || !treeOK(jx, jz, 2)) continue;
        trees.push({ x: jx, z: jz, fir: f < firShare, h: (big ? 13 : 8) + hh * (big ? 12 : 8) });
      }
    };
    if (!real) for (const a of city.areas) {
      if (a.k === 'wood') scatter(a.P, 8, 0.8, 0.6, true);
      else if (a.k === 'park' || a.k === 'grass') scatter(a.P, 20, a.k === 'park' ? 0.5 : 0.25, 0.3, true);
    }
    if (!real) {
      const B = city.box, step = 13;
      for (let z = B.z0 + 6; z < B.z1 - 6; z += step) for (let x = B.x0 + 6; x < B.x1 - 6; x += step) {
        const jx = x + (R0() - 0.5) * step * 0.8, jz = z + (R0() - 0.5) * step * 0.8, c = R0(), f = R0(), hh = R0();
        if (c > 0.5 || !treeOK(jx, jz, 3)) continue;
        if (city.areas.some((a) => (a.k === 'park' || a.k === 'wood' || a.k === 'pitch' || a.k === 'track' || a.k === 'school') && U.inPoly(jx, jz, a.P))) continue;
        trees.push({ x: jx, z: jz, fir: f < 0.3, h: 7 + hh * 9 });
      }
      const pts = city.data.points.tree || [];
      for (let k = 0; k < pts.length; k += 2) if (treeOK(pts[k] / 10, pts[k + 1] / 10, 1)) trees.push({ x: pts[k] / 10, z: pts[k + 1] / 10, fir: false, h: 11 });
    }
    /** a tree's colour from the photo, drawn part of the way to a plain leaf green (the photo has each crown's own shadow in it) */
    const leaf = (hex, keep) => { const a = T(hex), g0 = T(0x5a9a48); return [a[0] * keep + g0[0] * (1 - keep), a[1] * keep + g0[1] * (1 - keep), a[2] * keep + g0[2] * (1 - keep)]; };
    for (const t of trees) {
      const y = city.groundY(t.x, t.z), r = t.fir ? 0.3 : 0.26;
      { const a0 = hash2(t.x * 9, t.z * 9) * 2, R3 = r * 1.3; wallSolids(city, [0, 1, 2].map((k) => ({ x: t.x + Math.cos(a0 + k * 2.0944) * R3, z: t.z + Math.sin(a0 + k * 2.0944) * R3 })), y - 1, y + 4); }
      if (!vis) continue;
      const h = t.h, hh = hash2(Math.round(t.x * 5), Math.round(t.z * 5)), yaw = hh * 6.28;
      const tk = T(TRUNK);
      // drawn twice: in full for near, and as a few facets for far
      for (const far of [false, true]) {
        const a = bucket(t.x, t.z, far ? 'treef' : 'tree');
        const sides = far ? 4 : detail >= 2 ? 6 : 5;
        const ring = (yy, rad, tw) => { const o = []; for (let k = 0; k < sides; k++) { const an = yaw + tw + k / sides * 6.2832; o.push([t.x + Math.cos(an) * rad, yy, t.z + Math.sin(an) * rad]); } return o; };
        const cone = (col, b0, top) => { for (let k = 0; k < sides; k++) triOut(a, col, b0[k], b0[(k + 1) % sides], top, [t.x, b0[0][1], t.z]); };
        const band = (col, b0, b1) => { for (let k = 0; k < sides; k++) quad(a, col, b0[k], b0[(k + 1) % sides], b1[(k + 1) % sides], b1[k], [t.x, (b0[0][1] + b1[0][1]) / 2, t.z]); };
        if (!far) { const b0 = [], b1 = [], th = t.fir ? h * 0.22 : h * 0.36; for (let k = 0; k < 3; k++) { const an = yaw + k * 2.0944; b0.push([t.x + Math.cos(an) * r * 1.2, y - 0.3, t.z + Math.sin(an) * r * 1.2]); b1.push([t.x + Math.cos(an) * r * 0.8, y + th, t.z + Math.sin(an) * r * 0.8]); } for (let k = 0; k < 3; k++) quad(a, tk, b0[k], b0[(k + 1) % 3], b1[(k + 1) % 3], b1[k], [t.x, y + 1, t.z]); }
        if (t.fir) {
          const own = t.col !== undefined ? leaf(t.col, 0.55) : null;
          const col = own || T(PAL.fir[Math.floor(hh * 4) % 4]), col2 = own ? own.map((v) => v * 0.86) : T(PAL.fir[Math.floor(hh * 4 + 1) % 4]), w = t.r ? Math.min(t.r, h * 0.24) : h * 0.2;
          if (far) cone(col, ring(y + h * 0.18, w, 0), [t.x, y + h, t.z]);
          else { cone(col, ring(y + h * 0.18, w, 0), [t.x, y + h * 0.62, t.z]); cone(col2, ring(y + h * 0.45, w * 0.7, 0.5), [t.x, y + h, t.z]); }
        } else {
          // an autumn tree here and there (it is November)
          const au = hash2(Math.round(t.x * 3) + 7, Math.round(t.z * 3)) < 0.3;
          const col = t.col !== undefined ? leaf(t.col, 0.4) : T((au ? PAL.autumn : PAL.leaf)[Math.floor(hh * 5) % 5]), low = col.map((v) => v * 0.9), w = t.r ? Math.min(t.r, h * 0.6) : h * (0.27 + hh * 0.09);
          const top = [t.x + (hh - 0.5) * 0.6, y + h, t.z];
          if (far) { const r1 = ring(y + h * 0.56, w, 0.4); cone(col, r1, top); cone(low, r1.slice().reverse(), [t.x, y + h * 0.3, t.z]); }
          else {
            const r0 = ring(y + h * 0.32, w * 0.72, 0), r1 = ring(y + h * 0.56, w, 0.4), r2 = ring(y + h * 0.82, w * 0.66, 0.8);
            band(low, r0, r1); band(col, r1, r2); cone(col, r2, top);
            for (let k = 0; k < sides; k++) triOut(a, low, r0[(k + 1) % sides], r0[k], [t.x, y + h * 0.3, t.z], [t.x, y + h * 0.6, t.z]);
          }
        }
      }
    }

    /* --------------------------------------------------------- the creek etc. */
    if (vis) {
      // a path or lane that crosses the creek is a bridge: a deck with sides and an underside, not a sheet
      const carveAt = (x, z) => { const i = Math.round((x - U.fx0) / FS), j = Math.round((z - U.fz0) / FS); return i < 0 || j < 0 || i >= U.nx || j >= U.nz ? 0 : city.carve[j * U.nx + i]; };
      for (const l of city.lanes) {
        const S = U.stations(l.pts, 4), lift = l.k === 'f' ? LAYER.walk.lift : LAYER.lot.lift, hw = l.w / 2, dc = T(CONCRETE);
        for (let q = 0; q < S.length - 1; q++) {
          const p0 = S[q], p1 = S[q + 1];
          if (carveAt((p0.x + p1.x) / 2, (p0.z + p1.z) / 2) < 0.4 && carveAt(p0.x, p0.z) < 0.4 && carveAt(p1.x, p1.z) < 0.4) continue;
          const a = bucket(p0.x, p0.z, 'bld'), y0 = Hs(p0.x, p0.z) + lift - 0.01, y1 = Hs(p1.x, p1.z) + lift - 0.01, D = 0.45;
          const L0 = [p0.x + p0.lx * hw, y0, p0.z + p0.lz * hw], R0 = [p0.x - p0.lx * hw, y0, p0.z - p0.lz * hw], L1 = [p1.x + p1.lx * hw, y1, p1.z + p1.lz * hw], R1 = [p1.x - p1.lx * hw, y1, p1.z - p1.lz * hw];
          const dn = (p) => [p[0], p[1] - D, p[2]], I = [(p0.x + p1.x) / 2, (y0 + y1) / 2 - D / 2, (p0.z + p1.z) / 2];
          quad(a, dc, L0, L1, dn(L1), dn(L0), I); quad(a, dc, R0, R1, dn(R1), dn(R0), I); quad(a, dc, dn(L0), dn(L1), dn(R1), dn(R0), I);
          // and a rail each side
          for (const [A, B] of [[L0, L1], [R0, R1]]) { const up = (p, h) => [p[0], p[1] + h, p[2]]; quad(a, T(0x5a5f66), up(A, 0.95), up(B, 0.95), up(B, 1.05), up(A, 1.05), [I[0], I[1] - 9, I[2]]); quad(a, T(0x5a5f66), up(A, 0.95), up(B, 0.95), up(B, 1.05), up(A, 1.05), [I[0], I[1] + 9, I[2]]); }
        }
      }
      const CK = city.CREEK, wc = T(0x3a6f8a);
      for (const s of city.streams) {
        if (s.culvert) continue;
        // water lying in the bottom of the channel; its ends run on under the bank where the channel stops
        const S = U.stations(s.pts, 6);
        for (let q = 0; q < S.length - 1; q++) {
          const p0 = S[q], p1 = S[q + 1], hw = CK.bed + 1.2;
          const yA = Hs(p0.x, p0.z) - CK.depth + 0.45 - 0.03, yB = Hs(p1.x, p1.z) - CK.depth + 0.45 - 0.03;
          const a = bucket((p0.x + p1.x) / 2, (p0.z + p1.z) / 2, 'water');
          quad(a, wc, [p0.x + p0.lx * hw, yA, p0.z + p0.lz * hw], [p0.x - p0.lx * hw, yA, p0.z - p0.lz * hw], [p1.x - p1.lx * hw, yB, p1.z - p1.lz * hw], [p1.x + p1.lx * hw, yB, p1.z + p1.lz * hw], [p0.x, yA - 5, p0.z]);
        }
      }
      for (const ar of city.areas) {
        if (ar.k === 'water' && !ar.channel) { let ym = Infinity; for (const p of ar.P) ym = Math.min(ym, Hs(p.x, p.z)); const a = bucket(ar.P[0].x, ar.P[0].z, 'water'); for (const t of U.triangulate(ar.P)) triOut(a, wc, [ar.P[t[0]].x, ym - 0.4, ar.P[t[0]].z], [ar.P[t[1]].x, ym - 0.4, ar.P[t[1]].z], [ar.P[t[2]].x, ym - 0.4, ar.P[t[2]].z], [ar.P[t[0]].x, ym - 5, ar.P[t[0]].z]); }
      }
    }
    // swimming pools: a coping round the water (solid), the water inside it
    for (const ar of city.areas) {
      if (ar.k !== 'pool') continue;
      let ym = -Infinity, cx = 0, cz = 0; for (const p of ar.P) { ym = Math.max(ym, Hs(p.x, p.z)); cx += p.x; cz += p.z; }
      cx /= ar.P.length; cz /= ar.P.length;
      if (occAt(cx, cz) === 4) continue;                               // an indoor pool: under a roof already
      wallSolids(city, ar.P, ym - 1, ym + 0.42, cx, cz);
      U.occPoly(ar.P, 5, 0.5);
      if (!vis) continue;
      const a = bucket(cx, cz, 'bld'), aw = bucket(cx, cz, 'water');
      walls(a, ar.P.slice().reverse(), ym + 0.2, ym + 0.42, T(0xd6d6d0));          // (the coping's inner face, towards the water)
      flatRoof(aw, ar.P, ym + 0.3, T(0x4aa3c4));
      // (the coping's top: a rim just outside the water)
      const grown = ar.P.map((p) => { const dx = p.x - cx, dz = p.z - cz, L = Math.hypot(dx, dz) || 1; return { x: p.x + dx / L * 0.45, z: p.z + dz / L * 0.45 }; });
      walls(a, grown, ym - 0.6, ym + 0.36, T(0xd6d6d0), [cx, ym, cz]);
      for (let i = 0; i < ar.P.length; i++) { const p = ar.P[i], q = ar.P[(i + 1) % ar.P.length], gp = grown[i], gq = grown[(i + 1) % ar.P.length]; quad(a, T(0xe2e2dc), [p.x, ym + 0.42, p.z], [q.x, ym + 0.42, q.z], [gq.x, ym + 0.36, gq.z], [gp.x, ym + 0.36, gp.z], [cx, ym - 3, cz]); }
    }

    /* ------------------------------------------------------- street furniture */
    // the barrier across each street that leaves the map is solid
    for (const n of city.nodes) {
      if (!n.cut || n.edges.length !== 1) continue;
      const E = n.edges[0], P = E.pts, atB = E.b === n.i, p = atB ? P[P.length - 1] : P[0], q = atB ? P[P.length - 2] : P[1];
      const L = Math.hypot(q.x - p.x, q.z - p.z) || 1, tx = (q.x - p.x) / L, tz = (q.z - p.z) / L, x = p.x + tx * 2, z = p.z + tz * 2, y = Hs(x, z);
      solidBox(x, y - 1, y + 1.25, z, E.hw - 0.1, 0.12, Math.atan2(tx, tz));
    }
    if (vis) {
      const grey = T(0x6f7478), red = T(0xb5282a), white = T(0xe9e9e6), yellow = T(0xd9a514), dark = T(0x2c2f33);
      // stop signs, on the right of each lane that has a stop bar
      for (const n of city.nodes) for (const st of (n.stops || [])) {
        const E = st.E, S = U.stations(E.pts, 30, Math.max(0, st.d - 0.4), Math.min(E.len, st.d + 0.4));
        if (!S.length) continue;
        const s = S[0], side = st.atEnd ? -1 : 1, x = s.x + s.lx * side * (E.hKerb + 0.7), z = s.z + s.lz * side * (E.hKerb + 0.7), y = Hs(x, z);
        const a = bucket(x, z, 'bldx'), yaw = Math.atan2(s.tx, s.tz);
        box(a, grey, x, y + 1.15, z, 0.04, 1.15, 0.04, yaw, true);
        box(a, red, x, y + 2.3, z, 0.36, 0.36, 0.03, yaw + Math.PI / 4, false);
      }
      // traffic lights: a pole and a head at each mapped signal
      const sig = city.data.points.signal || [];
      for (let k = 0; k < sig.length; k += 2) {
        const sx = sig[k] / 10, sz = sig[k + 1] / 10, near = nearestStreetDist(sx, sz);
        if (!near.E) continue;
        const E = near.E;
        for (const sd of [1, -1]) {
          let bx = sx, bz = sz, best = Infinity;
          for (const sp of U.stations(E.pts, 6)) { const d = Math.hypot(sp.x - sx, sp.z - sz); if (d < best) { best = d; bx = sp.x + sp.lx * sd * (E.hKerb + 0.8); bz = sp.z + sp.lz * sd * (E.hKerb + 0.8); } }
          if (occAt(bx, bz) === 1 || occAt(bx, bz) === 4) continue;
          const y = Hs(bx, bz), a = bucket(bx, bz, 'bldx');
          box(a, dark, bx, y + 2.6, bz, 0.09, 2.6, 0.09, 0, true);
          box(a, yellow, bx, y + 4.6, bz, 0.2, 0.55, 0.2, 0, false);
        }
      }
      // street lamps and bus stops
      const lamps = city.data.points.lamp || [];
      for (let k = 0; k < lamps.length; k += 2) { const x = lamps[k] / 10, z = lamps[k + 1] / 10; if (occAt(x, z) === 1 || occAt(x, z) === 4) continue; const y = Hs(x, z), a = bucket(x, z, 'bldx'); box(a, dark, x, y + 3.2, z, 0.07, 3.2, 0.07, 0, true); box(a, T(0xe9e6d8), x, y + 6.5, z, 0.3, 0.1, 0.3, 0, false); }
      const bus = city.data.points.bus || [];
      for (let k = 0; k < bus.length; k += 2) {
        const x = bus[k] / 10, z = bus[k + 1] / 10;
        if (occAt(x, z) === 1 || occAt(x, z) === 4) continue;
        const y = Hs(x, z), a = bucket(x, z, 'bldx');
        box(a, grey, x, y + 1.3, z, 0.04, 1.3, 0.04, 0, true);
        box(a, T(0x2a6f5a), x, y + 2.35, z, 0.25, 0.3, 0.03, hash2(k, 3) * 3, false);
      }
      // where a street leaves the map: a barrier across it
      for (const n of city.nodes) {
        if (!n.cut || n.edges.length !== 1) continue;
        const E = n.edges[0], P = E.pts, atB = E.b === n.i, p = atB ? P[P.length - 1] : P[0], q = atB ? P[P.length - 2] : P[1];
        const L = Math.hypot(q.x - p.x, q.z - p.z) || 1, tx = (q.x - p.x) / L, tz = (q.z - p.z) / L, yaw = Math.atan2(tx, tz);
        for (let s = -E.hw + 1.3; s <= E.hw - 1.2; s += 2.6) {
          const x = p.x + tx * 2 + tz * s, z = p.z + tz * 2 - tx * s, y = Hs(x, z) + 0.14, a = bucket(x, z, 'bldx');
          box(a, white, x, y + 0.95, z, 1.15, 0.13, 0.04, yaw, false);
          box(a, T(0xd9541f), x, y + 0.6, z, 1.15, 0.1, 0.04, yaw, false);
          for (const o of [-1, 1]) box(a, grey, x + tz * o * 0.95, y + 0.5, z - tx * o * 0.95, 0.04, 0.5, 0.3, yaw, true);
        }
      }
      // spectator stands: three rising steps on each mapped outline
      for (const ar of city.areas) {
        if (ar.k !== 'bleachers') continue;
        const O = obb(ar.P); if (!O) continue;
        let ym = -Infinity; for (const p of ar.P) ym = Math.max(ym, Hs(p.x, p.z));
        const ca = (O.a0 + O.a1) / 2, cb = (O.b0 + O.b1) / 2, x = ca * O.ux + cb * O.vx, z = ca * O.uz + cb * O.vz, a = bucket(x, z, 'bld');
        const steps = Math.max(2, Math.min(6, Math.round((O.b1 - O.b0) / 0.9))), yaw = Math.atan2(O.ux, O.uz);
        // (they rise away from the nearest pitch)
        let dir = 1; { let bd = Infinity; for (const pa of city.areas) { if (pa.k !== 'pitch' && pa.k !== 'track') continue; const c = pa.P[0]; const d = Math.hypot(c.x - x, c.z - z); if (d < bd) { bd = d; dir = ((c.x - x) * O.vx + (c.z - z) * O.vz) > 0 ? -1 : 1; } } }
        for (let k = 0; k < steps; k++) {
          const t = cb + dir * ((k + 0.5) / steps - 0.5) * (O.b1 - O.b0), bx = ca * O.ux + t * O.vx, bz = ca * O.uz + t * O.vz;
          box(a, T(0xb9bcc0), bx, ym + (k + 1) * 0.2, bz, (O.b1 - O.b0) / steps / 2, (k + 1) * 0.2, (O.a1 - O.a0) / 2, yaw, true);
        }
        solidBox(x, ym - 1, ym + steps * 0.4, z, (O.b1 - O.b0) / 2, (O.a1 - O.a0) / 2, yaw);
      }
    } else {
      for (const ar of city.areas) { if (ar.k !== 'bleachers') continue; const O = obb(ar.P); if (!O) continue; let ym = -Infinity; for (const p of ar.P) ym = Math.max(ym, Hs(p.x, p.z)); const ca = (O.a0 + O.a1) / 2, cb = (O.b0 + O.b1) / 2, steps = Math.max(2, Math.min(6, Math.round((O.b1 - O.b0) / 0.9))); solidBox(ca * O.ux + cb * O.vx, ym - 1, ym + steps * 0.4, ca * O.uz + cb * O.vz, (O.b1 - O.b0) / 2, (O.a1 - O.a0) / 2, Math.atan2(O.ux, O.uz)); }
    }
    city.helpers = { box, quad, triOut, tri, walls, flatRoof, pitched, wallOut, bucket, T, obb, solidBox, rectsOf, nearestStreetDist };
  }

  /* =========================================================== the drawn city
     Cut into 256 m chunks. Each chunk is a handful of meshes, so the whole
     view is a few dozen draw calls:
       - the flat layers as ONE mesh (each corner knows its layer; the vertex
         shader nudges it that many depth steps towards the camera, which is
         what keeps one layer in front of the next however far away);
       - the ground, near (as fine as the land needs) and far (16 m squares,
         set 30 cm down so it cannot show through a road);
       - buildings: walls and roofs first in the buffer, doors, porches,
         chimneys and signs after, so a far chunk draws only the first part;
       - trees; water.                                                      */
  function assemble(city) {
    const U = city._, nx = U.nx, fx0 = U.fx0, fz0 = U.fz0, fh = U.fh, rgb = U.rgb;
    const root = new THREE.Group();
    const std = (o) => new THREE.MeshStandardMaterial(Object.assign({ vertexColors: true, roughness: 0.92, metalness: 0 }, o));
    const mats = { terrain: std({ roughness: 1 }), bld: std({ flatShading: true, roughness: 0.86, map: facades() }), bldf: std({ flatShading: true, roughness: 0.86 }), tree: std({ flatShading: true, roughness: 1, emissive: 0x010402 }),
      water: std({ flatShading: true, roughness: 0.18, metalness: 0.3 }), flat: std({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }) };
    // (a wall's colour tints only the picture's wall: its alpha says where that is)
    mats.bld.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', 'diffuseColor.rgb *= mix(vec3(1.0), vColor, diffuseColor.a); diffuseColor.a = 1.0;'); };
    mats.flat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aLayer;')
        .replace('#include <project_vertex>', '#include <project_vertex>\n\tgl_Position.z -= aLayer * 2.4e-7 * gl_Position.w;');
    };
    /* The aerial photo on the ground: four quarters of the 1536 m square round
       the origin (or the whole square in one small picture, for slow
       computers). Until a picture has loaded its ground is plain green. */
    const ph = city.photo && typeof document !== 'undefined' ? city.data.photo : null, PH = ph ? ph.half : 0, lowPhoto = !!(city.opts && city.opts.photoLow);
    const terrMat = (file) => {
      const m = std({ roughness: 1 });
      m.color.setRGB.apply(m.color, rgb(0x5a8f45));
      new THREE.TextureLoader().load((env.base || 'maps/') + ph.dir + file, (t) => { t.encoding = THREE.sRGBEncoding; t.anisotropy = 4; m.map = t; m.color.setRGB(1, 1, 1); m.needsUpdate = true; });
      return m;
    };
    if (ph) { if (lowPhoto) mats.terrAll = terrMat(ph.all); else ph.quarters.forEach((f, k) => { mats['terr' + k] = terrMat(f); }); }
    /** which picture (x, z) is in, and where in it */
    const photoOf = (x, z) => {
      if (lowPhoto) return { g: 'terrAll', u0: PH, v0: -PH, k: 1 / (2 * PH) };
      const i = x >= 0 ? 0 : 1, j = z >= 0 ? 1 : 0;
      return { g: 'terr' + (i * 2 + j), u0: i ? 0 : PH, v0: j ? 0 : -PH, k: 1 / PH };
    };
    city.mats = mats;
    const chunks = new Map();
    const chunkOf = (key) => {
      let c = chunks.get(key);
      if (!c) { const [cx, cz] = key.split(':').map(Number); c = { g: new THREE.Group(), x: (cx + 0.5) * CHUNK, z: (cz + 0.5) * CHUNK, near: [], far: [] }; chunks.set(key, c); root.add(c.g); }
      return c;
    };
    let tris = 0;
    const mesh = (key, group, geo, order, far) => {
      geo.computeBoundingSphere();
      const m = new THREE.Mesh(geo, mats[group]);
      m.renderOrder = order;
      m.receiveShadow = group !== 'tree' && group !== 'water';
      m.castShadow = (group === 'bld' || group === 'tree') && !far;
      m.visible = !far;
      if (far !== undefined) chunkOf(key)[far ? 'far' : 'near'].push(m);
      m.userData.group = /^terr/.test(group) ? 'terrain' : group;
      chunkOf(key).g.add(m);
      tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
      return m;
    };
    const attr = (geo, name, arr, n) => geo.setAttribute(name, new THREE.BufferAttribute(arr, n));
    const cat = (list) => { let n = 0; for (const a of list) n += a.length; const out = new Float32Array(n); let o = 0; for (const a of list) { out.set(a, o); o += a.length; } return out; };
    // sort what was collected by chunk
    const by = new Map();
    for (const [key, a] of U.accs) { const k = key.split(':'), ck = k[0] + ':' + k[1]; if (!by.has(ck)) by.set(ck, {}); by.get(ck)[a.group] = a; }
    U.accs.clear();
    const TOP = ['paint', 'road', 'lot', 'kerb', 'verge', 'walk', 'mark', 'pitch', 'ground'];          // the upper layers first: what they hide is then never shaded
    for (const [ck, G] of by) {
      const fl = TOP.filter((k) => G[k] && G[k].p.length);
      if (fl.length) {
        const geo = new THREE.BufferGeometry(), lay = [];
        for (const k of fl) { const v = new Float32Array(G[k].p.length / 3); v.fill(LAYER[k].off); lay.push(v); }
        attr(geo, 'position', cat(fl.map((k) => G[k].p)), 3); attr(geo, 'normal', cat(fl.map((k) => G[k].n)), 3); attr(geo, 'color', cat(fl.map((k) => G[k].c)), 3); attr(geo, 'aLayer', cat(lay), 1);
        mesh(ck, 'flat', geo, 1);
      }
      if (G.bld || G.bldx) {
        const parts = [G.bld, G.bldx].filter(Boolean), geo = new THREE.BufferGeometry();
        attr(geo, 'position', cat(parts.map((a) => a.p)), 3); attr(geo, 'color', cat(parts.map((a) => a.c)), 3); attr(geo, 'uv', cat(parts.map((a) => a.u)), 2);
        mesh(ck, 'bld', geo, 2, false);
      }
      for (const [k, mat, far] of [['tree', 'tree', false], ['treef', 'tree', true], ['bldf', 'bldf', true], ['water', 'water', undefined]]) {
        if (!G[k] || !G[k].p.length) continue;
        const geo = new THREE.BufferGeometry();
        attr(geo, 'position', new Float32Array(G[k].p), 3); attr(geo, 'color', new Float32Array(G[k].c), 3);
        const m = mesh(ck, mat, geo, 3, far);
        if (far) tris -= geo.attributes.position.count / 3;
      }
    }
    /* the ground, coloured by what grows there */
    const cover = new Uint8Array(nx * U.nz);       // 0 garden, 1 park, 2 wood, 3 mown grass, 4 wet
    const paintArea = (P, v) => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const p of P) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
      for (let j = Math.max(0, Math.floor((z0 - fz0) / FS)); j <= Math.min(U.nz - 1, Math.ceil((z1 - fz0) / FS)); j++)
        for (let i = Math.max(0, Math.floor((x0 - fx0) / FS)); i <= Math.min(nx - 1, Math.ceil((x1 - fx0) / FS)); i++)
          if (U.inPoly(fx0 + i * FS, fz0 + j * FS, P)) cover[j * nx + i] = v;
    };
    for (const a of city.areas) { if (a.k === 'park') paintArea(a.P, 1); }
    for (const a of city.areas) { if (a.k === 'grass' || a.k === 'school') paintArea(a.P, 3); else if (a.k === 'wetland') paintArea(a.P, 4); }
    for (const a of city.areas) { if (a.k === 'wood') paintArea(a.P, 2); }
    const CV = [rgb(COL.yard), rgb(COL.park), rgb(COL.wood), rgb(COL.grass), rgb(0x6b8048)], MUD = rgb(COL.mud), FAR = rgb(0x5a8f45);
    const B = city.box;
    let PQ = null, uvA = null;
    const vertex = (i, j, s, drop, pos, col, nrm, o) => {
      const k = j * nx + i, x = fx0 + i * FS, z = fz0 + j * FS;
      pos[o] = x; pos[o + 1] = fh[k] - drop; pos[o + 2] = z;
      if (PQ) { uvA[o / 3 * 2] = (PQ.u0 - x) * PQ.k; uvA[o / 3 * 2 + 1] = (z - PQ.v0) * PQ.k; }
      const hl = fh[j * nx + Math.max(0, i - s)], hr = fh[j * nx + Math.min(nx - 1, i + s)], hd = fh[Math.max(0, j - s) * nx + i], hu = fh[Math.min(U.nz - 1, j + s) * nx + i];
      const gx = (hr - hl) / (2 * s * FS), gz = (hu - hd) / (2 * s * FS), l = Math.hypot(gx, 1, gz);
      nrm[o] = -gx / l; nrm[o + 1] = 1 / l; nrm[o + 2] = -gz / l;
      let c = CV[cover[k]];
      if (city.carve[k] > 0.5) c = MUD;
      if (Math.max(B.x0 - x, x - B.x1, B.z0 - z, z - B.z1) > 10) c = FAR;
      const v = 0.92 + 0.16 * U.hash2(i * 3 + 1, j * 3 + 2);
      if (PQ) { col[o] = col[o + 1] = col[o + 2] = 1; return; }
      col[o] = c[0] * v; col[o + 1] = c[1] * v; col[o + 2] = c[2] * v;
    };
    const grid = (n, base, idx, q) => {
      // (cut along the same diagonal as the physics reads it: from the corner at low x, low z to the one at high x, high z)
      for (let b = 0; b < n - 1; b++) for (let a = 0; a < n - 1; a++) { const v0 = base + b * n + a, v1 = v0 + 1, v2 = v0 + n, v3 = v2 + 1; idx[q++] = v0; idx[q++] = v3; idx[q++] = v1; idx[q++] = v0; idx[q++] = v2; idx[q++] = v3; }
      return q;
    };
    const CT = CHUNK / TILE;                          // tiles along a chunk's side
    for (let cz = Math.floor(fz0 / CHUNK); cz * CHUNK < fz0 + U.tnz * TILE; cz++) for (let cx = Math.floor(fx0 / CHUNK); cx * CHUNK < fx0 + U.tnx * TILE; cx++) {
      const tiles = [];
      for (let b = 0; b < CT; b++) for (let a = 0; a < CT; a++) { const tx = Math.round((cx * CHUNK - fx0) / TILE) + a, tz = Math.round((cz * CHUNK - fz0) / TILE) + b; if (tx >= 0 && tz >= 0 && tx < U.tnx && tz < U.tnz) tiles.push([tx, tz]); }
      if (!tiles.length) continue;
      let nv = 0, ni = 0;
      for (const [tx, tz] of tiles) { const n = TN / U.stride[tz * U.tnx + tx] + 1; nv += n * n; ni += (n - 1) * (n - 1) * 6; }
      const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), idx = new Uint32Array(ni);
      PQ = ph ? photoOf((cx + 0.5) * CHUNK, (cz + 0.5) * CHUNK) : null;
      const tg = PQ ? PQ.g : 'terrain', uv1 = PQ ? new Float32Array(nv * 2) : null;
      uvA = uv1;
      let o = 0, q = 0, allFar = true;
      for (const [tx, tz] of tiles) {
        const s = U.stride[tz * U.tnx + tx], n = TN / s + 1, base = o / 3;
        if (s < 4) allFar = false;
        for (let lj = 0; lj <= TN; lj += s) for (let li = 0; li <= TN; li += s) { vertex(tx * TN + li, tz * TN + lj, s, 0, pos, col, nrm, o); o += 3; }
        q = grid(n, base, idx, q);
      }
      const ck = cx + ':' + cz, geo = new THREE.BufferGeometry();
      attr(geo, 'position', pos, 3); attr(geo, 'color', col, 3); attr(geo, 'normal', nrm, 3); geo.setIndex(new THREE.BufferAttribute(idx, 1));
      if (uv1) attr(geo, 'uv', uv1, 2);
      if (allFar) { mesh(ck, tg, geo, 4); continue; }
      mesh(ck, tg, geo, 4, false);                            // (already as coarse as the far one would be)
      // the far version: 16 m squares, a little lower
      const FSTR = 4, fn = TN / FSTR + 1;
      const fp = new Float32Array(tiles.length * fn * fn * 3), fc = new Float32Array(fp.length), fnm = new Float32Array(fp.length), fi = new Uint32Array(tiles.length * (fn - 1) * (fn - 1) * 6);
      const uv2 = PQ ? new Float32Array(fp.length / 3 * 2) : null;
      uvA = uv2;
      o = 0; q = 0;
      for (const [tx, tz] of tiles) {
        const base = o / 3;
        for (let lj = 0; lj <= TN; lj += FSTR) for (let li = 0; li <= TN; li += FSTR) { vertex(tx * TN + li, tz * TN + lj, FSTR, 0.3, fp, fc, fnm, o); o += 3; }
        q = grid(fn, base, fi, q);
      }
      const fgeo = new THREE.BufferGeometry();
      attr(fgeo, 'position', fp, 3); attr(fgeo, 'color', fc, 3); attr(fgeo, 'normal', fnm, 3); fgeo.setIndex(new THREE.BufferAttribute(fi, 1));
      if (uv2) attr(fgeo, 'uv', uv2, 2);
      mesh(ck, tg, fgeo, 4, true);
      tris -= fi.length / 3;
    }
    city.chunks = Array.from(chunks.values());
    city.stats.drawnTris = Math.round(tris);
    city.stats.meshes = 0; root.traverse((o) => { if (o.isMesh) city.stats.meshes++; });
    /** hides what is too far to see, and draws the far chunks plainly: call with the camera's position and how far the haze reaches */
    city.cull = (cam, far, nearR) => {
      const lim = far + CHUNK * 0.75, nr = nearR || 300;
      for (const c of city.chunks) {
        const d = Math.hypot(c.x - cam.x, c.z - cam.z);
        c.g.visible = d < lim;
        if (!c.g.visible) continue;
        const close = d < nr;
        for (const m of c.near) m.visible = close;
        for (const m of c.far) m.visible = !close;
      }
    };
    city.shadows = (on) => { for (const c of city.chunks) for (const m of c.near) if (m.userData.group === 'bld' || m.userData.group === 'tree') m.castShadow = !!on; };
    return root;
  }

  /** puts the city into a physics world: the ground as a height field, the flat layers and the walls as triangles */
  function intoWorld(city, world) {
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    world.field = city.field;
    const P = city.phys;
    for (let k = 0; k < P.length; k += 19) {
      world.addTri(V(P[k], P[k + 1], P[k + 2]), V(P[k + 3], P[k + 4], P[k + 5]), V(P[k + 6], P[k + 7], P[k + 8]), 1, P[k + 18],
        V(P[k + 9], P[k + 10], P[k + 11]), V(P[k + 12], P[k + 13], P[k + 14]), V(P[k + 15], P[k + 16], P[k + 17]), true, 0);
    }
    const S = city.solids, inside = V(0, 0, 0);
    for (let k = 0; k < S.length; k += 15) {
      const a = V(S[k], S[k + 1], S[k + 2]), b = V(S[k + 3], S[k + 4], S[k + 5]), c = V(S[k + 6], S[k + 7], S[k + 8]), d = V(S[k + 9], S[k + 10], S[k + 11]);
      inside.set(S[k + 12], S[k + 13], S[k + 14]);
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      if (n.dot(new THREE.Vector3().subVectors(a, inside)) >= 0) world.addQuad(a, b, c, d, 1, 0.9, false, null, false);
      else world.addQuad(a, d, c, b, 1, 0.9, false, null, false);
    }
    world.index();
    world.fullHull = true;
  }

  return { build, wallSolids, LAYER, COL, FS, TILE, CHUNK, APRON, BIAS };
};
})(typeof self !== 'undefined' ? self : globalThis);
