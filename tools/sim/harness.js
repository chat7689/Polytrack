// Headless physics harness: pulls the real physics world, vehicle, track
// builder, buildCourse and LEVELS straight out of index.html and runs them
// under Node with the same three.js build the game loads (r128).
const fs = require('fs');
const path = require('path');
const THREE = require('three');

const SRC = process.env.SRC || 'C:/Users/malon/skyframe/index.html';

function load() {
  const src = fs.readFileSync(SRC, 'utf8');
  const a = src.indexOf('/* --------------------------------------------- 4. physics world');
  const b = src.indexOf('/* --------------------------------------------------------- 9. chase camera');
  if (a < 0 || b < 0) throw new Error('markers not found');
  const chunk = src.slice(a, b);
  const utils = `
    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
    const lerp = (a, b, t) => a + (b - a) * t;
    const approach = (rate, dt) => 1 - Math.exp(-rate * dt);
    const deg = (d) => (d * Math.PI) / 180;
    const sign = (v) => (v < 0 ? -1 : 1);
  `;
  const exportsList = ['Vehicle', 'PhysicsWorld', 'buildCourse', 'LEVELS', 'validateCourse', 'CAR',
    'GROUND_Y', 'buildMaterials', 'buildGeometry', 'TrackBuilder', 'MAT', 'GEO'];
  const extra = ['SECTIONS', 'courseCenterAndExtent', 'layoutBackdropPeaks', 'densePath', 'DailyGen', 'courseCheckpoints', 'passesCheckpoint', 'NEXT_LEVELS', 'TrackKit'];
  const ret = 'return {' + exportsList.join(',') + ',' +
    extra.map((k) => k + ': (typeof ' + k + " !== 'undefined' ? " + k + ' : undefined)').join(',') + '};';
  const fn = new Function('THREE', utils + chunk + '\n' + ret);
  const mod = fn(THREE);
  mod.buildMaterials();
  mod.buildGeometry();
  return mod;
}

/** Dense centreline from every strip frame (plus gap jumps between strips). */
function centreline(data) {
  const pts = [];
  for (const st of data.strips) for (const f of st.frames) pts.push(new THREE.Vector3(f.p[0], f.p[1], f.p[2]));
  return pts;
}

/**
 * Simple autopilot: pure-pursuit on the dense centreline with a speed plan
 * from the curvature ahead. Returns stats for the run.
 */
