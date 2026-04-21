#!/usr/bin/env node
// Generates resources/icon.png (128x128 RGBA) using only Node.js built-ins.
'use strict';
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

const W = 128, H = 128;
const pixels = new Uint8Array(W * H * 4); // RGBA, init to 0 (transparent)

function setPixel(x, y, r, g, b, a) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 4;
  const fa = a / 255;
  pixels[i]   = Math.round(pixels[i]   * (1 - fa) + r * fa);
  pixels[i+1] = Math.round(pixels[i+1] * (1 - fa) + g * fa);
  pixels[i+2] = Math.round(pixels[i+2] * (1 - fa) + b * fa);
  pixels[i+3] = Math.min(255, pixels[i+3] + a);
}

// --- Background: dark-blue rounded rectangle ---
const [bgR, bgG, bgB] = [30, 58, 95];
const R = 18; // corner radius
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let inside;
    if (x >= R && x < W - R) {
      inside = y >= 0 && y < H;
    } else if (y >= R && y < H - R) {
      inside = x >= 0 && x < W;
    } else {
      const cx = x < R ? R : W - R;
      const cy = y < R ? R : H - R;
      const dx = x - cx, dy = y - cy;
      inside = dx * dx + dy * dy <= R * R;
    }
    if (inside) setPixel(x, y, bgR, bgG, bgB, 255);
  }
}

// --- Draw a thick anti-aliased point ---
function drawDot(px, py, r, g, b, radius) {
  const hw = Math.ceil(radius);
  for (let dy = -hw; dy <= hw; dy++) {
    for (let dx = -hw; dx <= hw; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > radius + 1) continue;
      const alpha = d < radius - 0.5 ? 255
                  : d > radius + 0.5  ? 0
                  : Math.round(255 * (radius + 0.5 - d));
      setPixel(Math.round(px + dx), Math.round(py + dy), r, g, b, alpha);
    }
  }
}

// --- Cubic Bezier sample ---
function bezier(x0, y0, x1, y1, x2, y2, x3, y3, t) {
  const mt = 1 - t;
  return [
    mt*mt*mt*x0 + 3*mt*mt*t*x1 + 3*mt*t*t*x2 + t*t*t*x3,
    mt*mt*mt*y0 + 3*mt*mt*t*y1 + 3*mt*t*t*y2 + t*t*t*y3,
  ];
}

function drawCurve(x0, y0, x1, y1, x2, y2, x3, y3, r, g, b, strokeR, t0 = 0, t1 = 1) {
  const steps = Math.ceil(300 * (t1 - t0));
  for (let i = 0; i <= steps; i++) {
    const t = t0 + (t1 - t0) * (i / steps);
    const [px, py] = bezier(x0, y0, x1, y1, x2, y2, x3, y3, t);
    drawDot(px, py, r, g, b, strokeR);
  }
}

// --- Three braid strands (same geometry as the SVG) ---
// Strand A teal  #4ec9b0 = (78,201,176) : left → mid → right
// Strand B purple #c586c0 = (197,134,192): mid → right → left
// Strand C gold  #dcdcaa = (220,220,170): right → mid → left

const teal   = [78, 201, 176];
const purple = [197, 134, 192];
const gold   = [220, 220, 170];
const sw = 4.5; // stroke half-radius

// Full curves (we draw in layers to get correct over/under)
// -- Pass 1: all three strands fully --
drawCurve(30,12, 30,30, 64,30, 64,48, ...teal,   sw);
drawCurve(64,48, 64,66, 98,66, 98,84, ...teal,   sw);
drawCurve(98,84, 98,102,64,102,64,116,...teal,   sw);

drawCurve(64,12, 64,30, 98,30, 98,48, ...purple, sw);
drawCurve(98,48, 98,66, 64,66, 64,84, ...purple, sw);
drawCurve(64,84, 64,102,30,102,30,116,...purple, sw);

drawCurve(98,12, 98,30, 64,30, 64,48, ...gold,   sw);
drawCurve(64,48, 64,66, 30,66, 30,84, ...gold,   sw);
drawCurve(30,84, 30,102,64,102,64,116,...gold,   sw);

// -- Pass 2: redraw the "over" segment of each crossing --
// Crossing 1 (~y=48): teal goes over purple & gold → redraw teal segment 1 middle portion
drawCurve(30,12, 30,30, 64,30, 64,48, ...teal,   sw, 0.55, 1.0);
// Crossing 2 (~y=84): purple goes over gold & teal → redraw purple segment 2 middle portion
drawCurve(98,48, 98,66, 64,66, 64,84, ...purple, sw, 0.55, 1.0);
// Crossing 3 (~y=84 lower): gold goes over teal → redraw gold segment 3 middle portion
drawCurve(30,84, 30,102,64,102,64,116,...gold,   sw, 0.55, 1.0);

// --- PNG encoding (pure Node.js) ---
function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t.push(c >>> 0);
    }
    return t;
  })());
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const len  = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeB = Buffer.from(type, 'ascii');
  const crcVal = Buffer.alloc(4);
  crcVal.writeUInt32BE(crc32(Buffer.concat([typeB, data])));
  return Buffer.concat([len, typeB, data, crcVal]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8]=8; ihdr[9]=6; // 8-bit RGBA

const rawRows = [];
for (let y = 0; y < H; y++) {
  rawRows.push(0); // filter = None
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    rawRows.push(pixels[i], pixels[i+1], pixels[i+2], pixels[i+3]);
  }
}
const compressed = zlib.deflateSync(Buffer.from(rawRows));

const out = Buffer.concat([
  Buffer.from([137,80,78,71,13,10,26,10]),
  makeChunk('IHDR', ihdr),
  makeChunk('IDAT', compressed),
  makeChunk('IEND', Buffer.alloc(0)),
]);

const dest = path.join(__dirname, '..', 'resources', 'icon.png');
fs.writeFileSync(dest, out);
console.log(`Written ${dest} (${out.length} bytes)`);
