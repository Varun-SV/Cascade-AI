// Builds the extension into extension/dist, ready for chrome://extensions → Load unpacked.
//
// The device code is the SDK's own (src/browser/relay), bundled with three small
// shims in place of Node's `ws`, `node:crypto` and `node:net`: one protocol and one
// policy, whether the device is the CLI or this extension.

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'dist');
const shim = (name) => path.join(here, 'src', 'shims', name);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  platform: 'browser',
  target: 'chrome125',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  alias: {
    ws: shim('ws.ts'),
    'node:crypto': shim('crypto.ts'),
    'node:net': shim('net.ts'),
  },
  inject: [shim('install-buffer.ts')],
  define: { 'process.env.NODE_ENV': '"production"' },
};

await build({ ...common, entryPoints: [path.join(here, 'src', 'background.ts')], outfile: path.join(out, 'background.js'), format: 'esm' });
await build({ ...common, entryPoints: [path.join(here, 'src', 'popup.ts')], outfile: path.join(out, 'popup.js'), format: 'iife' });
await build({ ...common, entryPoints: [path.join(here, 'src', 'consent.ts')], outfile: path.join(out, 'consent.js'), format: 'iife' });

for (const f of fs.readdirSync(path.join(here, 'static'))) fs.copyFileSync(path.join(here, 'static', f), path.join(out, f));

// The icon: a filled rounded square in the accent colour. Written here, so the repo
// holds no binary.
function png(size) {
  const [r, g, b] = [0xc2, 0x41, 0x0c];
  const radius = size * 0.22;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const dx = Math.max(radius - x, 0, x - (size - 1 - radius));
      const dy = Math.max(radius - y, 0, y - (size - 1 - radius));
      const inside = dx * dx + dy * dy <= radius * radius;
      // A white chevron, the cascade mark.
      const u = x / size, v = y / size;
      const chevron = Math.abs(v - 0.35 - Math.abs(u - 0.5) * 0.9) < 0.08 || Math.abs(v - 0.6 - Math.abs(u - 0.5) * 0.9) < 0.08;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      if (!inside) { raw[o + 3] = 0; continue; }
      const white = chevron && u > 0.18 && u < 0.82;
      raw[o] = white ? 255 : r; raw[o + 1] = white ? 255 : g; raw[o + 2] = white ? 255 : b; raw[o + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) >>> 0 : crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
for (const size of [32, 128]) fs.writeFileSync(path.join(out, `icon-${size}.png`), png(size));

console.log(`extension built: ${path.relative(process.cwd(), out)}`);
