'use strict';

// Erzeugt die PWA-Icons als PNG ohne externe Abhaengigkeiten.
// Gezeichnet wird ein klassischer Fussball (abgestumpftes Ikosaeder:
// 12 schwarze Fuenfecke, 20 weisse Sechsecke mit Naehten) auf dunklem Grund.

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

// ---- Vektor-Helfer -------------------------------------------------------

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

// Rotationsmatrix, die Einheitsvektor a auf Einheitsvektor b dreht (Rodrigues)
function rotationBetween(a, b) {
  const v = cross(a, b);
  const c = dot(a, b);
  const s = Math.hypot(v[0], v[1], v[2]);
  if (s < 1e-9) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [x, y, z] = [v[0] / s, v[1] / s, v[2] / s];
  const t = 1 - c;
  return [
    [c + x * x * t, x * y * t - z * s, x * z * t + y * s],
    [y * x * t + z * s, c + y * y * t, y * z * t - x * s],
    [z * x * t - y * s, z * y * t + x * s, c + z * z * t],
  ];
}
const applyM = (m, v) => [dot(m[0], v), dot(m[1], v), dot(m[2], v)];

// ---- Geometrie des abgestumpften Ikosaeders ------------------------------

function buildBallGeometry() {
  const PHI = (1 + Math.sqrt(5)) / 2;
  const ico = [];
  for (const s1 of [-1, 1]) {
    for (const s2 of [-1, 1]) {
      ico.push(norm([0, s1, s2 * PHI]));
      ico.push(norm([s1, s2 * PHI, 0]));
      ico.push(norm([s2 * PHI, 0, s1]));
    }
  }

  // Benachbarte Ikosaeder-Ecken erkennen (Skalarprodukt 1/sqrt(5))
  const ADJ = 1 / Math.sqrt(5);
  const neighbors = ico.map((v) =>
    ico.filter((w) => w !== v && Math.abs(dot(v, w) - ADJ) < 1e-6)
  );

  // Pentagon je Ikosaeder-Ecke: Abstumpfungspunkte bei 1/3 der Kanten,
  // nach Azimut um die Ecke sortiert.
  const pentagons = [];
  const edges = []; // { m: Grosskreis-Normale, mid, cosHalf } fuer die Naehte
  const addEdge = (p, q) => {
    const m = norm(cross(p, q));
    const mid = norm([p[0] + q[0], p[1] + q[1], p[2] + q[2]]);
    edges.push({ m, mid, cosHalf: dot(mid, p) });
  };

  for (let i = 0; i < ico.length; i++) {
    const v = ico[i];
    // Lokale Basis fuer die Azimut-Sortierung
    const ref = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e1 = norm(cross(v, ref));
    const e2 = cross(v, e1);
    const pts = neighbors[i]
      .map((n) => {
        const p = norm([(2 * v[0] + n[0]) / 3, (2 * v[1] + n[1]) / 3, (2 * v[2] + n[2]) / 3]);
        return { p, a: Math.atan2(dot(p, e2), dot(p, e1)) };
      })
      .sort((a, b) => a.a - b.a)
      .map((o) => o.p);

    // Kantenebenen so orientieren, dass "innen" positiv ist
    const planes = [];
    for (let k = 0; k < 5; k++) {
      const p = pts[k];
      const q = pts[(k + 1) % 5];
      let m = cross(p, q);
      if (dot(m, v) < 0) m = [-m[0], -m[1], -m[2]];
      planes.push(norm(m));
      addEdge(p, q); // Pentagon-Rand = Naht
    }
    pentagons.push({ center: v, planes, cosR: dot(v, pts[0]) });
  }

  // Sechseck-Sechseck-Naehte: mittleres Drittel jeder Ikosaeder-Kante
  for (let i = 0; i < ico.length; i++) {
    for (const n of neighbors[i]) {
      if (ico.indexOf(n) <= i) continue; // jede Kante nur einmal
      const a = ico[i];
      const p = norm([(2 * a[0] + n[0]) / 3, (2 * a[1] + n[1]) / 3, (2 * a[2] + n[2]) / 3]);
      const q = norm([(a[0] + 2 * n[0]) / 3, (a[1] + 2 * n[1]) / 3, (a[2] + 2 * n[2]) / 3]);
      addEdge(p, q);
    }
  }

  return { pentagons, edges };
}

