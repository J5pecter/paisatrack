// Generates PaisaTrack PWA icons as real PNGs (no external image deps).
// Draws a rounded dark-slate tile with a green rupee (₹) mark.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

const BG = [0x0f, 0x17, 0x2a];      // slate-900
const FG = [0x22, 0xc5, 0x5e];      // green-500

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Signed distance helper for a rounded rectangle, used for anti-aliased corners. */
function roundRectAlpha(x, y, w, h, r) {
  const dx = Math.max(Math.abs(x - w / 2) - (w / 2 - r), 0);
  const dy = Math.max(Math.abs(y - h / 2) - (h / 2 - r), 0);
  const d = Math.hypot(dx, dy) - r;
  return Math.min(Math.max(0.5 - d, 0), 1); // 1px feather
}

/**
 * PaisaTrack monogram in a 0..1 unit box: a "P" bowl crossed by the two
 * horizontal bars of the rupee sign. Reads as both "Paisa" and the rupee mark.
 */
function inRupee(u, v) {
  // vertical stem
  if (u >= 0.18 && u <= 0.32 && v >= 0.06 && v <= 0.94) return true;

  // bowl of the P: solid from the stem out to an elliptical right edge,
  // with an elliptical counter punched out. Filling from the stem (rather
  // than from the ellipse's own left edge) avoids a notch at the join.
  if (v >= 0.06 && v <= 0.52) {
    const ny = (v - 0.29) / 0.235;
    if (Math.abs(ny) <= 1) {
      const rightEdge = 0.45 + 0.35 * Math.sqrt(1 - ny * ny);
      const counter = ((u - 0.44) / 0.20) ** 2 + ((v - 0.29) / 0.115) ** 2;
      if (u >= 0.22 && u <= rightEdge && counter > 1) return true;
    }
  }

  // two rupee bars crossing the stem
  if (v >= 0.560 && v <= 0.645 && u >= 0.07 && u <= 0.67) return true;
  if (v >= 0.700 && v <= 0.785 && u >= 0.07 && u <= 0.67) return true;
  return false;
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const pad = size * 0.16;          // glyph inset inside the tile
  const inner = size - pad * 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const tileA = roundRectAlpha(x + 0.5, y + 0.5, size, size, radius);

      // supersample the glyph 3x3 for smooth edges
      let hit = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const u = (x + (sx + 0.5) / 3 - pad) / inner;
          const v = (y + (sy + 0.5) / 3 - pad) / inner;
          if (u >= 0 && u <= 1 && v >= 0 && v <= 1 && inRupee(u, v)) hit++;
        }
      }
      const g = hit / 9;

      px[i]     = Math.round(BG[0] * (1 - g) + FG[0] * g);
      px[i + 1] = Math.round(BG[1] * (1 - g) + FG[1] * g);
      px[i + 2] = Math.round(BG[2] * (1 - g) + FG[2] * g);
      px[i + 3] = Math.round(255 * tileA);
    }
  }

  // PNG scanlines: one filter byte (0 = None) per row
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [name, size] of [
  ['public/pwa-192x192.png', 192],
  ['public/pwa-512x512.png', 512],
  ['public/apple-touch-icon.png', 180],
]) {
  writeFileSync(name, render(size));
  console.log('wrote', name, size + 'x' + size);
}
