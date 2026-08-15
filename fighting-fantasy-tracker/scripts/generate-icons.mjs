// Generates the PWA icon set as plain PNGs with no external dependencies
// (no image libraries are available in this environment). Re-run with
// `node scripts/generate-icons.mjs` after changing colors/layout below.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [26, 18, 43, 255]; // deep dungeon purple
const DIE = [240, 224, 191, 255]; // parchment cream
const DIE_BORDER = [120, 40, 40, 255]; // oxblood red
const PIP = [26, 18, 43, 255]; // matches bg, reads as carved-in

function makeCanvas(size) {
  const buf = new Float64Array(size * size * 4);
  return {
    size,
    buf,
    set(x, y, [r, g, b, a]) {
      if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
      const i = (y * this.size + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
    },
  };
}

function fillRect(c, x0, y0, x1, y1, color) {
  for (let y = Math.max(0, Math.round(y0)); y < Math.min(c.size, Math.round(y1)); y++) {
    for (let x = Math.max(0, Math.round(x0)); x < Math.min(c.size, Math.round(x1)); x++) {
      c.set(x, y, color);
    }
  }
}

function fillRoundedRect(c, x0, y0, x1, y1, radius, color) {
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(c.size, Math.ceil(y1)); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(c.size, Math.ceil(x1)); x++) {
      const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
      const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) c.set(x, y, color);
    }
  }
}

function fillCircle(c, cx, cy, r, color) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) c.set(x, y, color);
    }
  }
}

function downsample(c, factor) {
  const outSize = c.size / factor;
  const out = new Uint8Array(outSize * outSize * 4);
  for (let y = 0; y < outSize; y++) {
    for (let x = 0; x < outSize; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const sx = x * factor + dx, sy = y * factor + dy;
          const i = (sy * c.size + sx) * 4;
          r += c.buf[i]; g += c.buf[i + 1]; b += c.buf[i + 2]; a += c.buf[i + 3];
        }
      }
      const n = factor * factor;
      const oi = (y * outSize + x) * 4;
      out[oi] = r / n; out[oi + 1] = g / n; out[oi + 2] = b / n; out[oi + 3] = a / n;
    }
  }
  return { size: outSize, data: out };
}

// Minimal PNG encoder: single IDAT, filter type 0 per scanline.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePNG(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawDie(c, size, { safeMargin }) {
  fillRect(c, 0, 0, size, size, BG);
  const dieSize = size * (1 - safeMargin * 2);
  const x0 = (size - dieSize) / 2;
  const y0 = (size - dieSize) / 2;
  const border = dieSize * 0.045;
  fillRoundedRect(c, x0, y0, x0 + dieSize, y0 + dieSize, dieSize * 0.18, DIE_BORDER);
  fillRoundedRect(
    c,
    x0 + border, y0 + border, x0 + dieSize - border, y0 + dieSize - border,
    dieSize * 0.15, DIE
  );

  const pipR = dieSize * 0.09;
  const cx = x0 + dieSize / 2;
  const cy = y0 + dieSize / 2;
  const off = dieSize * 0.24;
  // Six pips: two columns, three rows (a "6" face).
  const cols = [cx - off, cx + off];
  const rows = [cy - off, cy, cy + off];
  for (const px of cols) {
    for (const py of rows) {
      fillCircle(c, px, py, pipR, PIP);
    }
  }
}

function buildIcon(finalSize, { safeMargin }) {
  const factor = 4;
  const c = makeCanvas(finalSize * factor);
  drawDie(c, c.size, { safeMargin });
  const { size, data } = downsample(c, factor);
  return encodePNG(size, Buffer.from(data));
}

const targets = [
  { file: 'icon-192.png', size: 192, safeMargin: 0.06 },
  { file: 'icon-512.png', size: 512, safeMargin: 0.06 },
  { file: 'icon-512-maskable.png', size: 512, safeMargin: 0.22 },
  { file: 'apple-touch-icon.png', size: 180, safeMargin: 0.1 },
  { file: 'favicon-32.png', size: 32, safeMargin: 0.06 },
];

for (const t of targets) {
  const png = buildIcon(t.size, { safeMargin: t.safeMargin });
  writeFileSync(path.join(outDir, t.file), png);
  console.log(`wrote ${t.file} (${png.length} bytes)`);
}
