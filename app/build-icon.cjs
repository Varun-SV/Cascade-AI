/**
 * Pure Node.js PNG generator — no external deps.
 * Draws the Cascade AI C-monogram icon: 5 stacked bars on dark background,
 * violet (#8b7cf9) → cyan (#3ec9d6) gradient, 1024×1024.
 */
const zlib = require('zlib');
const fs = require('fs');

const W = 1024, H = 1024;
// RGBA pixel buffer, row-major
const pixels = Buffer.alloc(W * H * 4);

function setPixel(x, y, r, g, b, a = 255) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const idx = (y * W + x) * 4;
  // Alpha-blend onto current pixel
  const fa = a / 255;
  const ia = 1 - fa;
  pixels[idx]     = Math.round(pixels[idx]     * ia + r * fa);
  pixels[idx + 1] = Math.round(pixels[idx + 1] * ia + g * fa);
  pixels[idx + 2] = Math.round(pixels[idx + 2] * ia + b * fa);
  pixels[idx + 3] = Math.min(255, pixels[idx + 3] + a);
}

// Fill background
const BG = [0x0a, 0x0a, 0x0d];
for (let i = 0; i < W * H; i++) {
  pixels[i * 4]     = BG[0];
  pixels[i * 4 + 1] = BG[1];
  pixels[i * 4 + 2] = BG[2];
  pixels[i * 4 + 3] = 255;
}

// Draw a filled rounded rectangle with a flat solid color
function fillRoundedRect(rx, ry, rw, rh, radius, r, g, b) {
  const x1 = rx, y1 = ry, x2 = rx + rw, y2 = ry + rh;
  for (let y = Math.floor(y1); y <= Math.ceil(y2); y++) {
    for (let x = Math.floor(x1); x <= Math.ceil(x2); x++) {
      // Distance to nearest corner center
      const cx = Math.max(x1 + radius, Math.min(x2 - radius, x + 0.5));
      const cy = Math.max(y1 + radius, Math.min(y2 - radius, y + 0.5));
      const px = x + 0.5, py = y + 0.5;
      const dist = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
      const alpha = Math.max(0, Math.min(1, radius - dist + 0.5));
      setPixel(x, y, r, g, b, Math.round(alpha * 255));
    }
  }
}

// Draw app-icon rounded rect clip on background (soft inner glow)
// The app icon shape is already the rounded bg from electron-builder's iconutil,
// but we paint our own subtle vignette to match.

// 5 bars: cascade C-monogram
// Full height: ~730px across top-to-bottom within safe area (y: 148..876)
// Indent on right side reduces for middle bars
const bars = [
  { x: 172, y: 148, w: 680, h: 110 },   // top    — full width
  { x: 172, y: 300, w: 540, h: 110 },   // 2nd    — shorter right
  { x: 172, y: 452, w: 420, h: 110 },   // middle — shortest
  { x: 172, y: 604, w: 540, h: 110 },   // 4th    — matches 2nd
  { x: 172, y: 756, w: 680, h: 110 },   // bottom — full width
];

// violet #8b7cf9 → cyan #3ec9d6 per bar
const cStart = { r: 0x8b, g: 0x7c, b: 0xf9 };
const cEnd   = { r: 0x3e, g: 0xc9, b: 0xd6 };
const lerp = (a, b, t) => Math.round(a + (b - a) * t);

bars.forEach((bar, i) => {
  const t = i / (bars.length - 1);
  const r = lerp(cStart.r, cEnd.r, t);
  const g = lerp(cStart.g, cEnd.g, t);
  const b = lerp(cStart.b, cEnd.b, t);
  fillRoundedRect(bar.x, bar.y, bar.w, bar.h, 18, r, g, b);
});

// ─── Encode as PNG ────────────────────────────────────────────────────────────
function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// IHDR: width, height, bit-depth 8, color-type 2 (RGB, no alpha for clean PNG)
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 2;  // color type: RGB
ihdr[10] = ihdr[11] = ihdr[12] = 0;

// Build raw scanlines: filter byte (0 = None) + RGB data
const rawLines = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  rawLines[y * (1 + W * 3)] = 0; // filter type None
  for (let x = 0; x < W; x++) {
    const src = (y * W + x) * 4;
    const dst = y * (1 + W * 3) + 1 + x * 3;
    rawLines[dst]     = pixels[src];
    rawLines[dst + 1] = pixels[src + 1];
    rawLines[dst + 2] = pixels[src + 2];
  }
}

const compressed = zlib.deflateSync(rawLines, { level: 6 });

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG sig
  chunk('IHDR', ihdr),
  chunk('IDAT', compressed),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.writeFileSync(require('path').join(__dirname,'assets','icon.png'), png);
console.log('icon.png written:', png.length, 'bytes');
