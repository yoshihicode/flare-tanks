// Chunk-based map generation (spec "マップ" 段階2): fill the top half of an 8x8 grid of 16x16 parts
// at random from a seed, then copy it rotated 180 degrees onto the bottom half (point symmetry).
// The result is checked against the spec's conditions and regenerated from a derived seed if needed.
// Pure functions: Node imports this file directly for tests.
import { TILE } from "../public/shared.js";
import { BASE_CHUNK, CHUNK, PLAZA_CHUNK, POINT_CHUNK, RANDOM_CHUNKS, transform } from "./chunks.ts";
import { mirror, type GameMap } from "./maps.ts";

export const GEN = {
  chunks: 8, // parts per side -> 128x128 tiles
  maxAttempts: 20, // candidates tried per seed before giving up
  minPaths: 3, // spec: at least 3 routes between capture points
  wallMin: 0.08, // spec: "enough cover for the fan-shaped view" -> overall wall ratio range
  wallMax: 0.3,
  blockWallMin: 0.03, // every 32x32 area needs some cover (no big empty field)
  zoneWallMax: 0.2, // capture zones (radius 2.5 tiles) stay mostly open
};

// Fixed parts, top half only (the bottom half mirrors them): [chunk x, chunk y, part, rotations]
const FIXED: [number, number, string[], number][] = [
  [0, 3, BASE_CHUNK, 0], // team A base, left side just above the middle
  [2, 1, POINT_CHUNK, 0], // capture point A
  [3, 3, PLAZA_CHUNK, 0], // the center: open quadrants face point C from both top parts
  [4, 3, PLAZA_CHUNK, 1],
];

// Small seeded PRNG (mulberry32): the same seed always gives the same map
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One candidate map from a seed (not yet validated)
export function assemble(seed: number): GameMap {
  const rand = rng(seed);
  const n = GEN.chunks * CHUNK;
  const half = n / 2;
  const parts = Object.values(RANDOM_CHUNKS);
  const top: string[][] = Array.from({ length: half }, () => Array(n).fill("."));
  for (let cy = 0; cy < GEN.chunks / 2; cy++) {
    for (let cx = 0; cx < GEN.chunks; cx++) {
      const fixed = FIXED.find(([x, y]) => x === cx && y === cy);
      const rows = fixed
        ? transform(fixed[2], fixed[3])
        : transform(parts[Math.floor(rand() * parts.length)], Math.floor(rand() * 4), rand() < 0.5);
      for (let y = 0; y < CHUNK; y++) for (let x = 0; x < CHUNK; x++) top[cy * CHUNK + y][cx * CHUNK + x] = rows[y][x];
    }
  }
  // Markers -> spawns and point A (then replaced by floor)
  const spawnsA: { x: number; y: number; body: number }[] = [];
  let pointA = { x: 0, y: 0 };
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < n; x++) {
      const c = top[y][x];
      if (c === "S") spawnsA.push({ x: x * TILE + TILE / 2, y: y * TILE + TILE / 2, body: 0 });
      if (c === "P") pointA = { x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 };
      if (c !== "#") top[y][x] = ".";
    }
  }
  // Bottom half = top half rotated 180 degrees; then the outer border becomes wall
  const rows = [...top.map((r) => r.join(""))];
  for (let y = half; y < n; y++) rows.push([...rows[n - 1 - y]].reverse().join(""));
  const tiles = rows.map((r, y) => [...r].map((c, x) => (x === 0 || y === 0 || x === n - 1 || y === n - 1 ? "#" : c)).join(""));
  const size = { w: n, h: n };
  return {
    id: "random", seed, tiles, w: n, h: n,
    spawns: { A: spawnsA, B: spawnsA.map((s) => ({ ...mirror(size, s), body: Math.PI })) },
    points: [
      { id: "A", ...pointA },
      { id: "B", ...mirror(size, pointA) },
      { id: "C", x: (n * TILE) / 2, y: (n * TILE) / 2 },
    ],
  };
}

// ===== Checks (spec "自動生成の条件") =====
const wall = (m: GameMap, x: number, y: number) => x < 0 || y < 0 || x >= m.w || y >= m.h || m.tiles[y][x] === "#";
const tileOf = (p: { x: number; y: number }): [number, number] => [Math.floor(p.x / TILE), Math.floor(p.y / TILE)];

// All floor reachable from one floor tile (4-neighbor flood fill)
export function connected(m: GameMap): boolean {
  let total = 0, start = -1;
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (!wall(m, x, y)) { total++; if (start < 0) start = y * m.w + x; }
  const seen = new Uint8Array(m.w * m.h);
  const stack = [start];
  seen[start] = 1;
  let count = 0;
  while (stack.length) {
    const k = stack.pop()!;
    count++;
    const x = k % m.w, y = Math.floor(k / m.w);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, nk = ny * m.w + nx;
      if (!wall(m, nx, ny) && !seen[nk]) { seen[nk] = 1; stack.push(nk); }
    }
  }
  return count === total;
}

