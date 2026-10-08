/*
 * Generates the extension icons (no external assets, no dependencies).
 *   node scripts/make-icons.js
 * Draws an orange rounded square with a white play triangle at 16/32/48/128 px.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function inRoundedRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x > w || y > h) return 0;
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r ? 1 : 0;
}

function inTriangle(px, py, w, h) {
  const ax = 0.37 * w, ay = 0.28 * h;
  const bx = 0.37 * w, by = 0.72 * h;
  const cx = 0.70 * w, cy = 0.5 * h;
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return neg && pos ? 0 : 1;
}

function render(size) {
  const SS = 4;                      // supersampling factor
  const w = size, h = size;
  const rgba = Buffer.alloc(w * h * 4);
  const r = 0.22 * size;
  const orange = [255, 85, 0], white = [255, 255, 255];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let bgCov = 0, fgCov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (inRoundedRect(px, py, w, h, r)) {
            bgCov++;
            if (inTriangle(px, py, w, h)) fgCov++;
          }
        }
      }
      const total = SS * SS;
      const a = bgCov / total;
      const f = bgCov ? fgCov / bgCov : 0;
      const col = f > 0 ? white : orange;
      const o = (y * w + x) * 4;
      rgba[o] = col[0]; rgba[o + 1] = col[1]; rgba[o + 2] = col[2];
      rgba[o + 3] = Math.round(a * 255);
    }
  }
  return encodePng(w, h, rgba);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, render(size));
  console.log('wrote', file, fs.statSync(file).size, 'bytes');
}