function drive(mod, lvIndex, opts) {
  opts = opts || {};
  const lv = mod.LEVELS[lvIndex];
  const data = mod.validateCourse(lv.build());
  const world = new mod.PhysicsWorld();
  const scene = new THREE.Scene();
  const course = mod.buildCourse(data, scene, world);
  const car = new mod.Vehicle(null);
  const s = data.start;
  const startPos = new THREE.Vector3(s.pos[0], s.pos[1] + mod.CAR.comHeight + 0.05, s.pos[2]);
  car.place(startPos, s.heading);
  const line = centreline(data);
  const gate = course.gates.find((g) => g.kind === 'finish');
  const H = 1 / 360;
  let t = 0, idx = 0;
  const stats = { name: lv.name, finished: false, time: 0, maxSlip: 0, spinTime: 0, offTrack: 0,
    maxHull: 0, maxSpeed: 0, restarts: 0, maxYawErr: 0, avgSpeed: 0, steps: 0, grassTime: 0 };
  let offTrack = 0, spd = 0;
  const maxT = opts.maxT || 240;
  const aggr = opts.aggr === undefined ? 1 : opts.aggr;
  const tmp = new THREE.Vector3();
  while (t < maxT) {
    // nearest centreline index (monotone-ish window)
    let best = idx, bd = Infinity;
    for (let k = Math.max(0, idx - 5); k < Math.min(line.length, idx + 40); k++) {
      const d = line[k].distanceToSquared(car.pos);
      if (d < bd) { bd = d; best = k; }
    }
    idx = best;
    const v = car.speed;
    const look = Math.max(4, Math.round((6 + v * 0.45) / 3.2));
    const tgt = line[Math.min(line.length - 1, idx + look)];
    tmp.subVectors(tgt, car.pos);
    const want = Math.atan2(tmp.x, tmp.z);
    let err = want - car.heading;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    // curvature ahead: heading change over next ~60m
    let turn = 0;
    const far = Math.min(line.length - 2, idx + 20);
    for (let k = idx; k < far; k++) {
      const a1 = Math.atan2(line[k + 1].x - line[k].x, line[k + 1].z - line[k].z);
      const a0 = k > 0 ? Math.atan2(line[k].x - line[k - 1].x, line[k].z - line[k - 1].z) : a1;
      let d = a1 - a0; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      turn += Math.abs(d);
    }
    const vTarget = (opts.flatOut ? 999 : (70 - turn * 38 * (1 / aggr)));
    const input = {
      throttle: v < vTarget ? 1 : 0,
      brake: v > vTarget + 6 ? 1 : 0,
      steer: clampN(-err * 2.2, -1, 1),
      handbrake: 0,
      boost: opts.boost ? 1 : 0
    };
    if (!car.step(H, world, input)) { stats.nonFinite = true; break; }
    t += H; stats.steps++;
    spd += v * H;
    stats.maxSpeed = Math.max(stats.maxSpeed, v);
    stats.maxSlip = Math.max(stats.maxSlip, car.slipMax);
    stats.maxHull = Math.max(stats.maxHull, car.hullDepth);
    // slip angle between heading and velocity, grounded, at speed
    if (car.grounded && v > 8) {
      const va = Math.atan2(car.vel.x, car.vel.z);
      let ya = va - car.heading; while (ya > Math.PI) ya -= 2 * Math.PI; while (ya < -Math.PI) ya += 2 * Math.PI;
      stats.maxYawErr = Math.max(stats.maxYawErr, Math.abs(ya));
      if (Math.abs(ya) > 0.35) stats.spinTime += H;
    }
    const onDeck = car.wheels.some((w) => w.contact && w.onTrack);
    const onGrass = car.wheels.some((w) => w.contact && !w.onTrack);
    if (onGrass) stats.grassTime += H;
    if (!car.grounded || onDeck) offTrack = 0; else offTrack += H;
    stats.offTrack = Math.max(stats.offTrack, offTrack);
    if (offTrack > 4 || car.stuckTime > 0.9 || car.pos.y < mod.GROUND_Y - 8) {
      stats.restarts++;
      stats.failReason = offTrack > 4 ? 'offtrack' : car.stuckTime > 0.9 ? 'stuck' : 'fell';
      stats.failAt = { t: +t.toFixed(1), idx, of: line.length, pos: car.pos.toArray().map((q) => +q.toFixed(1)) };
      break;
    }
    // finish check (same as game minus the 55% gate)
    if (gate && idx > line.length * 0.5 && car.pos.distanceToSquared(gate.pos) < gate.radius * gate.radius
      && Math.abs(car.pos.y - gate.pos.y) < 7) {
      stats.finished = true; stats.time = t; break;
    }
  }
  stats.avgSpeed = spd / Math.max(t, 1e-6);
  if (!stats.finished) stats.time = t;
  stats.progress = idx / line.length;
  return stats;
}
function clampN(v, a, b) { return v < a ? a : v > b ? b : v; }

module.exports = { load, drive, centreline, THREE };

if (require.main === module) {
  const mod = load();
  const only = process.argv[2] ? process.argv[2].split(',').map(Number) : null;
  const rows = [];
  mod.LEVELS.forEach((lv, i) => {
    if (only && !only.includes(i)) return;
    const st = drive(mod, i, { aggr: +(process.env.AGGR || 1) });
    rows.push(st);
    console.log(String(i).padStart(2), st.name.padEnd(20),
      st.finished ? 'FIN ' + st.time.toFixed(2) + 's' : 'DNF(' + (st.failReason || 'timeout') + ' @' + (st.progress * 100).toFixed(0) + '%)',
      'vmax', st.maxSpeed.toFixed(1), 'avg', st.avgSpeed.toFixed(1),
      'slip', st.maxSlip.toFixed(2), 'yawErr', (st.maxYawErr * 57.3).toFixed(0) + 'deg',
      'spin', st.spinTime.toFixed(2), 'hull', st.maxHull.toFixed(3), 'grass', st.grassTime.toFixed(1));
  });
}