// Number of routes between two tiles that share no tile (vertex-disjoint paths), counted up to `cap`.
// Max flow with every floor tile split into in/out nodes of capacity 1 (BFS augmenting paths)
export function disjointPaths(m: GameMap, from: [number, number], to: [number, number], cap = GEN.minPaths): number {
  const N = m.w * m.h;
  const src = from[1] * m.w + from[0], dst = to[1] * m.w + to[0];
  // Residual capacity: inner edge of node k (in -> out) and the edge from k.out to neighbor d's in
  const inner = new Uint8Array(N).fill(1);
  const flowOut = new Int8Array(N * 4); // +1 when a unit flows k.out -> neighbor(d).in, -1 on the reverse
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const opposite = [1, 0, 3, 2];
  const nb = (k: number, d: number) => {
    const x = (k % m.w) + dirs[d][0], y = Math.floor(k / m.w) + dirs[d][1];
    return wall(m, x, y) ? -1 : y * m.w + x;
  };
  let flow = 0;
  while (flow < cap) {
    // BFS over states (node, side): side 0 = in, 1 = out. prev stores how we got there
    const prev = new Int32Array(N * 2).fill(-1);
    const q = [src * 2 + 1];
    prev[src * 2 + 1] = src * 2 + 1;
    let found = false;
    while (q.length && !found) {
      const s = q.shift()!;
      const k = s >> 1, side = s & 1;
      const next: number[] = [];
      if (side === 0) {
        if (k !== src && k !== dst && inner[k]) next.push(k * 2 + 1); // in -> out if unused
        if (k === dst) { found = true; break; }
        for (let d = 0; d < 4; d++) { // undo flow that came into k from a neighbor's out
          const j = nb(k, d);
          if (j >= 0 && flowOut[j * 4 + opposite[d]] === 1) next.push(j * 2 + 1);
        }
      } else {
        if (k !== src && !inner[k]) next.push(k * 2); // out -> in along used inner edge (reverse)
        for (let d = 0; d < 4; d++) {
          const j = nb(k, d);
          if (j >= 0 && flowOut[k * 4 + d] === 0) next.push(j * 2);
        }
      }
      for (const t of next) if (prev[t] < 0) { prev[t] = s; q.push(t); }
    }
    if (!found) break;
    // Walk back from dst.in and apply the path
    for (let t = dst * 2; t !== src * 2 + 1;) {
      const s = prev[t];
      const k = s >> 1, j = t >> 1;
      if (k === j) inner[k] = (s & 1) === 0 ? 0 : 1; // in->out uses the node; out->in frees it
      else {
        const d = dirs.findIndex(([dx, dy]) => (k % m.w) + dx === j % m.w && Math.floor(k / m.w) + dy === Math.floor(j / m.w));
        if ((s & 1) === 1) flowOut[k * 4 + d]++; // k.out -> j.in
        else flowOut[j * 4 + opposite[d]]--; // cancel j.out -> k.in
      }
      t = s;
    }
    flow++;
  }
  return flow;
}

const wallRatio = (m: GameMap, x0: number, y0: number, w: number, h: number) => {
  let walls = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (wall(m, x, y)) walls++;
  return walls / (w * h);
};

// Walls within radius r (tiles) of a point
const zoneWalls = (m: GameMap, p: { x: number; y: number }, r: number) => {
  let walls = 0, total = 0;
  const cx = p.x / TILE, cy = p.y / TILE;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > r) continue;
      total++;
      if (wall(m, x, y)) walls++;
    }
  }
  return walls / total;
};

// Returns the list of failed conditions (empty = OK)
export function validate(m: GameMap): string[] {
  const fails: string[] = [];
  if (!connected(m)) fails.push("not connected");
  const [A, B, C] = ["A", "B", "C"].map((id) => m.points.find((p) => p.id === id)!);
  const base = m.spawns.A[1];
  for (const [name, p, q] of [["A-C", A, C], ["A-B", A, B], ["base-C", base, C]] as const) {
    const n = disjointPaths(m, tileOf(p), tileOf(q));
    if (n < GEN.minPaths) fails.push(`${name}: ${n} paths`);
  }
  const total = wallRatio(m, 1, 1, m.w - 2, m.h - 2);
  if (total < GEN.wallMin || total > GEN.wallMax) fails.push(`wall ratio ${total.toFixed(2)}`);
  for (let by = 0; by < m.h; by += 32) {
    for (let bx = 0; bx < m.w; bx += 32) {
      if (wallRatio(m, bx, by, 32, 32) < GEN.blockWallMin) fails.push(`open field at ${bx},${by}`);
    }
  }
  for (const p of m.points) if (zoneWalls(m, p, 2.5) > GEN.zoneWallMax) fails.push(`zone ${p.id} blocked`);
  for (const s of [...m.spawns.A, ...m.spawns.B]) {
    const [tx, ty] = tileOf(s);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (wall(m, tx + dx, ty + dy)) fails.push("spawn blocked");
  }
  if (m.spawns.A.length !== 3) fails.push("spawn count");
  return fails;
}

// A valid generated map for a seed. Candidates use seeds derived from it until one passes
export function generateMap(seed: number): GameMap {
  let last: string[] = [];
  for (let attempt = 0; attempt < GEN.maxAttempts; attempt++) {
    const m = assemble(attempt === 0 ? seed : (Math.imul(seed ^ 0x9e3779b9, attempt + 1) >>> 0));
    last = validate(m);
    if (!last.length) return { ...m, seed };
  }
  throw new Error(`map generation failed for seed ${seed}: ${last.join(", ")}`);
}
