// The open-world city, checked without a browser:
//   node tools/sim/city_check.js [quick]
// 1. builds the city from maps/eugene.js with maps/city.js (no visuals);
// 2. the flat layers: every one stands clear of the ground under it;
// 3. the street network: every stretch can be reached from the start;
// 4. drives the real car along every street (a simple driver that follows the
//    middle of its lane): it must never fall through, never end up inside a
//    building or under the road, and never get stuck;
// 5. drives it straight at walls: it must stop outside them.
const path = require('path');
const h = require('./harness.js');
const THREE = h.THREE;
const m = h.load();
const root = path.join(__dirname, '..', '..');
require(path.join(root, 'maps', 'eugene.js'));
require(path.join(root, 'maps', 'city.js'));
const quick = process.argv[2] === 'quick';

const t0 = Date.now();
const kit = globalThis.CityKit({ THREE, GROUND_Y: m.GROUND_Y });
const city = kit.build(globalThis.CityData.eugene, { visual: false });
const world = new m.PhysicsWorld();
city.intoWorld(world);
console.log('built in', Date.now() - t0, 'ms:', JSON.stringify(city.stats), 'world tris', world.tris.length);
let bad = 0;
const fail = (msg) => { bad++; console.log('FAIL', msg); };

/* 2. layers clear of the ground */
{
  let worst = Infinity, n = 0;
  const P = city.phys;
  for (let k = 0; k < P.length; k += 19) {
    for (const [u, v] of [[1 / 3, 1 / 3], [0.6, 0.2], [0.2, 0.6], [0.1, 0.1], [0.5, 0.5], [0, 0.5], [0.5, 0]]) {
      const w = 1 - u - v;
      const x = P[k] * w + P[k + 3] * u + P[k + 6] * v, y = P[k + 1] * w + P[k + 4] * u + P[k + 7] * v, z = P[k + 2] * w + P[k + 5] * u + P[k + 8] * v;
      // (where the creek is cut the layers bridge it: the ground is far below, which is fine)
      const gap = y - city.groundY(x, z);
      if (gap < worst) worst = gap;
      n++;
    }
  }
  console.log('layers: least height above the ground', worst.toFixed(3), 'm over', n, 'samples');
  if (worst < 0.02) fail('a flat layer comes within 2 cm of the ground (it would flicker or sink)');
}

/* 3. every stretch reachable */
{
  const seen = new Set();
  const start = city.nearestStreet(city.spawn.x, city.spawn.z).E;
  const todo = [start.a, start.b];
  const nodeSeen = new Set(todo);
  while (todo.length) { const n = city.nodes[todo.pop()]; for (const E of n.edges) { seen.add(E.i); for (const o of [E.a, E.b]) if (!nodeSeen.has(o)) { nodeSeen.add(o); todo.push(o); } } }
  const cut = city.edges.filter((E) => !seen.has(E.i));
  console.log('network:', city.edges.length, 'stretches,', cut.length, 'not connected to the start', cut.length ? '(' + [...new Set(cut.map((E) => E.name || '?'))].join(', ') + ')' : '');
  if (cut.length > city.edges.length * 0.03) fail('too many streets are cut off from the start');
}

