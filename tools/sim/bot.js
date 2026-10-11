// A better test driver: follows the road's own frames (so loops, banks and
// jumps are just more road), plans its speed from how tight the road turns
// ahead and how hard it can brake, boosts on long straights, and records a
// 20 Hz ghost plus the numbers that show whether a map drives well.
const h = require('./harness.js');
const THREE = h.THREE;

function frameList(data) {
  const out = [];
  const q = new THREE.Quaternion(), e = new THREE.Euler();
  let cum = 0, prev = null;
  data.strips.forEach((st, si) => st.frames.forEach((f, fi) => {
    const p = new THREE.Vector3().fromArray(f.p);
    if (prev) cum += p.distanceTo(prev);
    prev = p;
    q.setFromEuler(e.set(f.t, f.y, f.r, 'YXZ'));
    out.push({ p, fwd: new THREE.Vector3(0, 0, 1).applyQuaternion(q), up: new THREE.Vector3(0, 1, 0).applyQuaternion(q), x: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
      yaw: f.y, w: f.w, cum, strip: si, first: fi === 0, last: fi === st.frames.length - 1, r: f.r });
  }));
  return out;
}

// the tightest radius the steering allows at speed v (Vehicle.step's lock)
function rMin(m, v) {
  const C = m.CAR;
  const s = Math.min(C.maxSteer + (C.minSteer - C.maxSteer) * Math.min(Math.max(v / C.steerRef, 0), 1), C.steerK / Math.pow(Math.max(v, 1), C.steerP));
  return (C.wheelZ * 2) / Math.tan(s);
}
function vFor(m, R) {
  let lo = 3, hi = 90;
  for (let k = 0; k < 30; k++) { const mid = (lo + hi) / 2; if (rMin(m, mid) <= R) lo = mid; else hi = mid; }
  return lo;
}

