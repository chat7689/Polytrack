// Renders views of the open-world city from a TEST COPY of the game in the
// browser (see CLAUDE.md "Test copies of the game": the copy must put City,
// Game, App, Gfx, CAR and THREE on window.T), served by tools/serve.js:
//
//   const s = document.createElement('script'); s.src = '/tools/sim/city_view.js'; document.head.appendChild(s);
//   await CV.open();                         // builds the city and starts free driving
//   await CV.at(x, z, heading, 'name.jpg');  // the chase view with the car there; saves tools/shots/name.jpg
//   await CV.shot('name.jpg', [x, y, z], [lookX, lookY, lookZ], { nofog: true, fov: 50 });
//   await CV.top('name.jpg');                // the whole map from above, north up
//   CV.breakdown();                          // draw calls and triangles by kind, for the view last drawn
//   await CV.drive(seconds, input);          // steps the real game (the pane's own frames barely run)
// Every picture comes back with the frame's draw calls and triangles.
window.CV = {
  W: 1280, H: 720,
  size(w, h) { const A = T.App; A.renderer.setPixelRatio(1); A.renderer.setSize(w, h, false); A.camera.aspect = w / h; A.camera.updateProjectionMatrix(); },
  async open() {
    await T.City.drive();
    for (let k = 0; k < 3; k++) T.Game.frame(1 / 30);
    this.size(this.W, this.H);
    return T.City.cur.stats;
  },
  async save(name, w, h) {
    const A = T.App, c2 = document.createElement('canvas');
    c2.width = w; c2.height = h;
    c2.getContext('2d').drawImage(A.renderer.domElement, 0, 0, w, h);
    const r = await fetch('/shot?name=' + name, { method: 'POST', body: c2.toDataURL('image/jpeg', 0.88) });
    return r.ok;
  },
  info() { const i = T.App.renderer.info.render; return { calls: i.calls, tris: i.triangles }; },
  place(x, z, heading) {
    const G = T.Game, c = T.City.cur;
    G.car.place(new T.THREE.Vector3(x, c.Hs(x, z) + 0.14 + T.CAR.comHeight + 0.05, z), heading);
    G.chase.snap(G.car);
    for (let k = 0; k < 20; k++) G.frame(1 / 30);
  },
  async at(x, z, heading, name) {
    this.size(this.W, this.H);
    this.place(x, z, heading);
    T.City.cull(); T.App.render();
    const out = this.info();
    if (name) out.ok = await this.save(name, this.W, this.H);
    return out;
  },
  /** on a named street: the k-th spot along it (sorted west to east, or south to north) */
  spot(re, k, byZ) { const L = T.City.cur.spots.filter((s) => re.test(s.name)).sort((a, b) => (byZ ? a.z - b.z : b.x - a.x)); return L[Math.max(0, Math.min(L.length - 1, k < 0 ? L.length + k : k))]; },
  async shot(name, pos, look, o) {
    o = o || {};
    const A = T.App, cam = A.camera, sc = A.scene, w = o.w || this.W, h = o.h || this.H;
    const keep = { near: sc.fog.near, far: sc.fog.far, cfar: cam.far, fov: cam.fov, pos: cam.position.clone(), q: cam.quaternion.clone(), up: cam.up.clone() };
    this.size(w, h);
    if (o.nofog) { sc.fog.near = 1e5; sc.fog.far = 2e5; cam.far = 6000; }
    cam.fov = o.fov || 55; cam.up.set(o.up ? o.up[0] : 0, o.up ? o.up[1] : 1, o.up ? o.up[2] : 0);
    cam.position.set(pos[0], pos[1], pos[2]); cam.lookAt(look[0], look[1], look[2]); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    T.City.cur.cull(cam.position, o.nofog ? 1e5 : sc.fog.far, o.near || (o.nofog ? 1e5 : 310));
    if (A.sky) A.sky.position.copy(cam.position);
    if (A.floor) A.floor.position.set(cam.position.x, A.floor.position.y, cam.position.z);
    if (o.light) A.aimLight(new T.THREE.Vector3(o.light[0], o.light[1], o.light[2]));
    A.renderer.render(sc, cam);
    const out = this.info();
    out.ok = await this.save(name, w, h);
    sc.fog.near = keep.near; sc.fog.far = keep.far; cam.far = keep.cfar; cam.fov = keep.fov; cam.up.copy(keep.up); cam.position.copy(keep.pos); cam.quaternion.copy(keep.q); cam.updateProjectionMatrix();
    this.size(this.W, this.H);
    return out;
  },
  top(name, o) {
    const B = T.City.cur.box, cx = (B.x0 + B.x1) / 2, cz = (B.z0 + B.z1) / 2;
    return this.shot(name, [cx, 1750, cz], [cx, 0, cz], Object.assign({ nofog: true, fov: 50, up: [0, 0, 1], w: 1400, h: 1400 }, o || {}));
  },
  /** a view down on one place: centre (x, z), from `h` up, `back` metres south of it (or along a bearing) */
  over(name, x, z, h, back, bearing) {
    const b = bearing === undefined ? Math.PI : bearing, y = T.City.cur.Hs(x, z);
    return this.shot(name, [x + Math.sin(b) * back, y + h, z + Math.cos(b) * back], [x, y, z], { nofog: true, fov: 50, light: [x, y, z] });
  },
  breakdown() {
    const A = T.App, groups = {};
    T.City.cur.root.traverse((o) => { if (o.isMesh) (groups[o.userData.group] = groups[o.userData.group] || []).push(o); });
    const all = Object.values(groups).flat(), vis = all.map((m) => m.visible), out = {};
    all.forEach((m) => { m.visible = false; });
    A.render();
    const base = this.info(); out.rest = [base.calls, base.tris];
    for (const g in groups) {
      all.forEach((m) => { m.visible = false; });
      groups[g].forEach((m) => { m.visible = vis[all.indexOf(m)]; });
      A.render();
      const i = this.info(); out[g] = [i.calls - base.calls, i.tris - base.tris];
    }
    all.forEach((m, i) => { m.visible = vis[i]; });
    return out;
  },
  /** the real game, stepped by hand: input { throttle, brake, steer, handbrake, boost } held for `sec` */
  async drive(sec, input) {
    const G = T.Game, I = T.Input, keep = { sample: I.sample };
    I.sample = function () { Object.assign(this, { throttle: 0, brake: 0, steer: 0, handbrake: 0, boost: 0 }, input || {}); this.anyDrive = true; };
    for (let t = 0; t < sec; t += 1 / 60) G.frame(1 / 60);
    I.sample = keep.sample;
    const c = G.car;
    return { pos: c.pos.toArray().map((v) => +v.toFixed(1)), speed: +c.speed.toFixed(1), heading: +c.heading.toFixed(2), state: G.state };
  }
};
