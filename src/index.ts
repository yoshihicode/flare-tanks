import { DurableObject } from "cloudflare:workers";
// 移動・壁判定はクライアントの予測処理と同じコードを使う
import { TILE, TICK_MS, TANK, makeGrid, isWall as isWallAt, stepTank, canSeePoint, canSeeTank } from "../public/shared.js";

// ===== ゲーム定数（ステップ1の仮の値。戦車3種はステップ3で導入） =====
const MAX_PLAYERS = 6; // 1部屋の最大人数（3vs3）
const BULLET_SPEED = 180; // 弾速（px/秒）
const BULLET_LIFE = 1.5; // 弾の寿命（秒）
const FIRE_INTERVAL = 0.6; // 連射間隔（秒）
const DAMAGE = 25;
const MAX_HP = 100;
const RESPAWN_SEC = 3;

type Team = "A" | "B";
interface Input { mx: number; my: number; aim: number; fire: boolean }
interface Player {
  id: string; ws: WebSocket; team: Team;
  x: number; y: number; body: number; aim: number;
  hp: number; dead: boolean; respawnAt: number; cooldown: number;
  input: Input;
  seq: number; // 最後に受け取った入力の確認番号（クライアントの予測補正用に返す）
}
interface Bullet { x: number; y: number; vx: number; vy: number; life: number; team: Team }
// team：その出来事に関わる戦車のチーム（発射した側・被弾した側・弾の持ち主）。同じチームには常に送る
interface GameEvent { e: "fire" | "hit" | "kill" | "wall"; x: number; y: number; team: Team }

interface Env { ROOM: DurableObjectNamespace }

// ===== マップ（40×24タイル、点対称） =====
const MAP = buildMap();
const MAP_W = MAP[0].length;
const MAP_H = MAP.length;
const GRID = makeGrid(MAP);

function buildMap(): string[] {
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
  return g.map((r) => r.join(""));
}

const isWall = (px: number, py: number): boolean => isWallAt(GRID, px, py);

function spawnPoint(team: Team, i: number) {
  const tx = 3, ty = 10 + i * 2;
  const x = team === "A" ? tx : MAP_W - 1 - tx;
  const y = team === "A" ? ty : MAP_H - 1 - ty;
  return { x: x * TILE + TILE / 2, y: y * TILE + TILE / 2, body: team === "A" ? 0 : Math.PI };
}

const dir = (v: unknown) => (v === 1 || v === -1 ? v : 0);
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

// ===== Worker：/ws を部屋のDurable Objectへ振り分ける =====
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("WebSocket接続が必要です", { status: 426 });
      }
      const room = (url.searchParams.get("room") || "default").slice(0, 32);
      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      return stub.fetch(req);
    }
    return new Response("Not found", { status: 404 });
  },
};

// ===== Room：1部屋＝1インスタンス。判定はすべてここで行う =====
export class Room extends DurableObject<Env> {
  players = new Map<string, Player>();
  bullets: Bullet[] = [];
  events: GameEvent[] = [];
  timer: ReturnType<typeof setInterval> | null = null;

