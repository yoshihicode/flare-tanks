// bot の思考。部屋DO（src/index.ts）から毎ティック呼ばれ、人間と同じ形式の入力を返す。
// 受け取る情報は「自分の状態・味方の状態・自分の視界に入っている敵」だけにして、壁越しに敵を知ることがないようにする。
// Room に依存しないので、Node から直接読み込んでテストできる（scripts/bot-test.mjs）
import { TILE, isWallTile } from "../public/shared.js";

export interface TankView {
  id: string; team: string; type: string;
  x: number; y: number; aim: number; hp: number; dead: boolean;
}
export interface BotInput { mx: number; my: number; aim: number; fire: boolean }
export interface Perception {
  self: TankView;
  allies: TankView[]; // 味方は人間と同じく常に位置がわかる
  enemies: TankView[]; // 自分の視界に入っている敵だけ
  now: number; // 秒
}
interface Grid { map: string[]; w: number; h: number }
type Tile = [number, number];

// ===== 経路探索（タイル上のA*、上下左右の4方向） =====
export function findPath(g: Grid, from: Tile, to: Tile): Tile[] | null {
  if (isWallTile(g, to[0], to[1])) return null;
  const key = (x: number, y: number) => y * g.w + x;
  const h = (x: number, y: number) => Math.abs(x - to[0]) + Math.abs(y - to[1]);
  const open: { x: number; y: number; f: number }[] = [{ x: from[0], y: from[1], f: h(from[0], from[1]) }];
  const cost = new Map<number, number>([[key(from[0], from[1]), 0]]);
  const came = new Map<number, number>();
  while (open.length) {
    // マップが小さいので、ヒープではなく最小値の線形探索で十分
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur.x === to[0] && cur.y === to[1]) {
      const path: Tile[] = [];
      for (let k: number | undefined = key(cur.x, cur.y); k !== undefined; k = came.get(k)) {
        path.push([k % g.w, Math.floor(k / g.w)]);
      }
      return path.reverse();
    }
    const c = cost.get(key(cur.x, cur.y))!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (isWallTile(g, nx, ny)) continue;
      const nk = key(nx, ny);
      if (cost.has(nk) && cost.get(nk)! <= c + 1) continue;
      cost.set(nk, c + 1);
      came.set(nk, key(cur.x, cur.y));
      open.push({ x: nx, y: ny, f: c + 1 + h(nx, ny) });
    }
  }
  return null;
}

export const toTile = (x: number, y: number): Tile => [Math.floor(x / TILE), Math.floor(y / TILE)];
const center = (t: Tile) => ({ x: t[0] * TILE + TILE / 2, y: t[1] * TILE + TILE / 2 });

// ===== bot 本体 =====
const BOT = {
  arriveDist: 3, // 経路上の点に着いたとみなす距離（px）
  stuckSec: 1.2, // この時間ほとんど動けなければ経路を引き直す
  lookSweep: 0.9, // 巡回中に周囲を見回す振れ幅（ラジアン）
  lookSpeed: 1.6, // 見回す速さ
};

export class Bot {
  path: Tile[] = [];
  lastMoveAt = 0;
  lastPos = { x: 0, y: 0 };
  level: number; // 強さ（1〜5）
  grid: Grid;
  rand: () => number; // テストで結果を固定できるよう差し替え可能にする
  constructor(level: number, grid: Grid, rand: () => number = Math.random) {
    this.level = level;
    this.grid = grid;
    this.rand = rand;
  }

  think(p: Perception): BotInput {
    const s = p.self;
    if (!this.path.length || this.isStuck(p)) this.path = this.patrolPath(s) ?? [];
    const move = this.follow(s);
    // 進む方向を中心に首を振り、扇形視界の死角を減らす
    const heading = move.mx || move.my ? Math.atan2(move.my, move.mx) : s.aim;
    const aim = heading + Math.sin(p.now * BOT.lookSpeed + s.x * 0.01) * BOT.lookSweep;
    return { ...move, aim, fire: false };
  }

  // 近くのランダムな床タイルへの経路（壁や遠すぎる場所は選び直す）
  patrolPath(s: TankView): Tile[] | null {
    const from = toTile(s.x, s.y);
    for (let i = 0; i < 20; i++) {
      const to: Tile = [1 + Math.floor(this.rand() * (this.grid.w - 2)), 1 + Math.floor(this.rand() * (this.grid.h - 2))];
      if (isWallTile(this.grid, to[0], to[1])) continue;
      const path = findPath(this.grid, from, to);
      if (path && path.length > 3) return path;
    }
    return null;
  }

  // 経路の次の点へ向かう入力（8方向）。着いた点は経路から外す
  follow(s: TankView): { mx: number; my: number } {
    while (this.path.length) {
      const c = center(this.path[0]);
      if (Math.hypot(c.x - s.x, c.y - s.y) > BOT.arriveDist) break;
      this.path.shift();
    }
    if (!this.path.length) return { mx: 0, my: 0 };
    const c = center(this.path[0]);
    const dx = c.x - s.x, dy = c.y - s.y;
    return { mx: Math.abs(dx) > 1.5 ? Math.sign(dx) : 0, my: Math.abs(dy) > 1.5 ? Math.sign(dy) : 0 };
  }

  isStuck(p: Perception): boolean {
    const s = p.self;
    if (Math.hypot(s.x - this.lastPos.x, s.y - this.lastPos.y) > 4) {
      this.lastPos = { x: s.x, y: s.y };
      this.lastMoveAt = p.now;
      return false;
    }
    if (p.now - this.lastMoveAt < BOT.stuckSec) return false;
    this.lastMoveAt = p.now;
    return true;
  }
}
