// bot の思考。部屋DO（src/index.ts）から毎ティック呼ばれ、人間と同じ形式の入力を返す。
// 受け取る情報は「自分の状態・味方の状態・自分の視界に入っている敵・自分が撃たれた方向」だけにして、
// どのレベルでも壁越しに敵を知ることがないようにする（レベル5の味方 bot との共有も、誰かが見た情報だけ）。
// Room に依存しないので、Node から直接読み込んでテストできる（スモークテストの前半）
import { TILE, isWallTile, angleDiff, lineOfSight, tankSpec } from "../public/shared.js";

export interface TankView {
  id: string; team: string; type: string;
  x: number; y: number; aim: number; hp: number; dead: boolean;
}
export interface BotInput { mx: number; my: number; aim: number; fire: boolean }
export interface Perception {
  self: TankView;
  allies: TankView[]; // 味方は人間と同じく常に位置がわかる
  enemies: TankView[]; // 自分の視界に入っている敵だけ
  hit: { dir: number; at: number } | null; // 最後に撃たれた方向（弾が飛んできた向き）と時刻
  now: number; // 秒
}
// 同じチームの bot で共有する発見情報（レベル5だけが読み書きする）
export interface TeamIntel { x: number; y: number; at: number }
export interface BotOptions {
  home: { x: number; y: number }; // 自陣（退避先）
  enemyHome: { x: number; y: number }; // 敵陣（巡回の目安。点対称マップなので誰でも知っている）
  intel: { last: TeamIntel | null }; // チームで共有する入れ物
  bulletSpeed: number;
}
interface Grid { map: string[]; w: number; h: number }
type Tile = [number, number];

// ===== 強さ（仕様書「bot」の難易度表） =====
// reaction：敵を見つけてから撃ち始めるまで（秒）。aimError：狙いのぶれの最大（ラジアン）
// retreatHp：この割合までHPが減ったら退避する（0なら退避しない）
export const BOT_LEVELS = {
  1: { name: "入門", reaction: 0.9, aimError: 0.3, retreatHp: 0, keepDistance: false, ambush: false, flank: false, lead: false, share: false },
  2: { name: "初級", reaction: 0.6, aimError: 0.2, retreatHp: 0.3, keepDistance: true, ambush: false, flank: false, lead: false, share: false },
  3: { name: "標準", reaction: 0.4, aimError: 0.12, retreatHp: 0.3, keepDistance: true, ambush: true, flank: false, lead: false, share: false },
  4: { name: "上級", reaction: 0.25, aimError: 0.06, retreatHp: 0.35, keepDistance: true, ambush: true, flank: true, lead: true, share: false },
  5: { name: "達人", reaction: 0.15, aimError: 0.03, retreatHp: 0.35, keepDistance: true, ambush: true, flank: true, lead: true, share: true },
} as const;
export type BotLevel = keyof typeof BOT_LEVELS;

const BOT = {
  arriveDist: 3, // 経路上の点に着いたとみなす距離（px）
  stuckSec: 1.2, // この時間ほとんど動けなければ経路を引き直す
  lookSweep: 0.9, // 巡回中に周囲を見回す振れ幅（ラジアン）
  lookSpeed: 1.6, // 見回す速さ
  fireCone: 0.12, // 砲塔の向きと狙いの差がこれ以内なら撃つ（ラジアン）
  aimJitterSec: 0.4, // 狙いのぶれを引き直す間隔
  strafeSec: 1.5, // 交戦中に横移動の向きを変える間隔
  memorySec: 6, // 見失った敵の位置を覚えている時間
  intelSec: 4, // 共有された発見情報を信じる時間
  hitMemorySec: 2, // 撃たれた方向へ振り向き続ける時間
  lostResetSec: 1, // これ以上見失ったら、再発見時に反応時間をやり直す
  ambushChance: 0.35, // 巡回の目的地に着いたとき待ち伏せする確率
  ambushSec: [3, 6], // 待ち伏せする時間の範囲
  flankTiles: 4, // 回り込むときに横へずらすタイル数
  repathSec: 1, // 追跡中に経路を引き直す間隔
};

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
const sameTile = (a: Tile, b: Tile) => a[0] === b[0] && a[1] === b[1];

type State = "patrol" | "ambush" | "engage" | "chase" | "retreat";
interface Memory { id: string; x: number; y: number; vx: number; vy: number; seenAt: number }

// ===== bot 本体 =====
export class Bot {
  level: BotLevel;
  grid: Grid;
  opts: BotOptions;
  rand: () => number; // テストで結果を固定できるよう差し替え可能にする
  state: State = "patrol";
  path: Tile[] = [];
  goal: Tile | null = null;
  pathAt = 0;
  lastMoveAt = 0;
  lastPos = { x: 0, y: 0 };
  memory: Memory | null = null; // 最後に見た敵
  spottedAt = 0; // いまの敵を見つけた時刻（反応時間の起点）
  jitter = 0; // 狙いのぶれ
  jitterAt = -Infinity;
  strafe = 1;
  strafeAt = 0;
  ambushUntil = 0;
  flank: { src: object; x: number; y: number } | null = null; // 回り込み先（発見情報ごとに一度だけ決める）

