// Run in the browser (pasted into the page of a test copy that exposes T):
// finds faces that would flicker (two surfaces facing the same way in the
// same place: z-fighting), pieces built inside out, and faces lying on the
// ground plane, in a map's scenery.  ZF.scan(k) for preview map k (0..15).
window.ZF = {
  pieces(k) {
    const L = T.Landmarks, om = L.merge, lists = [];
    L.merge = function (list) { const g = om.call(this, list); lists.push({ list, g }); return g; };
    try { T.Preview.ensure(k); T.Game.loadLevel(T.Preview.index(k), true); } finally { L.merge = om; }
    const byGeo = new Map();
    T.Game.course.root.traverse((m) => { if (m.isMesh) byGeo.set(m.geometry, m.material); });
    const keyOf = new Map(Object.entries(L._geo).map(([k2, v]) => [v, k2]));
    const out = [];
    for (const { list, g } of lists) {
      const mat = byGeo.get(g), name = Object.keys(L.mats).find((n) => L.mats[n] === mat) || '?';
      for (const [geo, mtx] of list) out.push({ geo, mtx, mat: name, textured: !!(mat && mat.map), key: keyOf.get(geo) || 'custom' });
    }
    return out;
  },
  scan(k, opts) {
    opts = opts || {};
    const P = this.pieces(k), GY = T.App.floor.position.y;
    const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
    const tris = [], inside = [], floor = [];
    const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
    P.forEach((pc, pid) => {
      const pos = pc.geo.attributes.position, idx = pc.geo.index, cnt = idx ? idx.count : pos.count;
      let vol = 0;
      for (let i = 0; i < cnt; i += 3) {
        const a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, c = idx ? idx.getX(i + 2) : i + 2;
        vA.fromBufferAttribute(pos, a).applyMatrix4(pc.mtx); vB.fromBufferAttribute(pos, b).applyMatrix4(pc.mtx); vC.fromBufferAttribute(pos, c).applyMatrix4(pc.mtx);
        e1.subVectors(vB, vA); e2.subVectors(vC, vA); n.crossVectors(e1, e2);
        const area = n.length() / 2;
        vol += vA.dot(new THREE.Vector3().crossVectors(vB, vC)) / 6;
        if (area < 0.02) continue;
        n.normalize();
        const t = { pid, mat: pc.mat, key: pc.key, n: n.clone(), d: n.dot(vA), p: [vA.clone(), vB.clone(), vC.clone()], area };
        tris.push(t);
        if (n.y > 0.99 && Math.abs(vA.y - GY) < 0.03 && Math.abs(vB.y - GY) < 0.03 && Math.abs(vC.y - GY) < 0.03) floor.push(pc.mat + '/' + pc.key + '@' + vA.toArray().map(Math.round).join(','));
      }
      if (vol < -0.01 && !/^arc|^hemi|custom/.test(pc.key)) inside.push(pc.mat + '/' + pc.key + ' vol ' + vol.toFixed(1));
    });
    // bucket by plane
    const B = new Map(), q = (x) => Math.round(x * 40);
    for (const t of tris) {
      const k1 = q(t.n.x) + ',' + q(t.n.y) + ',' + q(t.n.z) + ':' + Math.round(t.d / 0.04);
      (B.get(k1) || B.set(k1, []).get(k1)).push(t);
    }
    // boxes of every piece, to tell a face covered by another piece (hidden) from one in the open
    const boxes = P.map((pc) => { if (!pc.geo.boundingBox) pc.geo.computeBoundingBox(); return { bb: pc.geo.boundingBox, inv: new THREE.Matrix4().copy(pc.mtx).invert() }; });
    const hidden = (t) => {
      const cen = new THREE.Vector3().add(t.p[0]).add(t.p[1]).add(t.p[2]).multiplyScalar(1 / 3);
      if (t.n.y < -0.9 && cen.y < GY + 0.1) return true;
      const probe = cen.clone().addScaledVector(t.n, 0.05), lp = new THREE.Vector3();
      for (let i = 0; i < boxes.length; i++) {
        if (i === t.pid) continue;
        lp.copy(probe).applyMatrix4(boxes[i].inv);
        const bb = boxes[i].bb;
        if (lp.x > bb.min.x && lp.x < bb.max.x && lp.y > bb.min.y && lp.y < bb.max.y && lp.z > bb.min.z && lp.z < bb.max.z && /box|fac/.test(P[i].key)) return true;
      }
      return false;
    };
    const hits = new Map();
    const proj = (t, u, w) => t.p.map((p) => [p.dot(u), p.dot(w)]);
    const sep = (A, Bp) => {
      for (const S of [A, Bp]) for (let i = 0; i < 3; i++) {
        const a = S[i], b = S[(i + 1) % 3], nx = -(b[1] - a[1]), ny = b[0] - a[0], L = Math.hypot(nx, ny) || 1;
        let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
        for (const p of A) { const v = (p[0] * nx + p[1] * ny) / L; a0 = Math.min(a0, v); a1 = Math.max(a1, v); }
        for (const p of Bp) { const v = (p[0] * nx + p[1] * ny) / L; b0 = Math.min(b0, v); b1 = Math.max(b1, v); }
        if (a1 < b0 + 0.05 || b1 < a0 + 0.05) return true;
      }
      return false;
    };
    for (const [key, list] of B) {
      const [nk, dk] = key.split(':');
      const near = list.concat(B.get(nk + ':' + (+dk + 1)) || []);
      for (let i = 0; i < list.length; i++) for (let j = 0; j < near.length; j++) {
        const a = list[i], b = near[j];
        if (a === b || a.pid === b.pid || Math.abs(a.d - b.d) > 0.03 || a.n.dot(b.n) < 0.999) continue;
        if (a.mat === b.mat && !P[a.pid].textured) continue;     // one plain colour: nothing to see
        if (opts.diffMat && a.mat === b.mat) continue;
        const u = new THREE.Vector3(1, 0, 0); if (Math.abs(a.n.x) > 0.9) u.set(0, 1, 0);
        u.addScaledVector(a.n, -u.dot(a.n)).normalize(); const w = new THREE.Vector3().crossVectors(a.n, u);
        if (sep(proj(a, u, w), proj(b, u, w))) continue;
        if (hidden(a) || hidden(b)) continue;
        const id = [a.mat + '/' + a.key, b.mat + '/' + b.key].sort().join(' x ');
        const h = hits.get(id) || { n: 0, at: a.p[0].toArray().map(Math.round).join(',') };
        h.n++; hits.set(id, h);
      }
    }
    return { id: T.levelAt(T.Preview.index(k)).id, pieces: P.length, z: [...hits].map(([k2, v]) => k2 + ' (' + v.n + ') @' + v.at), inside, floor: floor.slice(0, 5) };
  }
};
