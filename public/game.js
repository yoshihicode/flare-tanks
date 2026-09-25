import { TILE, makeGrid, isWall, stepTank } from "./shared.js";

// ===== 画面設定：320×180で描画して整数倍に拡大 =====
const W = 320, H = 180;
const cv = document.getElementById("c");
const ctx = cv.getContext("2d");
const overlay = document.getElementById("overlay");
const msg = document.getElementById("msg");

const PALETTE = {
  floorA: "#1b2419", floorB: "#1f2a1c",
  wall: "#6d6a5c", wallTop: "#8f8b78", wallShade: "#4a483e",
  tread: "#1a1a17",
  A: "#5ad1c8", B: "#e8506a",
  bullet: "#ffe08a", flare: "#ffb347",
  hpBack: "#3a1d1d", hpFore: "#7bd66b",
};

function fit() {
  const s = Math.max(1, Math.floor(Math.min(innerWidth / W, innerHeight / H)));
  cv.style.width = W * s + "px";
  cv.style.height = H * s + "px";
}
addEventListener("resize", fit);
fit();

// ===== 状態 =====
let ws = null, myId = null, map = [], grid = null;
let prev = null, curr = null, currAt = 0;
let audio = null;
const keys = new Set();
const mouse = { x: W / 2 + 30, y: H / 2, down: false };
let lastSentKey = "", lastSentAt = 0;
const cam = { x: 0, y: 0 };

// ===== 開始・接続 =====
overlay.addEventListener("click", start);
overlay.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") start(); });

function start() {
  // iOS対策：ユーザー操作の中で音を有効化する
  if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
  audio.resume();
  overlay.style.display = "none";
  connect();
}

function showOverlay(text) {
  msg.textContent = text;
  overlay.style.display = "flex";
}