function run(m, data, opts) {
  opts = opts || {};
  const aggr = opts.aggr || 1;
  const world = new m.PhysicsWorld();
  const course = m.buildCourse(data, new THREE.Scene(), world);
  const F = frameList(data);
  // allowed speed at each frame from the turn it sits in (plan view curvature)
  const vAllow = F.map((f, i) => {
    let tight = Infinity;
    for (let k = Math.max(0, i - 2); k < Math.min(F.length - 1, i + 3); k++) {
      if (F[k].last) continue;
      let dy = F[k + 1].yaw - F[k].yaw; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
      const ds = Math.hypot(F[k + 1].p.x - F[k].p.x, F[k + 1].p.z - F[k].p.z);
      if (Math.abs(dy) > 1e-4 && ds > 0.2) tight = Math.min(tight, ds / Math.abs(dy));
    }
    if (!isFinite(tight)) return 99;
    // a banked turn holds more speed
    const bank = Math.min(Math.abs(f.r), 1.3);
    return vFor(m, tight) * (1 + 0.9 * Math.sin(bank)) * (tight < 40 ? 0.95 : 0.85 + 0.15 * aggr);
  });
  const car = new m.Vehicle(null);
  const s = data.start;
  car.place(new THREE.Vector3(s.pos[0], s.pos[1] + m.CAR.comHeight + 0.05, s.pos[2]), s.heading);
  const gate = course.gates.find((g) => g.kind === 'finish');
  const cps = course.cps || [];
  let cpNext = 0, cpMiss = 0, cpSingles = 0;
  const H = 1 / 360, HZ = 20;
  let t = 0, idx = 0;
  const rec = [[car.pos.x, car.pos.y, car.pos.z, 0]];
  const st = { finished: false, time: 0, fail: '', top: 0, wheelsUp: 0, maxRollRate: 0, scrape: 0, grass: 0, air: 0, maxG: 0, offTrack: 0,
    minLoopV: 99, maxCompG: 0, pops: 0, popV: 0, popAt: '', _wasG: true, spins: 0, brakeTime: 0, hbTime: 0, driftTime: 0, at: null };
  let off = 0, prevUp = car.up.clone();
  const tmp = new THREE.Vector3(), loc = new THREE.Vector3();
  const BRAKE = 13.5 * (0.85 + 0.15 * aggr);
  while (t < (opts.maxT || 150)) {
    // where on the road: nearest frame, searched forward
    let best = idx, bd = Infinity;
    for (let k = Math.max(0, idx - 6); k < Math.min(F.length, idx + 40); k++) {
      const d = F[k].p.distanceToSquared(car.pos);
      if (d < bd) { bd = d; best = k; }
    }
    idx = best;
    const v = car.speed;
    // target ahead along the road
    const L = 7 + v * 0.42;
    let j = idx;
    while (j < F.length - 1 && F[j].cum - F[idx].cum < L) j++;
    tmp.copy(F[j].p).addScaledVector(F[j].x, (opts.lane || 0) * F[j].w / 2 * (opts.laneWave ? Math.sin(F[j].cum / 40) : 1)).sub(car.pos);
    // into the car's own frame
    car.up.set(0, 1, 0).applyQuaternion(car.quat);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(car.quat), left = new THREE.Vector3(1, 0, 0).applyQuaternion(car.quat);
    const ang = Math.atan2(tmp.dot(left), tmp.dot(fwd));
    // speed plan: the lowest allowed speed ahead, reachable with the brakes
    let want = 99;
    for (let k = idx; k < F.length && F[k].cum - F[idx].cum < 180; k++) {
      const d = Math.max(0, F[k].cum - F[idx].cum - 4);
      const dec = Math.max(6, BRAKE + 13.5 * Math.min(0, F[k].fwd.y));
      want = Math.min(want, Math.sqrt(vAllow[k] * vAllow[k] + 2 * dec * d));
    }
    // a loop or a jump wants everything the car has
    const loopy = Math.abs(F[idx].fwd.y) > 0.25 || F[idx].up.y < 0.5;
    // a gap ahead (this strip ends): hold the speed up for the take-off
    let jumpAhead = false;
    for (let k = idx; k < F.length - 1 && F[k].cum - F[idx].cum < 70; k++) if (F[k].last) { jumpAhead = vAllow[k] > 30; break; }
    if (jumpAhead) want = Math.max(want, opts.jumpV || 40);
    if (opts.vmax) want = Math.min(want, opts.vmax);
    if (opts.vbank) { for (let k = idx; k < F.length && F[k].cum - F[idx].cum < 40; k++) if (Math.abs(F[k].r) > 0.35) { want = Math.min(want, opts.vbank); break; } }
    let straightAhead = true;
    for (let k = idx; k < F.length && F[k].cum - F[idx].cum < 140; k++) if (vAllow[k] < 60) { straightAhead = false; break; }
    const tight = vAllow[Math.min(F.length - 1, idx + 3)] < 22 && v > 14;
    // in the air: level the nose with the road it will land on
    let air = 0;
    if (!car.grounded) {
      let k = idx; while (k < F.length - 1 && !F[k].first && F[k].cum - F[idx].cum < 5) k++;
      let target = 0;
      for (let q = idx + 1; q < F.length; q++) if (F[q].first) { target = F[Math.min(F.length - 1, q + 2)].fwd.y; break; }
      const diff = fwd.y - target;
      air = diff > 0.06 ? 1 : diff < -0.06 ? -1 : 0;
    }
    const input = {
      throttle: !car.grounded ? (air > 0 ? 1 : 0) : (loopy || v < want - 0.5 ? 1 : 0),
      brake: !car.grounded ? (air < 0 ? 1 : 0) : (!loopy && v > want + 2 ? 1 : 0),
      steer: Math.max(-1, Math.min(1, -ang * 2.4)),
      handbrake: opts.handbrake && tight && Math.abs(ang) > 0.35 ? 1 : 0,
      boost: (opts.boost && straightAhead && v > 18) || (loopy && opts.boost) ? 1 : 0
    };
    if (input.brake) st.brakeTime += H;
    if (input.handbrake) st.hbTime += H;
    if (!car.step(H, world, input)) { st.fail = 'nan'; break; }
    t += H;
    if (Math.floor(t * HZ) + 1 > rec.length) rec.push([car.pos.x, car.pos.y, car.pos.z].concat(opts.full ? [car.quat.x, car.quat.y, car.quat.z, car.quat.w] : []).concat([(input.throttle ? 1 : 0) | (input.brake ? 2 : 0) | (input.steer < -0.05 ? 4 : 0) | (input.steer > 0.05 ? 8 : 0) | (car.boosting ? 16 : 0) | (input.handbrake ? 32 : 0)]));
    // numbers
    st.top = Math.max(st.top, v);
    {
      const fr = F[idx];
      let gapNear = false;
      for (let k = Math.max(0, idx - 4); k < Math.min(F.length, idx + 10); k++) if (F[k].last || F[k].first) { gapNear = k !== 0; }
      const vn = car.vel.dot(fr.up);
      if (Math.abs(fr.r) > 0.35 && !gapNear) {
        if (vn > st.popV) { st.popV = vn; st.popAt = Math.round(fr.cum) + 'm bank' + Math.round(Math.abs(fr.r) * 57) + ' v' + v.toFixed(0); }
        if (!car.grounded && st._wasG) { st.pops++; }
      }
      st._wasG = car.grounded;
    }
    if ((car.drift || 0) > 0.5) st.driftTime += H;
    const onDeck = car.wheels.some((w) => w.contact && w.onTrack);
    const onGrass = car.wheels.some((w) => w.contact && !w.onTrack);
    if (!car.grounded) st.air += H; else if (!onDeck) st.grass += H;
    if (car.grounded && car.wheels.filter((w) => !w.contact).length >= 2 && v > 5) st.wheelsUp += H;
    const upNow = new THREE.Vector3(0, 1, 0).applyQuaternion(car.quat);
    const rr = Math.acos(Math.min(1, Math.max(-1, upNow.dot(prevUp)))) / H;
    prevUp.copy(upNow);
    if (car.grounded) st.maxRollRate = Math.max(st.maxRollRate, rr);
    if ((car.hullDepth || 0) > st.scrape) { st.scrape = car.hullDepth; st.scrapeT = t; st.scrapeAt = Math.round(F[idx].cum) + 'm v' + v.toFixed(0) + ' y' + car.pos.y.toFixed(1) + (car.grounded ? '' : ' air'); }
    let comp = 0; for (const w of car.wheels) comp += Math.max(w.load || 0, 0);
    st.maxCompG = Math.max(st.maxCompG, comp / (m.CAR.mass * m.CAR.gravity));
    if (loopy && upNow.y < -0.5) st.minLoopV = Math.min(st.minLoopV, v);
    if (onDeck || !car.grounded) off = 0; else off += H;
    st.offTrack = Math.max(st.offTrack, off);
    if (car.slipAngle > 0.9 && v > 8) st.spins++;
    for (let g2 = 0; g2 < 4 && cpNext < cps.length; g2++) {
      if (m.passesCheckpoint(cps[cpNext], car.pos)) { cpNext++; cpMiss = 0; continue; }
      if (cps[cpNext + 1] && cpMiss === 0 && m.passesCheckpoint(cps[cpNext + 1], car.pos)) { cpNext += 2; cpMiss = 1; cpSingles++; continue; }
      break;
    }
    if (opts.trace && Math.floor(t * (opts.fine || 4)) !== Math.floor((t - H) * (opts.fine || 4))) opts.trace.push([+t.toFixed(2), Math.round(F[idx].cum), +v.toFixed(1), +car.pos.y.toFixed(1), car.grounded ? 'g' : 'air', +fwd.y.toFixed(2), car.stuckTime.toFixed(2), (car.hullDepth||0).toFixed(2), input.throttle + '' + input.brake, onGrass && !onDeck ? 'GRASS' : '', (car.slipAngle||0).toFixed(2), +F[idx].r.toFixed(2), 'lat ' + (car.pos.clone().sub(F[idx].p).dot(F[idx].x) / (F[idx].w / 2)).toFixed(2), 'n ' + car.pos.clone().sub(F[idx].p).dot(F[idx].up).toFixed(2), 'c' + car.wheels.filter((w) => w.contact).length, 'gR ' + (car.groundRoll||0).toFixed(2), 'wR ' + car.omega.dot(car.fwd).toFixed(2), 'lag ' + (Math.asin(Math.max(-1, Math.min(1, new THREE.Vector3().crossVectors(car.up, F[idx].up).dot(car.fwd)))) * 57).toFixed(1), 'comp ' + car.wheels.map((w) => (0.59 - w.hitDist).toFixed(2)).join('/') + ' load ' + car.wheels.map((w) => ((w.load||0)/1000).toFixed(0)).join('/') + ' df ' + ((car.downforceN||0)/1000).toFixed(1)]);
    if (off > 4) { st.fail = 'offtrack'; st.at = idx; break; }
    if (car.stuckTime > 0.9) { st.fail = 'stuck'; st.at = idx; break; }
    if (car.pos.y < m.GROUND_Y - 8) { st.fail = 'fell'; st.at = idx; break; }
    const noseOver = () => { const n = new THREE.Vector3(0, 0, 2.03).applyQuaternion(car.quat).add(car.pos); return (n.x - gate.pos.x) * gate.dir.x + (n.z - gate.pos.z) * gate.dir.z >= 0; };
    if (gate && F[idx].cum > F[F.length - 1].cum * 0.5 && (opts.full ? noseOver() && car.pos.distanceToSquared(gate.pos) < 400 : car.pos.distanceToSquared(gate.pos) < gate.radius * gate.radius) && Math.abs(car.pos.y - gate.pos.y) < 7) {
      st.finished = true; st.time = t; rec.push([car.pos.x, car.pos.y, car.pos.z, 1]);
      st.cpOk = cpNext >= cps.length - 1; st.cpSingles = cpSingles; st.cpNext = cpNext; st.cps = cps.length; break;
    }
  }
  if (!st.finished) { st.time = t; st.at = st.at === null ? idx : st.at; st.failAt = Math.round(F[st.at].cum) + 'm bank' + Math.round(Math.abs(F[st.at].r) * 57); st.progress = F[idx].cum / F[F.length - 1].cum; }
  st.length = course.length;
  st.rec = rec;
  return st;
}

module.exports = { run, frameList, rMin, vFor };
