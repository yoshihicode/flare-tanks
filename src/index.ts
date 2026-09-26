import { DurableObject } from "cloudflare:workers";
// 移動・壁判定・視界はクライアントの予測処理と同じコードを使う
import {
  TILE, TICK_MS, TANK_TYPES, DEFAULT_TANK, tankSpec, makeGrid, isWall as isWallAt,
  stepTank, turnTurret, canSeePoint, canSeeTank,
} from "../public/shared.js";
import { Bot, type Pin } from "./bot.ts";
import { DEFAULT_SETTINGS, parseSettings, settingsFromQuery, type RoomSettings } from "./settings.ts";
import { GUEST, checkName, newGuestId, signToken, uniqueName, verifyToken } from "./guest.ts";

// ===== ゲーム定数（車種ごとの性能は public/shared.js の TANK_TYPES） =====
const TEAM_SIZE = 3; // 1チームの台数（3vs3）。空いた枠は bot が埋める
const BULLET_SPEED = 180; // 弾速（px/秒）
const BULLET_LIFE = 1.5; // 弾の寿命（秒）
// 殲滅モード（仕様書「ゲームモード」）。拠点制圧モードはステップ4で追加
const MATCH = {
  waitSec: 30, // 待機時間（部屋主は Enter ですぐ始められる）
  countdownSec: 3, // ラウンド開始前のカウントダウン
  roundSec: 600, // 1ラウンドの制限時間（10分）
  roundEndSec: 4, // ラウンド結果の表示時間
  matchEndSec: 8, // 試合結果の表示時間。その後は同じ部屋で次の試合の待機に戻る
  // Rounds to win come from the room settings (default 2); max rounds = 2 * winRounds - 1
};
// Conquest mode (spec "ゲームモード" / "拠点制圧のルール")
const CONQUEST = {
  roundSec: 480, // time limit (8 min); higher score wins on timeout
  target: 500, // first team to reach this score wins
  scorePerSec: 1, // points per second for each owned capture point
  captureSec: 5, // seconds for one team alone in the zone to go neutral -> owned (owned by enemy -> neutral takes the same)
  radius: 40, // capture zone radius (px, 2.5 tiles)
  respawnSec: 5, // respawn at own base after this delay
};
// "Enemy spotted" pins shared within a team (humans with a key, Lv5 bots automatically)
const PIN = {
  lifeSec: 6, // a pin disappears after this
  cooldownSec: 1, // one pin per tank per second at most; a new pin replaces the tank's previous one
};
// Gunfire hints: an unseen enemy's shot is sent only as a rough direction and distance, never coordinates
const HINT = {
  range: 480, // shots farther than this from the viewpoint are not heard
  sectors: 16, // direction is rounded to one of 16 sectors (22.5 deg)
  near: 160, // distance buckets: 0 = within near, 1 = within mid, 2 = beyond
  mid: 320,
};
type Phase = "wait" | "countdown" | "play" | "roundEnd" | "matchEnd";
type Result = Team | "draw";
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
  hp: number; dead: boolean; cooldown: number;
  respawnAt: number; // conquest only: time (s) to respawn after being destroyed
  pinAt: number; // when this tank last placed a pin
  hurt: number[]; // directions (toward the shooter) of hits taken this tick, sent to the tank's own player
  input: Input;
  human: string | null; // 操作している接続のID
  name: string | null; // display name of the human driving it (null for bots)
  bot: Bot | null;
  hit: { dir: number; at: number } | null; // 最後に撃たれた方向（bot が振り向くのに使う）
}
// 人間の接続
interface Client {
  id: string; ws: WebSocket; team: Team; type: TankType;
  gid: string; // guest ID from the signed token
  name: string; // display name, made unique within the room ("Yoshi(2)")
  tank: Tank | null; // null の間は観戦（対戦中に入った人は次のラウンドから参加）
  seq: number; // 最後に受け取った入力の確認番号（クライアントの予測補正用に返す）
}
interface Bullet { x: number; y: number; vx: number; vy: number; life: number; team: Team; damage: number; owner: string }
// team：その出来事に関わる戦車のチーム（発射した側・被弾した側・弾の持ち主）。同じチームには常に送る
// pub: public event sent to everyone regardless of vision (e.g. a capture point changing owner)
interface GameEvent { e: "fire" | "hit" | "kill" | "wall" | "cap"; x: number; y: number; team: Team; pub?: boolean }
// Capture point. cap runs from -1 (owned by B) to +1 (owned by A)
interface CapturePoint { id: string; x: number; y: number; cap: number; owner: Team | null; contested: boolean }