/* 4. drive every street */
const H = 1 / 360;
const insideBuilding = (x, z) => city.buildings.some((b) => { const P = b.P; let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], q = P[j]; if ((a.z > z) !== (q.z > z) && x < (q.x - a.x) * (z - a.z) / (q.z - a.z) + a.x) c = !c; } return c; });
function driveEdge(E, rev, speedCap) {
  const pts = rev ? E.pts.slice().reverse() : E.pts;
  const car = new m.Vehicle(null);
  const a = pts[0], b = pts[1], L0 = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const tx = (b.x - a.x) / L0, tz = (b.z - a.z) / L0, off = E.one ? 0 : -E.hw / 2;
  const sx = a.x + tx * 6 + tz * off, sz = a.z + tz * 6 - tx * off;
  car.place(new THREE.Vector3(sx, city.Hs(sx, sz) + 0.14 + m.CAR.comHeight + 0.05, sz), Math.atan2(tx, tz));
  // the lane's middle, as points to steer at
  const line = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const p = pts[k], q = pts[k + 1], L = Math.hypot(q.x - p.x, q.z - p.z) || 1, ux = (q.x - p.x) / L, uz = (q.z - p.z) / L;
    for (let d = 0; d < L; d += 3) line.push({ x: p.x + ux * d + uz * off, z: p.z + uz * d - ux * off });
  }
  let idx = 0, t = 0, maxSink = 0, minY = Infinity, stuck = 0, top = 0;
  const end = line.length - 3;
  while (t < 90 && idx < end) {
    let bd = Infinity;
    for (let k = idx; k < Math.min(line.length, idx + 30); k++) { const d = (line[k].x - car.pos.x) ** 2 + (line[k].z - car.pos.z) ** 2; if (d < bd) { bd = d; idx = k; } }
    const tgt = line[Math.min(line.length - 1, idx + Math.max(3, Math.round(car.speed * 0.25)))];
    let err = Math.atan2(tgt.x - car.pos.x, tgt.z - car.pos.z) - car.heading;
    while (err > Math.PI) err -= 2 * Math.PI; while (err < -Math.PI) err += 2 * Math.PI;
    const input = { throttle: car.speed < speedCap ? 1 : 0, brake: car.speed > speedCap + 4 ? 1 : 0, steer: Math.max(-1, Math.min(1, -err * 2.2)), handbrake: 0, boost: 0 };
    if (!car.step(H, world, input)) return { fail: 'not finite' };
    t += H;
    top = Math.max(top, car.speed);
    const under = city.Hs(car.pos.x, car.pos.z) - car.pos.y;                 // the car's middle under the smooth ground
    if (under > maxSink) maxSink = under;
    minY = Math.min(minY, car.pos.y);
    stuck = Math.max(stuck, car.stuckTime);
    if (car.stuckTime > 0.9) return { fail: 'stuck at ' + car.pos.x.toFixed(0) + ',' + car.pos.z.toFixed(0) + ' after ' + t.toFixed(1) + ' s' };
    if (under > 0.5) return { fail: 'under the road at ' + car.pos.x.toFixed(0) + ',' + car.pos.z.toFixed(0) };
    if (insideBuilding(car.pos.x, car.pos.z)) return { fail: 'inside a building at ' + car.pos.x.toFixed(0) + ',' + car.pos.z.toFixed(0) };
  }
  if (idx < end) return { fail: 'did not get along it (reached ' + Math.round(100 * idx / Math.max(end, 1)) + '%)', top };
  return { ok: true, t, top, maxSink };
}
{
  let n = 0, top = 0, time = 0;
  const list = quick ? city.edges.filter((E, i) => i % 6 === 0) : city.edges;
  for (const E of list) {
    if (E.len < 40) continue;
    for (const rev of (E.one ? [false] : [false, true])) {
      for (const cap of quick ? [30] : [18, 45]) {
        const r = driveEdge(E, rev, cap);
        n++;
        if (r.fail) fail((E.name || 'street') + ' #' + E.i + (rev ? ' (back)' : '') + ' at ' + cap + ' m/s: ' + r.fail);
        else { top = Math.max(top, r.top); time += r.t; }
      }
    }
  }
  console.log('driven:', n, 'runs, top speed', top.toFixed(1), 'm/s, total', time.toFixed(0), 's of driving');
}

