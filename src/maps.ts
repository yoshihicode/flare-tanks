// Maps (spec "マップ"): the fixed basic map and, from step 7, chunk-based generated maps.
// Every map is point-symmetric about its center so both teams get the same conditions.
// Pure data and functions, so Node can import this file directly for tests.
import { TILE } from "../public/shared.js";

type Team = "A" | "B";
export interface Spawn { x: number; y: number; body: number } // px, and the direction tanks face
export interface GameMap {
  id: string; // settings value: "basic" | "random"
  seed: number | null; // generated maps: the seed that reproduces this map
  tiles: string[]; // "#" wall / "." floor, one string per row
  w: number; h: number; // in tiles
  spawns: Record<Team, Spawn[]>; // three slots per team
  points: { id: string; x: number; y: number }[]; // capture points A / B / C (px)
}

// Tile (tx, ty) center in px
const at = (tx: number, ty: number) => ({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 });

// 180-degree rotation about the map center (the symmetry every map must have)
export const mirror = (m: { w: number; h: number }, p: { x: number; y: number }) =>
  ({ x: m.w * TILE - p.x, y: m.h * TILE - p.y });

// ===== Basic map: 40x24 tiles, used since step 1 (and by the smoke test scenarios) =====
export function basicMap(): GameMap {
  const W = 40, H = 24;
  const g = Array.from({ length: H }, (_, y) =>
    Array.from({ length: W }, (_, x) => (x === 0 || y === 0 || x === W - 1 || y === H - 1 ? "#" : ".")),
  );
  // [x, y, 幅, 高さ]。180°回転した位置にも同じ壁を置く
  const rects = [[6, 4, 2, 6], [12, 10, 6, 2], [18, 3, 2, 5], [8, 16, 4, 2], [16, 15, 2, 4]];
  for (const [rx, ry, rw, rh] of rects) {
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        g[y][x] = "#";
        g[H - 1 - y][W - 1 - x] = "#";
      }
    }
  }
  const size = { w: W, h: H };
  const spawnsA = [0, 1, 2].map((i) => ({ ...at(3, 10 + i * 2), body: 0 }));
  const pointA = { x: 12.5 * TILE, y: 5.5 * TILE };
  return {
    id: "basic", seed: null, tiles: g.map((r) => r.join("")), w: W, h: H,
    spawns: { A: spawnsA, B: spawnsA.map((s) => ({ ...mirror(size, s), body: Math.PI })) },
    points: [
      { id: "A", ...pointA },
      { id: "B", ...mirror(size, pointA) },
      { id: "C", x: (W * TILE) / 2, y: (H * TILE) / 2 },
    ],
  };
}
