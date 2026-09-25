import { DurableObject } from "cloudflare:workers";
// 移動・壁判定・視界はクライアントの予測処理と同じコードを使う
import {
  TILE, TICK_MS, TANK_TYPES, DEFAULT_TANK, tankSpec, makeGrid, isWall as isWallAt,
  stepTank, turnTurret, canSeePoint, canSeeTank,
} from "../public/shared.js";
import { Bot } from "./bot.ts";

// ===== ゲーム定数（車種ごとの性能は public/shared.js の TANK_TYPES） =====
const TEAM_SIZE = 3; // 1チームの台数（3vs3）。空いた枠は bot が埋める
const BULLET_SPEED = 180; // 弾速（px/秒）
const BULLET_LIFE = 1.5; // 弾の寿命（秒）
const RESPAWN_SEC = 3;
const BOT_LEVEL_DEFAULT = 3; // bot の強さ（1〜5）。部屋を作った人の指定がなければこれ
// bot の枠の車種（チームごとに同じ並び）
const BOT_TYPES: TankType[] = ["medium", "light", "heavy"];

type Team = "A" | "B";
type TankType = keyof typeof TANK_TYPES;
const TEAMS: Team[] = ["A", "B"];
const toTankType = (v: unknown): TankType =>
  typeof v === "string" && v in TANK_TYPES ? (v as TankType) : (DEFAULT_TANK as TankType);

interface Input { mx: number; my: number; aim: number; fire: boolean }
// 戦車（6枠）。人間が操作していない間は bot が操作する
interface Tank {
  id: string; team: Team; slot: number; type: TankType;
  x: number; y: number; body: number; aim: number;
  hp: number; dead: boolean; respawnAt: number; cooldown: number;
  input: Input;
  human: string | null; // 操作している接続のID
  bot: Bot | null;
}
// 人間の接続
interface Client {
  id: string; ws: WebSocket; team: Team; type: TankType;
  tank: Tank | null;
  seq: number; // 最後に受け取った入力の確認番号（クライアントの予測補正用に返す）
}
interface Bullet { x: number; y: number; vx: number; vy: number; life: number; team: Team; damage: number }
// team：その出来事に関わる戦車のチーム（発射した側・被弾した側・弾の持ち主）。同じチームには常に送る
interface GameEvent { e: "fire" | "hit" | "kill" | "wall"; x: number; y: number; team: Team }

