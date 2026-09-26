// Generates the PWA icons (pixel-art tank) as PNG files without any dependencies.
// Usage: node scripts/make-icons.mjs   (writes public/icons/*.png; the output is committed)
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

// 16x16 design. . = background, # = tread, b = body (team A color), t = turret, f = flare light
const ART = [
  "................",
  "................",
  "...........ff...",
  "..........ffff..",
  "...........ff...",
  "................",
  "..############..",
  "..#bbbbbbbbbb#..",
  "..#bbbttttbbb#..",
  "..#bbbtttttttttt",
  "..#bbbttttbbb#..",
  "..#bbbbbbbbbb#..",
  "..############..",
  "................",
  "................",
  "................",
];
const COLORS = {
  ".": [18, 26, 20], // --night
  "#": [109, 106, 92], // treads (wall gray, so they stand out from the background)
  b: [90, 209, 200], // team A
  t: [233, 228, 212],
  f: [255, 179, 71], // --flare
};

// pad: fraction of the icon left as margin (maskable icons need a safe zone)
function render(size, pad = 0) {
  const inner = Math.floor(size * (1 - pad * 2));
  const cell = inner / 16;
  const off = Math.floor((size - inner) / 2);
  const px = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.floor((x - off) / cell), cy = Math.floor((y - off) / cell);
      const ch = cx >= 0 && cy >= 0 && cx < 16 && cy < 16 ? ART[cy][cx] : ".";
      COLORS[ch].forEach((v, i) => { px[(y * size + x) * 3 + i] = v; });
    }
  }
  return png(size, size, px);
}

// Minimal PNG encoder: 8-bit RGB, no filtering
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // bit depth 8, color type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const dir = new URL("../public/icons/", import.meta.url);
mkdirSync(dir, { recursive: true });
const files = {
  "icon-192.png": render(192),
  "icon-512.png": render(512),
  "maskable-512.png": render(512, 0.1), // Android crops maskable icons to a circle: keep the art inside
  "apple-touch-icon.png": render(180),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(new URL(name, dir), data);
  console.log(`${name} ${data.length} bytes`);
}