// ---- Zeichnen ------------------------------------------------------------

function drawIcon(size) {
  const { pentagons, edges } = buildBallGeometry();

  // Ball so drehen, dass ein Pentagon leicht nach oben versetzt vorne liegt
  const front = pentagons[0].center;
  const target = norm([0, -0.38, 1]);
  const rot = rotationBetween(target, front); // Blickrichtung -> Ballkoordinaten

  const img = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const ballR = size * 0.36;
  const ringR = ballR * 1.1;
  const light = norm([-0.45, -0.6, 0.75]);
  const seamHalf = 0.016; // halbe Nahtbreite (Winkel, rad)
  const SS = 2; // 2x2 Supersampling gegen Treppchen

  const pentCosMax = Math.max(...pentagons.map((p) => p.cosR));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let R = 0, G = 0, B = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS - cx;
          const py = y + (sy + 0.5) / SS - cy;
          const d = Math.hypot(px, py);

          // Hintergrund: dunkles Blau mit leichtem Verlauf
          const t = (y + 0.5) / size;
          let r = 15 + t * 10, g = 20 + t * 14, b = 32 + t * 24;

          if (d < ballR) {
            // Punkt auf der Kugel + Drehung in Ballkoordinaten
            const nx = px / ballR;
            const ny = py / ballR;
            const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
            const n = applyM(rot, [nx, ny, nz]);

            // Grundfarbe: weisses Leder
            r = 245; g = 247; b = 251;

            // Pentagon-Flaechen
            let inPent = false;
            for (const p of pentagons) {
              if (dot(n, p.center) < pentCosMax - 0.05) continue;
              if (p.planes.every((pl) => dot(n, pl) > -0.004)) { inPent = true; break; }
            }
            if (inPent) { r = 24; g = 30; b = 44; }

            // Naehte (Grosskreisboegen zwischen den Flaechen)
            if (!inPent) {
              for (const e of edges) {
                const off = Math.abs(dot(n, e.m));
                if (off > seamHalf) continue;
                // liegt die Projektion innerhalb des Bogenstuecks?
                if (dot(n, e.mid) >= e.cosHalf - 0.002) {
                  const f = off / seamHalf;
                  const mix = 1 - f * f; // weiche Kante
                  r = r * (1 - mix) + 90 * mix;
                  g = g * (1 - mix) + 100 * mix;
                  b = b * (1 - mix) + 120 * mix;
                  break;
                }
              }
            }

            // Beleuchtung: Lambert + Glanzlicht + Randabdunklung
            const lam = Math.max(0, dot([nx, ny, nz], light));
            let shade = 0.62 + 0.48 * lam;
            const spec = Math.pow(Math.max(0, dot([nx, ny, nz], light)), 24);
            const edgeT = d / ballR;
            if (edgeT > 0.88) shade *= 1 - (edgeT - 0.88) * 2.2;
            r = Math.min(255, r * shade + spec * 60);
            g = Math.min(255, g * shade + spec * 60);
            b = Math.min(255, b * shade + spec * 60);
          } else if (d < ringR) {
            // Akzentring in App-Blau
            r = 77; g = 159; b = 255;
          }

          R += r; G += g; B += b;
        }
      }
      const i = (y * size + x) * 4;
      const nSamples = SS * SS;
      img[i] = Math.round(R / nSamples);
      img[i + 1] = Math.round(G / nSamples);
      img[i + 2] = Math.round(B / nSamples);
      img[i + 3] = 255;
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