  constructor(level: number, grid: Grid, opts: BotOptions, rand: () => number = Math.random) {
    this.level = (level in BOT_LEVELS ? level : 3) as BotLevel;
    this.grid = grid;
    this.opts = opts;
    this.rand = rand;
  }

  get cfg() { return BOT_LEVELS[this.level]; }

  think(p: Perception): BotInput {
    const s = p.self;
    const target = this.observe(p);
    const hpRate = s.hp / tankSpec(s.type).hp;
    const threatened = target || (p.hit && p.now - p.hit.at < BOT.hitMemorySec);

    // 状態を決める：退避 → 交戦 → 追跡 → 待ち伏せ → 巡回 の順に優先
    if (this.cfg.retreatHp > 0 && hpRate <= this.cfg.retreatHp && threatened) this.state = "retreat";
    else if (target) this.state = "engage";
    else if (this.chaseGoal(p)) this.state = "chase";
    else if (this.state === "ambush" && p.now < this.ambushUntil) this.state = "ambush";
    else if (this.state !== "patrol") { this.state = "patrol"; this.path = []; }

    let move = { mx: 0, my: 0 };
    let aim = s.aim;
    let fire = false;

    if (target) {
      aim = this.aimAt(s, target, p.now);
      const ready = p.now - this.spottedAt >= this.cfg.reaction;
      const aligned = Math.abs(angleDiff(s.aim, aim)) < BOT.fireCone;
      fire = ready && aligned && lineOfSight(this.grid, s.x, s.y, target.x, target.y);
    } else if (p.hit && p.now - p.hit.at < BOT.hitMemorySec) {
      aim = p.hit.dir; // 見えない相手に撃たれたら、撃たれた方向を向く
    }

    switch (this.state) {
      case "retreat":
        move = this.goTo(s, this.opts.home, p.now);
        break;
      case "engage":
        move = this.engageMove(s, target!, p.now);
        break;
      case "chase": {
        const g = this.chaseGoal(p)!;
        move = this.goTo(s, g, p.now);
        if (!target && !(p.hit && p.now - p.hit.at < BOT.hitMemorySec)) aim = Math.atan2(g.y - s.y, g.x - s.x);
        break;
      }
      case "ambush":
        // その場で敵陣の方向を見張る（少しだけ首を振る）
        if (!target) {
          const toward = Math.atan2(this.opts.enemyHome.y - s.y, this.opts.enemyHome.x - s.x);
          aim = toward + Math.sin(p.now * BOT.lookSpeed) * BOT.lookSweep * 0.5;
        }
        break;
      case "patrol": {
        if (!this.path.length || this.isStuck(p)) {
          // 目的地に着いたら、レベル3以上はときどき待ち伏せする
          if (this.goal && this.cfg.ambush && sameTile(toTile(s.x, s.y), this.goal) && this.rand() < BOT.ambushChance) {
            const [lo, hi] = BOT.ambushSec;
            this.state = "ambush";
            this.ambushUntil = p.now + lo + this.rand() * (hi - lo);
            this.goal = null;
            break;
          }
          this.setPath(s, this.patrolGoal(s), p.now);
        }
        move = this.follow(s);
        if (!target && !(p.hit && p.now - p.hit.at < BOT.hitMemorySec)) {
          // 進む方向を中心に首を振り、扇形視界の死角を減らす
          const heading = move.mx || move.my ? Math.atan2(move.my, move.mx) : s.aim;
          aim = heading + Math.sin(p.now * BOT.lookSpeed + s.x * 0.01) * BOT.lookSweep;
        }
        break;
      }
    }
    return { ...move, aim, fire };
  }

  // 視界に入った敵から狙う相手を選び、記憶と共有情報を更新する
  observe(p: Perception): TankView | null {
    const s = p.self;
    const alive = p.enemies.filter((e) => !e.dead);
    if (!alive.length) return null;
    // レベル4以上は倒しやすい相手（HPが低い）を、それ以外は近い相手を狙う
    const score = (e: TankView) =>
      this.cfg.flank ? e.hp / tankSpec(e.type).hp : Math.hypot(e.x - s.x, e.y - s.y);
    const t = alive.reduce((a, b) => (score(b) < score(a) ? b : a));
    const m = this.memory;
    if (!m || m.id !== t.id || p.now - m.seenAt > BOT.lostResetSec) this.spottedAt = p.now;
    const dt = m && m.id === t.id ? p.now - m.seenAt : 0;
    this.memory = {
      id: t.id, x: t.x, y: t.y,
      vx: dt > 0 ? (t.x - m!.x) / dt : 0, vy: dt > 0 ? (t.y - m!.y) / dt : 0,
      seenAt: p.now,
    };
    if (this.cfg.share) this.opts.intel.last = { x: t.x, y: t.y, at: p.now };
    return t;
  }