interface Env {
  ROOM: DurableObjectNamespace;
  GUEST_SECRET?: string; // signs guest tokens. Dev: set by npm run dev. Production: wrangler secret put GUEST_SECRET
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

// Capture point markers are part of the map data (ignored in elimination mode).
// C sits at the map center; A (team A side) and B are point-symmetric about it
const POINTS = (() => {
  const cx = (MAP_W * TILE) / 2, cy = (MAP_H * TILE) / 2;
  const a = { x: 12.5 * TILE, y: 5.5 * TILE };
  return [
    { id: "A", x: a.x, y: a.y },
    { id: "B", x: 2 * cx - a.x, y: 2 * cy - a.y },
    { id: "C", x: cx, y: cy },
  ];
})();

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
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // Refuse to run without a signing secret rather than fall back to a guessable default
    if ((url.pathname === "/ws" || url.pathname.startsWith("/api/")) && !env.GUEST_SECRET) {
      return new Response("サーバーの設定が未完了です（GUEST_SECRET）", { status: 500 });
    }
    const secret = env.GUEST_SECRET!;

    // Issue (or renew) a guest token: {name, token?} -> {token, gid, name}. A valid token keeps its guest ID
    if (url.pathname === "/api/guest" && req.method === "POST") {
      const body = await req.text();
      if (body.length > 1000) return json({ error: "リクエストが大きすぎます" }, 413);
      let m: any;
      try { m = JSON.parse(body); } catch { return json({ error: "不正なリクエストです" }, 400); }
      const checked = checkName(m?.name);
      if ("error" in checked) return json({ error: checked.error }, 400);
      const gid = (await verifyToken(secret, m?.token)) ?? newGuestId();
      return json({ token: await signToken(secret, gid), gid, name: checked.name });
    }

    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("WebSocket接続が必要です", { status: 426 });
      }
      const gid = await verifyToken(secret, url.searchParams.get("token"));
      const checked = checkName(url.searchParams.get("name"));
      if (!gid || "error" in checked) return new Response("ゲストの確認に失敗しました", { status: 401 });
      const room = (url.searchParams.get("room") || "default").slice(0, 32);
      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      // The room trusts these headers: rooms are reachable only through this Worker
      const fwd = new Request(req);
      fwd.headers.set("X-Guest-Id", gid);
      fwd.headers.set("X-Guest-Name", encodeURIComponent(checked.name));
      return stub.fetch(fwd);
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
  settings: RoomSettings = DEFAULT_SETTINGS;
  get mode() { return this.settings.mode; }
  points: CapturePoint[] = [];
  score: Record<Team, number> = { A: 0, B: 0 };
  lastTickAt = 0; // wall-clock time of the previous tick (s)
  reserved = new Map<string, { tankId: string; until: number }>(); // guest ID -> tank held after a disconnect
  emptySince = 0; // when the last human left
  pins: Record<Team, Pin[]> = { A: [], B: [] };
  nextPinId = 1;
  debug = { freezeBots: false };
  // 試合の進行
  phase: Phase = "wait";
  phaseEndsAt = 0; // いまの段階が終わる時刻（秒）
  round = 1;
  wins: Record<Team, number> = { A: 0, B: 0 };
  roundResult: Result | null = null;
  matchResult: Result | null = null;

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const gid = req.headers.get("X-Guest-Id");
    const baseName = decodeURIComponent(req.headers.get("X-Guest-Name") || "");
    if (!gid || !baseName) return new Response("ゲストの確認に失敗しました", { status: 401 });
    // 最初の1人が来たときに6枠を bot で用意する（部屋の設定は最初の人の指定を使う）
    if (!this.tanks.length) this.setupRoom(settingsFromQuery(url.searchParams));
    const now = Date.now() / 1000;
    const type = toTankType(url.searchParams.get("tank"));

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    // Same guest connecting again (another tab, or a reconnect before the old socket noticed):
    // move the existing player over to the new socket and close the old one
    let c = [...this.clients.values()].find((x) => x.gid === gid);
    if (c) {
      const old = c.ws;
      c.ws = server;
      try { old.close(4000, "別の画面で接続しました"); } catch { /* already closed */ }
    } else {
      // A tank held for this guest after a recent disconnect is given back, even mid-round
      const held = this.reserved.get(gid);
      const tank = held && held.until > now ? this.tanks.find((t) => t.id === held.tankId && !t.human) : undefined;
      const team = tank ? tank.team : this.pickTeam();
      if (!team) { server.close(4003, "満員です"); return new Response(null, { status: 101, webSocket: client }); }
      const taken = new Set([...this.clients.values()].map((x) => x.name));
      c = { id: crypto.randomUUID().slice(0, 8), ws: server, team, type, gid, name: uniqueName(baseName, taken), tank: null, seq: 0 };
      this.clients.set(c.id, c);
      this.reserved.delete(gid);
      if (tank) this.takeOver(c, tank, true);
      // 対戦が始まる前なら bot の枠をすぐ引き継ぐ。対戦中は観戦して次のラウンドから参加する
      // Conquest mode has no spectating: late joiners replace a bot immediately
      else if (this.phase === "wait" || this.phase === "countdown" || this.mode === "conquest") this.seat(c);
    }

    const me = c;
    server.addEventListener("message", (ev) => { if (me.ws === server) this.onMessage(me, ev.data); });
    // Only the socket currently attached to the player counts as leaving
    const leave = () => { if (me.ws === server) this.leave(me); };
    server.addEventListener("close", leave);
    server.addEventListener("error", leave);

    server.send(JSON.stringify({ t: "init", id: c.id, name: c.name, tile: TILE, map: MAP, ...this.config() }));
    this.startLoop();
    return new Response(null, { status: 101, webSocket: client });
  }

  // Settings and the capture points they imply; sent in init and whenever the owner changes settings
  config() {
    return {
      settings: this.settings,
      points: this.mode === "conquest" ? POINTS.map((p) => ({ ...p, r: CONQUEST.radius })) : [],
    };
  }

  setupRoom(settings: RoomSettings) {
    this.settings = settings;
    this.debug = { freezeBots: false };
    this.newMatch(Date.now() / 1000);
    this.bullets = [];
    this.tanks = [];
    this.pins = { A: [], B: [] };
    for (const team of TEAMS) {
      for (let slot = 0; slot < TEAM_SIZE; slot++) {
        const t: Tank = {
          id: `${team}${slot}`, team, slot, type: BOT_TYPES[slot],
          x: 0, y: 0, body: 0, aim: 0, hp: 0, dead: false, cooldown: 0, respawnAt: 0, pinAt: -Infinity, hurt: [],
          input: { ...IDLE }, human: null, name: null, bot: null, hit: null,
        };
        t.bot = this.newBot(t);
        this.spawn(t);
        this.tanks.push(t);
      }
    }
  }

  newBot(t: Tank): Bot {
    const home = spawnPoint(t.team, 1);
    const enemyHome = spawnPoint(t.team === "A" ? "B" : "A", 1);
    return new Bot(this.settings.botLevel, GRID, { home, enemyHome, bulletSpeed: BULLET_SPEED });
  }

  // 人間の少ないチームへ入れる（同数ならA）。両チームとも人間で埋まっていれば null（満員）
  pickTeam(): Team | null {
    const n = { A: 0, B: 0 };
    for (const c of this.clients.values()) n[c.team]++;
    const team: Team = n.A <= n.B ? "A" : "B";
    const other: Team = team === "A" ? "B" : "A";
    if (n[team] < TEAM_SIZE) return team;
    return n[other] < TEAM_SIZE ? other : null;
  }

  // 観戦中の人をチームの bot 枠に座らせる
  seat(c: Client) {
    const t = this.tanks.find((t) => t.team === c.team && !t.human);
    if (t) this.takeOver(c, t);
  }

  // 部屋主：いちばん早く入った人（Map は追加順）
  get owner(): Client | undefined {
    return this.clients.values().next().value;
  }

  // 人間が bot の枠を引き継ぐ。車種が違えば選んだ車種に乗り換えて出撃し直す
  // keepType: reclaiming one's own tank after a reconnect keeps it exactly as it is
  takeOver(c: Client, t: Tank, keepType = false) {
    t.human = c.id;
    t.name = c.name;
    t.bot = null;
    t.input = { ...IDLE, aim: t.aim };
    c.tank = t;
    if (!keepType && t.type !== c.type) {
      t.type = c.type;
      this.spawn(t);
    }
  }

  // 切断：操作していた戦車はその場で bot が引き継ぐ。人間が0人になったら部屋を止める
  // The tank is also held for this guest for a while so they can reclaim it by reconnecting.
  // With no humans left the room keeps running until that window passes, then stops (see tick)
  leave(c: Client) {
    if (!this.clients.delete(c.id)) return;
    const now = Date.now() / 1000;
    if (c.tank) {
      c.tank.human = null;
      c.tank.name = null;
      c.tank.bot = this.newBot(c.tank);
      c.tank.input = { ...IDLE, aim: c.tank.aim };
      this.reserved.set(c.gid, { tankId: c.tank.id, until: now + GUEST.reserveSec });
    }
    if (this.clients.size === 0) this.emptySince = now;
  }

  spawn(t: Tank) {
    const s = spawnPoint(t.team, t.slot);
    Object.assign(t, { x: s.x, y: s.y, body: s.body, aim: s.body, hp: tankSpec(t.type).hp, dead: false, cooldown: 0, hit: null });
  }

  onMessage(c: Client, data: unknown) {
    if (typeof data !== "string" || data.length > 200) return;
    let m: any;
    try { m = JSON.parse(data); } catch { return; }
    if (m?.t === "dbg") return this.onDebug(m, c);
    // The owner may change room settings, but only while waiting (spec: mode is fixed during a match)
    if (m?.t === "settings") {
      if (c === this.owner && this.phase === "wait") this.applySettings(parseSettings(m.settings, this.settings));
      return;
    }
    // 部屋主は待機中にすぐ開始できる
    if (m?.t === "start") {
      if (c === this.owner && this.phase === "wait") this.startRound(Date.now() / 1000);
      return;
    }
    if (m?.t === "pin") {
      if (c.tank && Number.isFinite(m.x) && Number.isFinite(m.y)) this.addPin(c.tank, m.x, m.y, Date.now() / 1000);
      return;
    }
    if (m?.t !== "in" || !c.tank) return;
    c.tank.input = {
      mx: dir(m.mx), my: dir(m.my),
      aim: Number.isFinite(m.aim) ? m.aim : c.tank.input.aim,
      fire: m.fire === true,
    };
    if (Number.isInteger(m.q)) c.seq = m.q;
  }

  // 開発時だけ使えるテスト用コマンド（スモークテストで状況を作るため）
  onDebug(m: any, c: Client) {
    if (this.env.DEBUG_TOOLS !== "1") return;
    const now = Date.now() / 1000;
    if (typeof m.freezeBots === "boolean") this.debug.freezeBots = m.freezeBots;
    if (m.expireReserve === true) this.reserved.clear(); // pretend the reconnect window has passed
    if (Number.isFinite(m.phaseSec)) this.phaseEndsAt = now + m.phaseSec; // いまの段階の残り時間を変える
    if (m.killTeam === "A" || m.killTeam === "B") {
      for (const t of this.tanks) if (t.team === m.killTeam) { t.hp = 0; t.dead = true; t.respawnAt = now + CONQUEST.respawnSec; }
    }
    if ((m.hpTeam === "A" || m.hpTeam === "B") && Number.isInteger(m.hp)) {
      for (const t of this.tanks) if (t.team === m.hpTeam && !t.dead) t.hp = m.hp;
    }
    // Teleport the sender's own tank (to stand in a capture zone)
    if (c.tank && Number.isFinite(m.moveX) && Number.isFinite(m.moveY)) { c.tank.x = m.moveX; c.tank.y = m.moveY; }
    // Set scores directly, and hand a capture point to a team
    if (m.score && typeof m.score === "object") {
      for (const team of TEAMS) if (Number.isFinite(m.score[team])) this.score[team] = m.score[team];
    }
    const p = this.points.find((p) => p.id === m.own?.id);
    if (p && (m.own.team === "A" || m.own.team === "B")) { p.owner = m.own.team; p.cap = m.own.team === "A" ? 1 : -1; }
  }

  applySettings(next: RoomSettings) {
    const modeChanged = next.mode !== this.settings.mode;
    const levelChanged = next.botLevel !== this.settings.botLevel;
    this.settings = next;
    if (modeChanged) this.resetPoints();
    if (levelChanged) for (const t of this.tanks) if (t.bot) t.bot = this.newBot(t);
    const msg = JSON.stringify({ t: "cfg", ...this.config() });
    for (const c of this.clients.values()) {
      try { c.ws.send(msg); } catch { /* closed sockets are handled by the close event */ }
    }
  }

  // ===== 試合の進行（殲滅モード） =====
  newMatch(now: number) {
    this.phase = "wait";
    this.phaseEndsAt = now + MATCH.waitSec;
    this.round = 1;
    this.wins = { A: 0, B: 0 };
    this.roundResult = this.matchResult = null;
    this.resetPoints();
  }

  resetPoints() {
    this.score = { A: 0, B: 0 };
    this.points = this.mode === "conquest"
      ? POINTS.map((p) => ({ ...p, cap: 0, owner: null, contested: false }))
      : [];
  }

  // ラウンド開始：観戦中の人を座らせ、全車を自陣に戻してカウントダウン
  startRound(now: number) {
    for (const c of this.clients.values()) if (!c.tank) this.seat(c);
    this.pins = { A: [], B: [] };
    for (const t of this.tanks) {
      this.spawn(t);
      if (t.bot) t.bot = this.newBot(t); // 前のラウンドの記憶を持ち越さない
    }
    this.bullets = [];
    this.roundResult = null;
    this.resetPoints();
    this.phase = "countdown";
    this.phaseEndsAt = now + MATCH.countdownSec;
  }

  // 段階の切り替え。対戦中は毎ティック勝敗を判定する
  updatePhase(now: number) {
    if (this.phase === "play" && this.mode === "conquest") {
      // First to the target score wins; on timeout the higher score wins
      const { A, B } = this.score;
      if (A >= CONQUEST.target || B >= CONQUEST.target || now >= this.phaseEndsAt) {
        this.endMatch(now, A > B ? "A" : B > A ? "B" : "draw");
      }
      return;
    }
    if (this.phase === "play") {
      const alive = (team: Team) => this.tanks.filter((t) => t.team === team && !t.dead);
      const a = alive("A"), b = alive("B");
      if (!a.length || !b.length) {
        // 全滅した側の負け（同時に全滅したら引き分け）
        this.endRound(now, a.length ? "A" : b.length ? "B" : "draw");
      } else if (now >= this.phaseEndsAt) {
        // 時間切れは残りHPの合計が多い側の勝ち
        const hp = (ts: Tank[]) => ts.reduce((sum, t) => sum + t.hp, 0);
        this.endRound(now, hp(a) > hp(b) ? "A" : hp(b) > hp(a) ? "B" : "draw");
      }
      return;
    }
    if (now < this.phaseEndsAt) return;
    if (this.phase === "wait") this.startRound(now);
    else if (this.phase === "countdown") {
      this.phase = "play";
      this.phaseEndsAt = now + (this.mode === "conquest" ? CONQUEST.roundSec : MATCH.roundSec);
    }
    else if (this.phase === "roundEnd") {
      const win = this.settings.winRounds;
      const done = this.wins.A >= win || this.wins.B >= win || this.round >= win * 2 - 1;
      if (done) {
        this.endMatch(now, this.wins.A > this.wins.B ? "A" : this.wins.B > this.wins.A ? "B" : "draw");
      } else {
        this.round++;
        this.startRound(now);
      }
    } else if (this.phase === "matchEnd") this.newMatch(now);
  }

  endMatch(now: number, result: Result) {
    this.matchResult = result;
    this.phase = "matchEnd";
    this.phaseEndsAt = now + MATCH.matchEndSec;
  }

  // Capture progress: moves only while exactly one team has live tanks in the zone.
  // Contested (both teams present) or empty zones keep their progress
  updatePoints(dt: number) {
    for (const p of this.points) {
      const inside = (team: Team) =>
        this.tanks.some((t) => t.team === team && !t.dead && Math.hypot(t.x - p.x, t.y - p.y) <= CONQUEST.radius);
      const a = inside("A"), b = inside("B");
      p.contested = a && b;
      if (a !== b) {
        const before = p.owner;
        p.cap = Math.max(-1, Math.min(1, p.cap + (a ? 1 : -1) * (dt / CONQUEST.captureSec)));
        // Crossing zero neutralizes the enemy's point; reaching +-1 captures it
        if ((p.owner === "A" && p.cap <= 0) || (p.owner === "B" && p.cap >= 0)) p.owner = null;
        if (p.cap >= 1) p.owner = "A";
        if (p.cap <= -1) p.owner = "B";
        if (p.owner && p.owner !== before) this.events.push({ e: "cap", x: p.x, y: p.y, team: p.owner, pub: true });
      }
      if (p.owner) this.score[p.owner] += dt * CONQUEST.scorePerSec;
    }
  }

  // Place a pin for t's team (live tanks only, rate-limited, clamped to the map)
  addPin(t: Tank, x: number, y: number, now: number) {
    if (t.dead || now - t.pinAt < PIN.cooldownSec) return;
    t.pinAt = now;
    const list = this.pins[t.team].filter((p) => p.by !== t.id);
    list.push({
      id: this.nextPinId++, by: t.id, at: now,
      x: Math.max(0, Math.min(MAP_W * TILE, x)), y: Math.max(0, Math.min(MAP_H * TILE, y)),
    });
    this.pins[t.team] = list;
  }

  endRound(now: number, result: Result) {
    this.roundResult = result;
    if (result !== "draw") this.wins[result]++;
    this.phase = "roundEnd";
    this.phaseEndsAt = now + MATCH.roundEndSec;
  }

  startLoop() {
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stopLoop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.lastTickAt = 0;
    this.reserved.clear();
    this.tanks = [];
    this.bullets = [];
  }

  // bot の入力を決める。渡すのは味方の状態と「その bot の視界に入っている敵」だけ
  thinkBots(now: number) {
    // Capture point states are public, so every bot may use them (conquest mode only)
    const objectives = this.points.map((p) => ({ id: p.id, x: p.x, y: p.y, r: CONQUEST.radius, owner: p.owner, contested: p.contested }));
    for (const t of this.tanks) {
      if (!t.bot || t.dead) continue;
      if (this.debug.freezeBots) { t.input = { ...IDLE, aim: t.aim }; continue; }
      const enemies = this.tanks.filter((e) => e.team !== t.team && !e.dead && canSeeTank(GRID, t, e));
      const allies = this.tanks.filter((a) => a.team === t.team && a !== t);
      t.input = t.bot.think({ self: t, allies, enemies, hit: t.hit, now, objectives, pins: this.pins[t.team], ff: this.settings.ff });
      if (t.input.pin) this.addPin(t, t.input.pin.x, t.input.pin.y, now);
    }
  }

  tick() {
    const now = Date.now() / 1000;
    const dt = TICK_MS / 1000;
    // Movement uses the fixed step (same as client prediction), but capture progress and score use
    // real elapsed time: timers can fire a bit slower than 20Hz, and the time limit is wall-clock
    const realDt = this.lastTickAt ? Math.min(0.25, Math.max(0, now - this.lastTickAt)) : dt;
    this.lastTickAt = now;
    // Nobody came back within the reconnect window: close the room (spec: stop the DO with 0 humans)
    if (this.clients.size === 0 && now - this.emptySince > GUEST.reserveSec) return this.stopLoop();
    this.updatePhase(now);
    for (const team of TEAMS) this.pins[team] = this.pins[team].filter((p) => now - p.at < PIN.lifeSec);
    this.thinkBots(now);

    // 戦車の移動と射撃（人間も bot も同じ処理）。
    // 待機中は動けるが撃てない（ウォームアップ）。カウントダウンと結果表示の間は止まる
    const canMove = this.phase === "wait" || this.phase === "play";
    const canFire = this.phase === "play";
    if (this.phase === "play" && this.mode === "conquest") this.updatePoints(realDt);
    for (const t of this.tanks) {
      // Conquest: destroyed tanks come back at their own base after a delay
      if (t.dead && this.mode === "conquest" && this.phase === "play" && now >= t.respawnAt) this.spawn(t);
      if (t.dead || !canMove) continue;
      stepTank(GRID, t, t.input.mx, t.input.my, dt);
      // 砲塔は入力の向きへ、車種ごとの旋回速度の上限で回す
      t.aim = turnTurret(t.type, t.aim, t.input.aim, dt);
      t.cooldown = Math.max(0, t.cooldown - dt);
      if (canFire && t.input.fire && t.cooldown === 0) {
        const spec = tankSpec(t.type);
        t.cooldown = spec.fireInterval;
        const bx = t.x + Math.cos(t.aim) * 10, by = t.y + Math.sin(t.aim) * 10;
        this.bullets.push({
          x: bx, y: by,
          vx: Math.cos(t.aim) * BULLET_SPEED, vy: Math.sin(t.aim) * BULLET_SPEED,
          life: BULLET_LIFE, team: t.team, damage: spec.damage, owner: t.id,
        });
        this.events.push({ e: "fire", x: r1(bx), y: r1(by), team: t.team });
      }
    }

    // 弾の移動と当たり判定。Teammates are hit only with friendly fire on; a bullet never hits its shooter
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
        if (t.dead || t.id === b.owner || (t.team === b.team && !this.settings.ff)) continue;
        if (Math.hypot(t.x - b.x, t.y - b.y) < tankSpec(t.type).r + 2) {
          t.hp = Math.max(0, t.hp - b.damage);
          t.hit = { dir: Math.atan2(-b.vy, -b.vx), at: now };
          t.hurt.push(t.hit.dir);
          if (t.hp === 0) {
            t.dead = true; // 殲滅モードでは復活しない（次のラウンドで戻る）
            t.respawnAt = now + CONQUEST.respawnSec; // used only in conquest mode
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
      try { c.ws.send(this.snapshotFor(c, now)); } catch { /* 切断済みは close イベントで処理 */ }
    }
    this.events = [];
    for (const t of this.tanks) t.hurt = [];
  }

  // Unseen enemy shots heard from viewpoint v: rounded direction + distance bucket only
  shotHints(v: Tank) {
    const step = (Math.PI * 2) / HINT.sectors;
    return this.events
      .filter((e) => e.e === "fire" && e.team !== v.team && !canSeePoint(GRID, v, e.x, e.y))
      .flatMap((e) => {
        const d = Math.hypot(e.x - v.x, e.y - v.y);
        if (d > HINT.range) return [];
        const dir = r2(Math.round(Math.atan2(e.y - v.y, e.x - v.x) / step) * step);
        return [{ e: "shot", dir, d: d < HINT.near ? 0 : d < HINT.mid ? 1 : 2 }];
      });
  }

  // 視点にする戦車：自分の戦車が生きていればそれ。撃破中・観戦中は生きている味方（自チームの視点のみ）
  viewpoint(c: Client): Tank {
    if (c.tank && !c.tank.dead) return c.tank;
    return this.tanks.find((t) => t.team === c.team && !t.dead) ?? c.tank ?? this.tanks.find((t) => t.team === c.team)!;
  }

  // 接続 c 用のスナップショット。見えない敵の座標・弾・出来事は含めない（チート対策）
  // 味方と味方の弾は常に含める
  snapshotFor(c: Client, now: number): string {
    const v = this.viewpoint(c);
    const seen = (x: number, y: number) => canSeePoint(GRID, v, x, y);
    const alive = (team: Team) => this.tanks.filter((t) => t.team === team && !t.dead).length;
    return JSON.stringify({
      t: "s",
      q: c.seq,
      me: c.tank ? c.tank.id : null, // 自分の戦車（観戦中は null）
      view: v.id, // 視界の元にした戦車
      team: c.team,
      rs: c.tank?.dead && this.mode === "conquest" ? Math.max(0, Math.ceil(c.tank.respawnAt - now)) : 0, // seconds until respawn
      // 試合の状態（座標は含まないので全員に送る）
      g: {
        ph: this.phase, t: Math.max(0, Math.ceil(this.phaseEndsAt - now)), r: this.round,
        w: [this.wins.A, this.wins.B], wr: this.settings.winRounds, al: [alive("A"), alive("B")],
        rr: this.roundResult, mr: this.matchResult, owner: c === this.owner,
        mode: this.mode,
        // Conquest: scores and capture point states (no coordinates, so public)
        sc: [Math.floor(this.score.A), Math.floor(this.score.B)], tg: CONQUEST.target,
        pts: this.points.map((p) => ({ id: p.id, o: p.owner, p: r2(p.cap), c: p.contested })),
      },
      tanks: this.tanks
        .filter((t) => t.team === v.team || (!t.dead && canSeeTank(GRID, v, t)))
        .map((t) => ({
          id: t.id, team: t.team, k: t.type, n: t.name, x: r1(t.x), y: r1(t.y),
          b: r2(t.body), a: r2(t.aim), hp: t.hp, dead: t.dead, bot: t.bot ? 1 : 0,
        })),
      // Own team's pins only (placed by allies, so no hidden information)
      pins: this.pins[c.team].map((p) => ({ id: p.id, x: r1(p.x), y: r1(p.y), by: p.by, life: r1(PIN.lifeSec - (now - p.at)) })),
      bullets: this.bullets
        .filter((b) => b.team === v.team || seen(b.x, b.y))
        .map((b) => [Math.round(b.x), Math.round(b.y)]),
      ev: [
        ...this.events
          .filter((e) => e.pub || e.team === v.team || seen(e.x, e.y))
          // Public events keep their team (who captured); others drop it
          .map(({ e, x, y, team, pub }) => (pub ? { e, x, y, team } : { e, x, y })),
        ...this.shotHints(v),
      ],
      hurt: c.tank ? c.tank.hurt.map(r2) : [], // own tank only: where this tick's hits came from
    });
  }
}