/* 5. walls hold */
{
  let n = 0, through = 0;
  const pick = city.buildings.filter((b, i) => i % (quick ? 60 : 12) === 0);
  for (const b of pick) {
    const P = b.P;
    // the longest wall, hit square on from 25 m out
    let bi = 0, bl = 0;
    for (let i = 0; i < P.length; i++) { const q = P[(i + 1) % P.length], L = Math.hypot(q.x - P[i].x, q.z - P[i].z); if (L > bl) { bl = L; bi = i; } }
    const a = P[bi], q = P[(bi + 1) % P.length], mx = (a.x + q.x) / 2, mz = (a.z + q.z) / 2;
    let nx = (q.z - a.z) / bl, nz = -(q.x - a.x) / bl;
    if (insideBuilding(mx + nx * 0.5, mz + nz * 0.5)) { nx = -nx; nz = -nz; }
    const sx = mx + nx * 25, sz = mz + nz * 25;
    if (insideBuilding(sx, sz) || city.buildings.some((o) => o !== b && o.P.some((p) => Math.hypot(p.x - (mx + nx * 12), p.z - (mz + nz * 12)) < 14))) continue;
    for (const v0 of [15, 45]) {
      const car = new m.Vehicle(null);
      car.place(new THREE.Vector3(sx, city.Hs(sx, sz) + 0.2 + m.CAR.comHeight, sz), Math.atan2(-nx, -nz));
      car.vel.set(-nx * v0, 0, -nz * v0);
      let inside = false;
      for (let t = 0; t < 3 && !inside; t += H) {
        if (!car.step(H, world, { throttle: 1, brake: 0, steer: 0, handbrake: 0, boost: 0 })) break;
        if (insideBuilding(car.pos.x, car.pos.z)) inside = true;
      }
      n++;
      if (inside) { through++; if (through < 6) console.log('  through a wall: building', b.i, b.k, 'at', mx.toFixed(0), mz.toFixed(0), 'from', v0, 'm/s'); }
    }
  }
  console.log('walls:', n, 'head-on hits,', through, 'got inside');
  if (through) fail(through + ' head-on hits ended inside a building');
}
/* 6. nothing that would flicker: two faces of different colour, facing the
      same way, in the same plane (within 3 cm) and overlapping. Buildings,
      trees and street furniture; the flat layers are kept apart by design
      (2 above). */
{
  const vis = kit.build(globalThis.CityData.eugene, { detail: 2 });
  let found = 0, tested = 0;
  const shown = [];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  /** do two triangles in one plane overlap by more than a sliver? (separating axes, each shrunk a little) */
  const overlap = (A, B, n) => {
    const shrink = (T2) => { const c = [0, 1, 2].map((k) => (T2[0][k] + T2[1][k] + T2[2][k]) / 3); return T2.map((p) => p.map((v, k) => c[k] + (v - c[k]) * 0.9)); };
    const P = shrink(A), Q = shrink(B);
    for (const T2 of [P, Q]) for (let i = 0; i < 3; i++) {
      const e = sub(T2[(i + 1) % 3], T2[i]), ax = cross(n, e);
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const p of P) { const d = dot(p, ax); a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
      for (const p of Q) { const d = dot(p, ax); b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
      if (a1 <= b0 + 1e-6 || b1 <= a0 + 1e-6) return false;
    }
    return true;
  };
  vis.root.traverse((mesh) => {
    if (!mesh.isMesh || mesh.userData.group !== 'bld' || !mesh.geometry.attributes.uv) return;      // (the near buildings: the far shells are never drawn with them)
    const pos = mesh.geometry.attributes.position.array, col = mesh.geometry.attributes.color.array, uv = mesh.geometry.attributes.uv.array;
    // (measured from the chunk's own middle: from the map's origin, a face 700 m out has its plane wrong by centimetres)
    const C0 = mesh.geometry.boundingSphere.center, O3 = [C0.x, C0.y, C0.z];
    const buckets = new Map();
    for (let i = 0; i < pos.length; i += 9) {
      const A = [[pos[i], pos[i + 1], pos[i + 2]], [pos[i + 3], pos[i + 4], pos[i + 5]], [pos[i + 6], pos[i + 7], pos[i + 8]]].map((p) => sub(p, O3));
      let n = cross(sub(A[1], A[0]), sub(A[2], A[0]));
      const l = Math.hypot(n[0], n[1], n[2]);
      if (l < 0.04) continue;
      n = n.map((v) => v / l);
      const d = dot(n, A[0]);
      const t = { A, n, d, c: [col[i], col[i + 1], col[i + 2]], row: Math.floor((1 - uv[i / 9 * 6 + 1]) * 16) };
      const kn = Math.round(n[0] * 12) + ',' + Math.round(n[1] * 12) + ',' + Math.round(n[2] * 12) + ':', kd = Math.floor(d / 0.3);
      for (const k of [kd, kd + 1]) { const key = kn + k; (buckets.get(key) || buckets.set(key, []).get(key)).push(t); }
    }
    const seen = new Set();
    for (const list of buckets.values()) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (dot(a.n, b.n) < 0.9995) continue;
        const cb = [0, 1, 2].map((k) => (b.A[0][k] + b.A[1][k] + b.A[2][k]) / 3);
        if (Math.abs(dot(a.n, sub(cb, a.A[0]))) > 0.03) continue;
        const same = Math.abs(a.c[0] - b.c[0]) + Math.abs(a.c[1] - b.c[1]) + Math.abs(a.c[2] - b.c[2]) < 0.012 && (a.row === b.row || (a.row !== 1 && b.row !== 1 && a.row !== 3 && b.row !== 3 && a.row !== 4 && b.row !== 4 && a.row < 6));
        if (same) continue;
        const id = a.A[0].join() + '|' + b.A[0].join() + '|' + b.A[1].join();
        if (seen.has(id)) continue;
        seen.add(id);
        tested++;
        if (!overlap(a.A, b.A, a.n)) continue;
        found++;
        if (shown.length < 12) shown.push('  at ' + a.A[0].map((v, k) => (v + O3[k]).toFixed(1)).join(', ') + ' facing ' + a.n.map((v) => v.toFixed(2)).join(', ') + ' rows ' + a.row + '/' + b.row + ' heights ' + a.A.map((p) => (p[1] + O3[1]).toFixed(2)).join(' ') + ' / ' + b.A.map((p) => (p[1] + O3[1]).toFixed(2)).join(' '));
      }
    }
  });
  console.log('flicker: ' + found + ' pairs of differently coloured faces in one plane (of ' + tested + ' candidates)');
  for (const s of shown) console.log(s);
  if (found > 0) fail(found + ' places would flicker');
}
console.log(bad ? bad + ' FAILED' : 'city ok', '(' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
process.exit(bad ? 1 : 0);