  async fetch(_req: Request): Promise<Response> {
    if (this.players.size >= MAX_PLAYERS) {
      return new Response("満員です", { status: 503 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const id = crypto.randomUUID().slice(0, 8);
    const p: Player = {
      id, ws: server, team: this.pickTeam(),
      x: 0, y: 0, body: 0, aim: 0,
      hp: MAX_HP, dead: false, respawnAt: 0, cooldown: 0,
      input: { mx: 0, my: 0, aim: 0, fire: false },
      seq: 0,
    };
    this.spawn(p);
    this.players.set(id, p);

    server.addEventListener("message", (ev) => this.onMessage(p, ev.data));
    const leave = () => {
      this.players.delete(id);
      if (this.players.size === 0) this.stopLoop();
    };
    server.addEventListener("close", leave);
    server.addEventListener("error", leave);

    server.send(JSON.stringify({ t: "init", id, tile: TILE, map: MAP }));
    this.startLoop();
    return new Response(null, { status: 101, webSocket: client });
  }

  pickTeam(): Team {
    let a = 0, b = 0;
    for (const p of this.players.values()) p.team === "A" ? a++ : b++;
    return a <= b ? "A" : "B";
  }

  spawn(p: Player) {
    const s = spawnPoint(p.team, Math.floor(Math.random() * 3));
    Object.assign(p, { x: s.x, y: s.y, body: s.body, aim: s.body, hp: MAX_HP, dead: false, cooldown: 0 });
  }

  onMessage(p: Player, data: unknown) {
    if (typeof data !== "string" || data.length > 200) return;
    let m: any;
    try { m = JSON.parse(data); } catch { return; }
    if (m?.t !== "in") return;
    p.input = {
      mx: dir(m.mx), my: dir(m.my),
      aim: Number.isFinite(m.aim) ? m.aim : p.input.aim,
      fire: m.fire === true,
    };
    if (Number.isInteger(m.q)) p.seq = m.q;
  }

  startLoop() {
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stopLoop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.bullets = [];
  }

  tick() {
    const now = Date.now() / 1000;
    const dt = TICK_MS / 1000;

    // 戦車の移動と射撃
    for (const p of this.players.values()) {
      if (p.dead) {
        if (now >= p.respawnAt) this.spawn(p);
        continue;
      }
      stepTank(GRID, p, p.input.mx, p.input.my, dt);
      p.aim = p.input.aim;
      p.cooldown = Math.max(0, p.cooldown - dt);
      if (p.input.fire && p.cooldown === 0) {
        p.cooldown = FIRE_INTERVAL;
        const bx = p.x + Math.cos(p.aim) * 10, by = p.y + Math.sin(p.aim) * 10;
        this.bullets.push({
          x: bx, y: by,
          vx: Math.cos(p.aim) * BULLET_SPEED, vy: Math.sin(p.aim) * BULLET_SPEED,
          life: BULLET_LIFE, team: p.team,
        });
        this.events.push({ e: "fire", x: r1(bx), y: r1(by), team: p.team });
      }
    }

    // 弾の移動と当たり判定（ステップ1ではフレンドリーファイアなし）
    this.bullets = this.bullets.filter((b) => {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      if (b.life <= 0) return false;
      if (isWall(b.x, b.y)) {
        this.events.push({ e: "wall", x: r1(b.x), y: r1(b.y), team: b.team });
        return false;
      }
      for (const p of this.players.values()) {
        if (p.dead || p.team === b.team) continue;
        if (Math.hypot(p.x - b.x, p.y - b.y) < TANK.r + 2) {
          p.hp -= DAMAGE;
          if (p.hp <= 0) {
            p.hp = 0;
            p.dead = true;
            p.respawnAt = now + RESPAWN_SEC;
            this.events.push({ e: "kill", x: r1(p.x), y: r1(p.y), team: p.team });
          } else {
            this.events.push({ e: "hit", x: r1(p.x), y: r1(p.y), team: p.team });
          }
          return false;
        }
      }
      return true;
    });

    // スナップショット送信：プレイヤーごとに視界で絞り込む
    const tanks = [...this.players.values()];
    for (const v of this.players.values()) {
      try { v.ws.send(this.snapshotFor(v, tanks)); } catch { /* 切断済みは close イベントで処理 */ }
    }
    this.events = [];
  }

  // 視点 v 用のスナップショット。見えない敵の座標・弾・出来事は含めない（チート対策）
  // 味方と味方の弾は常に含める。視点側が撃破中の間は、倒れた位置からの視界で判定する
  snapshotFor(v: Player, tanks: Player[]): string {
    const seen = (x: number, y: number) => canSeePoint(GRID, v, x, y);
    return JSON.stringify({
      t: "s",
      q: v.seq,
      tanks: tanks
        .filter((p) => p.team === v.team || (!p.dead && canSeeTank(GRID, v, p)))
        .map((p) => ({
          id: p.id, team: p.team, x: r1(p.x), y: r1(p.y),
          b: r2(p.body), a: r2(p.aim), hp: p.hp, dead: p.dead,
        })),
      bullets: this.bullets
        .filter((b) => b.team === v.team || seen(b.x, b.y))
        .map((b) => [Math.round(b.x), Math.round(b.y)]),
      ev: this.events
        .filter((e) => e.team === v.team || seen(e.x, e.y))
        .map(({ e, x, y }) => ({ e, x, y })),
    });
  }
}