function connect() {
  const room = new URLSearchParams(location.search).get("room") || "default";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(room)}`);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === "init") {
      myId = m.id; map = m.map; grid = makeGrid(map); prev = curr = null;
    } else if (m.t === "s") {
      prev = curr; curr = m; currAt = performance.now();
      m.ev.forEach(playEvent);
    }
  };
  ws.onclose = () => {
    ws = null;
    showOverlay("接続が切れました。部屋が満員の場合もあります。クリックで再接続");
  };
}

// ===== 入力 =====
const KEYMAP = {
  KeyW: "up", ArrowUp: "up", KeyS: "down", ArrowDown: "down",
  KeyA: "left", ArrowLeft: "left", KeyD: "right", ArrowRight: "right",
};
addEventListener("keydown", (e) => {
  if (KEYMAP[e.code]) { keys.add(KEYMAP[e.code]); e.preventDefault(); }
  if (e.code === "Space") { mouse.down = true; e.preventDefault(); }
});
addEventListener("keyup", (e) => {
  if (KEYMAP[e.code]) keys.delete(KEYMAP[e.code]);
  if (e.code === "Space") mouse.down = false;
});
addEventListener("mousemove", (e) => {
  const r = cv.getBoundingClientRect();
  mouse.x = ((e.clientX - r.left) * W) / r.width;
  mouse.y = ((e.clientY - r.top) * H) / r.height;
});
addEventListener("mousedown", (e) => { if (e.button === 0 && ws) mouse.down = true; });
addEventListener("mouseup", (e) => { if (e.button === 0) mouse.down = false; });
addEventListener("contextmenu", (e) => e.preventDefault());
addEventListener("blur", () => { keys.clear(); mouse.down = false; });

function sendInput(me) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const mx = (keys.has("right") ? 1 : 0) - (keys.has("left") ? 1 : 0);
  const my = (keys.has("down") ? 1 : 0) - (keys.has("up") ? 1 : 0);
  let aim = 0;
  if (me) aim = Math.atan2(mouse.y - (me.y - cam.y), mouse.x - (me.x - cam.x));
  const fire = mouse.down;
  // 変化したときだけ、最短50ms間隔で送る（無料枠の節約）
  const key = `${mx},${my},${Math.round(aim * 40)},${fire}`;
  const now = performance.now();
  if (key === lastSentKey || now - lastSentAt < 50) return;
  ws.send(JSON.stringify({ t: "in", mx, my, aim: Math.round(aim * 1000) / 1000, fire }));
  lastSentKey = key;
  lastSentAt = now;
}

// ===== 補間 =====
const lerp = (a, b, t) => a + (b - a) * t;
function lerpAngle(a, b, t) {
  const d = ((((b - a) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return a + d * t;
}
function interpolatedTanks() {
  if (!curr) return [];
  const t = Math.min(1, (performance.now() - currAt) / 50);
  const before = new Map((prev ? prev.tanks : []).map((k) => [k.id, k]));
  return curr.tanks.map((k) => {
    const p = before.get(k.id);
    if (!p || p.dead !== k.dead) return k;
    return { ...k, x: lerp(p.x, k.x, t), y: lerp(p.y, k.y, t), b: lerpAngle(p.b, k.b, t), a: lerpAngle(p.a, k.a, t) };
  });
}

// ===== 描画 =====
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const snap8 = (a) => Math.round(a / (Math.PI / 4)) * (Math.PI / 4);

function drawMap() {
  const tx0 = Math.floor(cam.x / TILE), ty0 = Math.floor(cam.y / TILE);
  const tx1 = Math.ceil((cam.x + W) / TILE), ty1 = Math.ceil((cam.y + H) / TILE);
  for (let ty = ty0; ty < ty1; ty++) {
    for (let tx = tx0; tx < tx1; tx++) {
      if (!map[ty] || map[ty][tx] === undefined) continue;
      const x = tx * TILE - cam.x, y = ty * TILE - cam.y;
      if (map[ty][tx] === "#") {
        ctx.fillStyle = PALETTE.wall; ctx.fillRect(x, y, TILE, TILE);
        ctx.fillStyle = PALETTE.wallTop; ctx.fillRect(x, y, TILE, 2);
        ctx.fillStyle = PALETTE.wallShade; ctx.fillRect(x, y + TILE - 2, TILE, 2);
      } else {
        ctx.fillStyle = (tx + ty) & 1 ? PALETTE.floorA : PALETTE.floorB;
        ctx.fillRect(x, y, TILE, TILE);
      }
    }
  }
}

function drawTank(k, isMe) {
  const x = Math.round(k.x - cam.x), y = Math.round(k.y - cam.y);
  // 車体（8方向にスナップしてドット感を保つ）
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(snap8(k.b));
  ctx.fillStyle = PALETTE.tread;
  ctx.fillRect(-6, -6, 12, 3);
  ctx.fillRect(-6, 3, 12, 3);
  ctx.fillStyle = PALETTE[k.team];
  ctx.fillRect(-5, -4, 10, 8);
  ctx.restore();
  // 砲塔
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(k.a);
  ctx.fillStyle = "#e9e4d4";
  ctx.fillRect(0, -1, 9, 2);
  ctx.fillStyle = isMe ? PALETTE.flare : "#e9e4d4";
  ctx.fillRect(-2, -2, 4, 4);
  ctx.restore();
  // HPバー
  ctx.fillStyle = PALETTE.hpBack; ctx.fillRect(x - 6, y - 10, 12, 2);
  ctx.fillStyle = isMe ? PALETTE.flare : PALETTE.hpFore;
  ctx.fillRect(x - 6, y - 10, Math.round((12 * k.hp) / 100), 2);
}

function drawHud(me) {
  ctx.font = "8px DotGothic16, monospace";
  ctx.textBaseline = "top";
  const a = curr.tanks.filter((k) => k.team === "A").length;
  const b = curr.tanks.length - a;
  ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fillRect(0, 0, W, 12);
  ctx.fillStyle = PALETTE.A; ctx.fillText(`A ${a}`, 4, 2);
  ctx.fillStyle = PALETTE.B; ctx.fillText(`B ${b}`, 30, 2);
  if (me) {
    ctx.fillStyle = PALETTE.flare;
    ctx.fillText(`HP ${me.hp}`, W - 40, 2);
    if (me.dead) {
      ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(0, H / 2 - 10, W, 20);
      ctx.fillStyle = PALETTE.flare;
      ctx.textAlign = "center"; ctx.fillText("撃破されました　まもなく復活します", W / 2, H / 2 - 4);
      ctx.textAlign = "left";
    }
  }
}

function frame() {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (!curr || !map.length) {
    requestAnimationFrame(frame);
    return;
  }
  const tanks = interpolatedTanks();
  const me = tanks.find((k) => k.id === myId);
  const mapW = map[0].length * TILE, mapH = map.length * TILE;
  if (me) {
    cam.x = clamp(Math.round(me.x - W / 2), 0, mapW - W);
    cam.y = clamp(Math.round(me.y - H / 2), 0, mapH - H);
  }
  sendInput(me);
  drawMap();
  ctx.fillStyle = PALETTE.bullet;
  for (const [bx, by] of curr.bullets) ctx.fillRect(Math.round(bx - cam.x) - 1, Math.round(by - cam.y) - 1, 2, 2);
  for (const k of tanks) if (!k.dead) drawTank(k, k.id === myId);
  drawHud(me);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ===== 効果音（Web Audio APIで合成） =====
function tone(f1, f2, dur, type, vol) {
  const t = audio.currentTime;
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f1, t);
  o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  g.gain.setValueAtTime(0.18 * vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(audio.destination);
  o.start(t);
  o.stop(t + dur);
}

function noise(dur, vol) {
  const len = Math.floor(audio.sampleRate * dur);
  const buf = audio.createBuffer(1, len, audio.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = audio.createBufferSource(), g = audio.createGain();
  src.buffer = buf;
  g.gain.value = 0.25 * vol;
  src.connect(g).connect(audio.destination);
  src.start();
}

function playEvent(e) {
  if (!audio || !curr) return;
  const me = curr.tanks.find((k) => k.id === myId);
  const dist = me ? Math.hypot(me.x - e.x, me.y - e.y) : 0;
  const vol = Math.max(0, 1 - dist / 260); // 遠いほど小さく
  if (vol <= 0) return;
  if (e.e === "fire") tone(880, 220, 0.08, "square", vol);
  else if (e.e === "wall") tone(200, 80, 0.05, "square", vol * 0.5);
  else if (e.e === "hit") noise(0.12, vol);
  else if (e.e === "kill") { noise(0.45, vol); tone(300, 40, 0.4, "sawtooth", vol); }
}
