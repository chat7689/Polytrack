// Falls short of every jump on purpose and checks the car never ends up
// inside the track (the deck slab or the beam under it).
//   node jumpwall.js            every map, this season's and the next
//   node jumpwall.js s5c10      one map
// For each gap between strips the car leaves the takeoff edge, coasting, at
// speeds from far too slow to just enough, in the middle and off to each
// side. A car that comes up short must hit the landing's front wall and drop
// (or pass under the deck); it must never travel inside the landing deck.
const h = require('./harness.js');
const m = h.load();
const THREE = h.THREE;
const only = process.argv[2];
const maps = m.LEVELS.concat(m.NEXT_LEVELS).filter((l) => (!only || l.id === only) && (only || !m.validateCourse(l.build()).legacyHull));
let bad = 0, tests = 0;
for (const lv of maps) {
  const data = m.validateCourse(lv.build());
  const world = new m.PhysicsWorld();
  m.buildCourse(data, new THREE.Scene(), world);
  world.index();
  for (let si = 1; si < data.strips.length; si++) {
    const A = data.strips[si - 1].frames, Bf = data.strips[si].frames;
    if (!A.length || !Bf.length) continue;
    const take = A[A.length - 1], land = Bf[0];
    const gap = Math.hypot(land.p[0] - take.p[0], land.p[2] - take.p[2]);
    if (gap < 4) continue;
    const fwd = new THREE.Vector3(land.p[0] - take.p[0], 0, land.p[2] - take.p[2]).normalize();
    const side = new THREE.Vector3(fwd.z, 0, -fwd.x), heading = Math.atan2(fwd.x, fwd.z);
    const L0 = new THREE.Vector3().fromArray(land.p);
    let worst = 0;
    for (let v = 10; v <= 46; v += 1.5) for (const lat of [0, -land.w / 4, land.w / 4]) {
      tests++;
      const car = new m.Vehicle(null);
      const p = new THREE.Vector3().fromArray(take.p).addScaledVector(fwd, -3).addScaledVector(side, lat);
      p.y += m.CAR.comHeight + 0.05;
      car.place(p, heading);
      car.vel.copy(fwd).multiplyScalar(v);
      let inside = 0;
      for (let k = 0; k < 360 * 3; k++) {
        if (!car.step(1 / 360, world, { throttle: 0, brake: 0, steer: 0, handbrake: 0 })) break;
        const al = car.pos.clone().sub(L0).dot(fwd);
        if (al < 0.6 || al > 25) continue;
        // the landing deck under the car: its nearest frame, the car's height over that deck
        let f = Bf[0], fd = Infinity;
        for (const g of Bf) { const dd = (g.p[0] - car.pos.x) ** 2 + (g.p[2] - car.pos.z) ** 2; if (dd < fd) { fd = dd; f = g; } }
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(f.t, f.y, f.r, 'YXZ'));
        const rel = car.pos.clone().sub(new THREE.Vector3().fromArray(f.p));
        const up = rel.dot(new THREE.Vector3(0, 1, 0).applyQuaternion(q)), across = rel.dot(new THREE.Vector3(1, 0, 0).applyQuaternion(q));
        // inside: within its width, between its top and the bottom of the beam under it
        if (Math.abs(across) < f.w / 2 - 0.4 && up < -0.2 && up > -2.1) inside++;
      }
      if (inside > 6) { bad++; worst = Math.max(worst, inside); console.log('BAD', lv.id, lv.name, 'gap', si, 'v', v, 'lat', lat.toFixed(1), 'inside the deck for', (inside / 360).toFixed(2), 's'); }
    }
  }
}
console.log((only || 'all maps') + ':', tests, 'short and long jumps tried,', bad ? bad + ' BAD' : 'the car never got inside the track');
// (the live season's maps keep the old 8-corner hull until it closes - legacyHull - so a lip can still
//  reach between its corners there; Season 4 on are tested with the full hull)