  // 狙う向き：レベル4以上は相手の移動を先読みする。ぶれは一定間隔で引き直す
  aimAt(s: TankView, t: TankView, now: number): number {
    let tx = t.x, ty = t.y;
    if (this.cfg.lead && this.memory) {
      const time = Math.hypot(t.x - s.x, t.y - s.y) / this.opts.bulletSpeed;
      tx += this.memory.vx * time;
      ty += this.memory.vy * time;
    }
    if (now - this.jitterAt > BOT.aimJitterSec) {
      this.jitter = (this.rand() * 2 - 1) * this.cfg.aimError;
      this.jitterAt = now;
    }
    return Math.atan2(ty - s.y, tx - s.x) + this.jitter;
  }

  // 交戦中の動き：レベル1は突っ込む。レベル2以上は距離を保ちながら横に動く
  engageMove(s: TankView, t: TankView, now: number) {
    const range = tankSpec(s.type).range;
    const dx = t.x - s.x, dy = t.y - s.y, d = Math.hypot(dx, dy) || 1;
    if (!this.cfg.keepDistance) return d > 40 ? this.goTo(s, t, now) : { mx: 0, my: 0 };
    if (d > range * 0.7) return this.goTo(s, t, now);
    if (now - this.strafeAt > BOT.strafeSec) { this.strafe = this.rand() < 0.5 ? -1 : 1; this.strafeAt = now; }
    const back = d < range * 0.4 ? -1 : 0; // 近すぎたら下がる
    const vx = (-dy / d) * this.strafe + (dx / d) * back;
    const vy = (dx / d) * this.strafe + (dy / d) * back;
    return { mx: Math.abs(vx) > 0.38 ? Math.sign(vx) : 0, my: Math.abs(vy) > 0.38 ? Math.sign(vy) : 0 };
  }

  // 追跡先：自分の記憶 → （レベル5）味方 bot の発見情報。レベル4以上は横から回り込む
  chaseGoal(p: Perception): { x: number; y: number } | null {
    let g: { x: number; y: number } | null = null;
    if (this.memory && p.now - this.memory.seenAt < BOT.memorySec) g = this.memory;
    else if (this.cfg.share && this.opts.intel.last && p.now - this.opts.intel.last.at < BOT.intelSec) g = this.opts.intel.last;
    if (!g) return null;
    const s = p.self;
    // 見失った場所に着いても何もいなければ、その情報は捨てて巡回に戻る
    if (Math.hypot(g.x - s.x, g.y - s.y) < TILE) {
      if (g === this.memory) this.memory = null;
      else this.opts.intel.last = null;
      return null;
    }
    if (!this.cfg.flank) return g;
    const dx = g.x - s.x, dy = g.y - s.y, d = Math.hypot(dx, dy) || 1;
    if (d < TILE * 3) return g;
    if (this.flank?.src !== g) {
      const side = (this.rand() < 0.5 ? 1 : -1) * BOT.flankTiles * TILE;
      const fx = g.x + (-dy / d) * side, fy = g.y + (dx / d) * side;
      const ft = toTile(fx, fy);
      this.flank = isWallTile(this.grid, ft[0], ft[1]) ? { src: g, x: g.x, y: g.y } : { src: g, x: fx, y: fy };
    }
    // 回り込み先に着いたら、最後に見た場所そのものへ向かう
    if (Math.hypot(this.flank.x - s.x, this.flank.y - s.y) < TILE) this.flank = { src: g, x: g.x, y: g.y };
    return this.flank;
  }

  // 目的地（px）へ経路をたどる入力。目的地のタイルが変わったか、一定時間ごとに経路を引き直す
  goTo(s: TankView, g: { x: number; y: number }, now: number) {
    const to = toTile(g.x, g.y);
    if (!this.goal || !sameTile(this.goal, to) || now - this.pathAt > BOT.repathSec || !this.path.length) {
      this.setPath(s, to, now);
    }
    return this.follow(s);
  }

  setPath(s: TankView, to: Tile | null, now: number) {
    this.goal = to;
    this.pathAt = now;
    this.path = (to && findPath(this.grid, toTile(s.x, s.y), to)) || [];
    // 先頭はいま居るタイルなので外す（中心へ戻ろうとして往復しないように）
    if (this.path.length > 1) this.path.shift();
  }

  // 巡回の目的地：半分は敵陣寄り、半分はマップ全体からランダムな床タイル
  patrolGoal(s: TankView): Tile | null {
    for (let i = 0; i < 20; i++) {
      let to: Tile;
      if (this.rand() < 0.5) {
        const e = toTile(this.opts.enemyHome.x, this.opts.enemyHome.y);
        to = [e[0] + Math.floor((this.rand() - 0.5) * 16), e[1] + Math.floor((this.rand() - 0.5) * 16)];
      } else {
        to = [1 + Math.floor(this.rand() * (this.grid.w - 2)), 1 + Math.floor(this.rand() * (this.grid.h - 2))];
      }
      if (isWallTile(this.grid, to[0], to[1])) continue;
      const path = findPath(this.grid, toTile(s.x, s.y), to);
      if (path && path.length > 3) return to;
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