interface Env {
  ROOM: DurableObjectNamespace;
  DEBUG_TOOLS?: string; // "1" のときだけデバッグ用コマンドを受け付ける（npm run dev で有効）
}

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
const IDLE: Input = { mx: 0, my: 0, aim: 0, fire: false };

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
  clients = new Map<string, Client>();
  tanks: Tank[] = [];
  bullets: Bullet[] = [];
  events: GameEvent[] = [];
  timer: ReturnType<typeof setInterval> | null = null;
  botLevel = BOT_LEVEL_DEFAULT;
  debug = { freezeBots: false };

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // 最初の1人が来たときに6枠を bot で用意する（部屋の設定は最初の人の指定を使う）
    if (this.clients.size === 0) this.setupRoom(Number(url.searchParams.get("bot")));
    const type = toTankType(url.searchParams.get("tank"));
    const team = this.pickTeam();
    const tank = this.tanks.find((t) => t.team === team && !t.human);
    if (!tank) return new Response("満員です", { status: 503 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const c: Client = { id: crypto.randomUUID().slice(0, 8), ws: server, team, type, tank: null, seq: 0 };
    this.clients.set(c.id, c);
    this.takeOver(c, tank);

    server.addEventListener("message", (ev) => this.onMessage(c, ev.data));
    const leave = () => this.leave(c);
    server.addEventListener("close", leave);
    server.addEventListener("error", leave);

    server.send(JSON.stringify({ t: "init", id: c.id, tile: TILE, map: MAP }));
    this.startLoop();
    return new Response(null, { status: 101, webSocket: client });
  }

  setupRoom(botLevel: number) {
    this.botLevel = Number.isInteger(botLevel) && botLevel >= 1 && botLevel <= 5 ? botLevel : BOT_LEVEL_DEFAULT;
    this.debug = { freezeBots: false };
    this.bullets = [];
    this.tanks = [];
    for (const team of TEAMS) {
      for (let slot = 0; slot < TEAM_SIZE; slot++) {
        const t: Tank = {
          id: `${team}${slot}`, team, slot, type: BOT_TYPES[slot],
          x: 0, y: 0, body: 0, aim: 0, hp: 0, dead: false, respawnAt: 0, cooldown: 0,
          input: { ...IDLE }, human: null, bot: new Bot(this.botLevel, GRID),
        };
        this.spawn(t);
        this.tanks.push(t);
      }
    }
  }

  // 人間の少ないチームへ入れる（同数ならA）
  pickTeam(): Team {
    const n = { A: 0, B: 0 };
    for (const c of this.clients.values()) n[c.team]++;
    const team: Team = n.A <= n.B ? "A" : "B";
    // そのチームに空き枠がなければ反対側
    return this.tanks.some((t) => t.team === team && !t.human) ? team : team === "A" ? "B" : "A";
  }

  // 人間が bot の枠を引き継ぐ。車種が違えば選んだ車種に乗り換えて出撃し直す
  takeOver(c: Client, t: Tank) {
    t.human = c.id;
    t.bot = null;
    t.input = { ...IDLE, aim: t.aim };
    c.tank = t;
    if (t.type !== c.type) {
      t.type = c.type;
      this.spawn(t);
    }
  }

  // 切断：操作していた戦車はその場で bot が引き継ぐ。人間が0人になったら部屋を止める
  leave(c: Client) {
    if (!this.clients.delete(c.id)) return;
    if (c.tank) {
      c.tank.human = null;
      c.tank.bot = new Bot(this.botLevel, GRID);
      c.tank.input = { ...IDLE, aim: c.tank.aim };
    }
    if (this.clients.size === 0) this.stopLoop();
  }

  spawn(t: Tank) {
    const s = spawnPoint(t.team, t.slot);
    Object.assign(t, { x: s.x, y: s.y, body: s.body, aim: s.body, hp: tankSpec(t.type).hp, dead: false, cooldown: 0 });
  }

  onMessage(c: Client, data: unknown) {
    if (typeof data !== "string" || data.length > 200) return;
    let m: any;
    try { m = JSON.parse(data); } catch { return; }
    if (m?.t === "dbg") return this.onDebug(m);
    if (m?.t !== "in" || !c.tank) return;
    c.tank.input = {
      mx: dir(m.mx), my: dir(m.my),
      aim: Number.isFinite(m.aim) ? m.aim : c.tank.input.aim,
      fire: m.fire === true,
    };
    if (Number.isInteger(m.q)) c.seq = m.q;
  }

  // 開発時だけ使えるテスト用コマンド（スモークテストで状況を作るため）
  onDebug(m: any) {
    if (this.env.DEBUG_TOOLS !== "1") return;
    if (typeof m.freezeBots === "boolean") this.debug.freezeBots = m.freezeBots;
  }

  startLoop() {
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stopLoop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tanks = [];
    this.bullets = [];
  }

  // bot の入力を決める。渡すのは味方の状態と「その bot の視界に入っている敵」だけ
  thinkBots(now: number) {
    for (const t of this.tanks) {
      if (!t.bot || t.dead) continue;
      if (this.debug.freezeBots) { t.input = { ...IDLE, aim: t.aim }; continue; }
      const enemies = this.tanks.filter((e) => e.team !== t.team && !e.dead && canSeeTank(GRID, t, e));
      const allies = this.tanks.filter((a) => a.team === t.team && a !== t);
      t.input = t.bot.think({ self: t, allies, enemies, now });
    }
  }

  tick() {
    const now = Date.now() / 1000;
    const dt = TICK_MS / 1000;
    this.thinkBots(now);

    // 戦車の移動と射撃（人間も bot も同じ処理）
    for (const t of this.tanks) {
      if (t.dead) {
        if (now >= t.respawnAt) this.spawn(t);
        continue;
      }
      stepTank(GRID, t, t.input.mx, t.input.my, dt);
      // 砲塔は入力の向きへ、車種ごとの旋回速度の上限で回す
      t.aim = turnTurret(t.type, t.aim, t.input.aim, dt);
      t.cooldown = Math.max(0, t.cooldown - dt);
      if (t.input.fire && t.cooldown === 0) {
        const spec = tankSpec(t.type);
        t.cooldown = spec.fireInterval;
        const bx = t.x + Math.cos(t.aim) * 10, by = t.y + Math.sin(t.aim) * 10;
        this.bullets.push({
          x: bx, y: by,
          vx: Math.cos(t.aim) * BULLET_SPEED, vy: Math.sin(t.aim) * BULLET_SPEED,
          life: BULLET_LIFE, team: t.team, damage: spec.damage,
        });
        this.events.push({ e: "fire", x: r1(bx), y: r1(by), team: t.team });
      }
    }

    // 弾の移動と当たり判定（フレンドリーファイアの設定はステップ5で追加）
    this.bullets = this.bullets.filter((b) => {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      if (b.life <= 0) return false;
      if (isWall(b.x, b.y)) {
        this.events.push({ e: "wall", x: r1(b.x), y: r1(b.y), team: b.team });
        return false;
      }
      for (const t of this.tanks) {
        if (t.dead || t.team === b.team) continue;
        if (Math.hypot(t.x - b.x, t.y - b.y) < tankSpec(t.type).r + 2) {
          t.hp = Math.max(0, t.hp - b.damage);
          if (t.hp === 0) {
            t.dead = true;
            t.respawnAt = now + RESPAWN_SEC;
            this.events.push({ e: "kill", x: r1(t.x), y: r1(t.y), team: t.team });
          } else {
            this.events.push({ e: "hit", x: r1(t.x), y: r1(t.y), team: t.team });
          }
          return false;
        }
      }
      return true;
    });

    // スナップショット送信：人間ごとに視界で絞り込む（bot には送らない）
    for (const c of this.clients.values()) {
      try { c.ws.send(this.snapshotFor(c)); } catch { /* 切断済みは close イベントで処理 */ }
    }
    this.events = [];
  }

  // 接続 c 用のスナップショット。見えない敵の座標・弾・出来事は含めない（チート対策）
  // 味方と味方の弾は常に含める。自分が撃破中の間は、倒れた位置からの視界で判定する
  snapshotFor(c: Client): string {
    const v = c.tank!;
    const seen = (x: number, y: number) => canSeePoint(GRID, v, x, y);
    return JSON.stringify({
      t: "s",
      q: c.seq,
      me: v.id,
      tanks: this.tanks
        .filter((t) => t.team === v.team || (!t.dead && canSeeTank(GRID, v, t)))
        .map((t) => ({
          id: t.id, team: t.team, k: t.type, x: r1(t.x), y: r1(t.y),
          b: r2(t.body), a: r2(t.aim), hp: t.hp, dead: t.dead, bot: t.bot ? 1 : 0,
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
