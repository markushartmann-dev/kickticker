'use strict';

// Erzeugt die PWA-Icons als PNG ohne externe Abhaengigkeiten
// (einfacher Fussball auf dunklem Grund).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // Filter: None
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawIcon(size) {
  const img = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = a;
  };
  const cx = size / 2;
  const cy = size / 2;
  const ballR = size * 0.34;
  const pentR = ballR * 0.42;

  // Pentagon-Flecken des Balls
  const spots = [{ x: 0, y: 0, r: pentR * 0.85 }];
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI / 2 + (k * 2 * Math.PI) / 5;
    spots.push({ x: Math.cos(a) * ballR * 0.95, y: Math.sin(a) * ballR * 0.95, r: pentR * 0.8 });
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      // Hintergrund: dunkles Blau mit leichtem Verlauf
      const t = y / size;
      let r = 15 + t * 10, g = 20 + t * 14, b = 32 + t * 24;
      if (d < ballR) {
        // Ball
        r = 240; g = 244; b = 250;
        for (const s of spots) {
          if (Math.hypot(dx - s.x, dy - s.y) < s.r) { r = 26; g = 32; b = 46; break; }
        }
        // Schattierung am Rand
        const edge = d / ballR;
        if (edge > 0.82) { const f = 1 - (edge - 0.82) * 1.6; r *= f; g *= f; b *= f; }
      } else if (d < ballR * 1.12) {
        // Akzentring
        r = 77; g = 159; b = 255;
      }
      set(x, y, Math.round(r), Math.round(g), Math.round(b));
    }
  }
  return encodePNG(size, size, img);
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [180, 192, 512]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), drawIcon(size));
  console.log(`icon-${size}.png erzeugt`);
}
