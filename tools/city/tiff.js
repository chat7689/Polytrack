// A minimal reader for the one kind of TIFF the USGS elevation service
// returns: little-endian, uncompressed, one 32-bit float per pixel, in strips
// or tiles. Returns { w, h, data: Float32Array (row 0 = north) }.
const fs = require('fs');

function readTiff(file) {
  const b = fs.readFileSync(file);
  if (b.toString('latin1', 0, 2) !== 'II' || b.readUInt16LE(2) !== 42) throw new Error('not a little-endian TIFF');
  let off = b.readUInt32LE(4);
  const n = b.readUInt16LE(off);
  const tag = {};
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8 };
  for (let i = 0; i < n; i++) {
    const e = off + 2 + i * 12;
    const id = b.readUInt16LE(e), type = b.readUInt16LE(e + 2), count = b.readUInt32LE(e + 4);
    const sz = SIZE[type] || 1;
    const at = sz * count <= 4 ? e + 8 : b.readUInt32LE(e + 8);
    const vals = [];
    for (let k = 0; k < count && k < 100000; k++) {
      const p = at + k * sz;
      vals.push(type === 3 ? b.readUInt16LE(p) : type === 4 ? b.readUInt32LE(p) : type === 11 ? b.readFloatLE(p)
        : type === 12 ? b.readDoubleLE(p) : b.readUInt8(p));
    }
    tag[id] = vals;
  }
  const w = tag[256][0], h = tag[257][0];
  if ((tag[259] || [1])[0] !== 1) throw new Error('compressed TIFF: not supported');
  if ((tag[258] || [0])[0] !== 32 || (tag[339] || [0])[0] !== 3) throw new Error('expected 32-bit float samples');
  const data = new Float32Array(w * h);
  if (tag[322]) {                                   // tiles
    const tw = tag[322][0], th = tag[323][0], offs = tag[324];
    const across = Math.ceil(w / tw);
    offs.forEach((o, t) => {
      const tx = (t % across) * tw, ty = Math.floor(t / across) * th;
      for (let y = 0; y < th && ty + y < h; y++) for (let x = 0; x < tw && tx + x < w; x++) data[(ty + y) * w + tx + x] = b.readFloatLE(o + (y * tw + x) * 4);
    });
  } else {                                          // strips
    const rows = (tag[278] || [h])[0], offs = tag[273];
    offs.forEach((o, s) => {
      for (let y = 0; y < rows && s * rows + y < h; y++) for (let x = 0; x < w; x++) data[(s * rows + y) * w + x] = b.readFloatLE(o + (y * w + x) * 4);
    });
  }
  // Where it lies, from the file itself. NEVER assume it is the box that was
  // asked for: asked for a size whose shape is not the box's (in degrees), the
  // server widens the box to fit, about its middle.
  const sc = tag[33550], tp = tag[33922];
  const geo = sc && tp ? { w: tp[3], n: tp[4], px: sc[0], py: sc[1], e: tp[3] + sc[0] * w, s: tp[4] - sc[1] * h } : null;
  return { w, h, data, tags: tag, geo };
}
module.exports = { readTiff };

if (require.main === module) {
  const t = readTiff(process.argv[2]);
  let lo = Infinity, hi = -Infinity;
  for (const v of t.data) { if (v < -1000) continue; lo = Math.min(lo, v); hi = Math.max(hi, v); }
  console.log(t.w, t.h, 'min', lo.toFixed(2), 'max', hi.toFixed(2), 'tiled', !!t.tags[322], 'lies at', JSON.stringify(t.geo));
  // a coarse picture: 20 columns x 16 rows of heights (m)
  for (let r = 0; r < 16; r++) {
    let line = '';
    for (let c = 0; c < 20; c++) line += String(Math.round(t.data[Math.floor((r + 0.5) / 16 * t.h) * t.w + Math.floor((c + 0.5) / 20 * t.w)])).padStart(4);
    console.log(line);
  }
}
