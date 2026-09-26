import { TILE, TANK_TYPES, DEFAULT_TANK, NEAR_VIEW, tankSpec, makeGrid, stepTank, turnTurret, visibilityPolygon } from "./shared.js";

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
  fog: "rgba(4, 7, 5, 0.78)", // 視界の外を覆う暗さ
};

// 文字（HUD）だけは画面の実際の解像度で描く重ねキャンバス。
// 320×180 に 8px の文字を描いて拡大すると漢字がつぶれるため。座標は 320×180 のまま使えるよう拡大率を掛けておく
const hudCv = document.getElementById("hud");
const hud = hudCv.getContext("2d");

function fit() {
  const s = Math.max(1, Math.floor(Math.min(innerWidth / W, innerHeight / H)));
  const k = s * (window.devicePixelRatio || 1);
  for (const c of [cv, hudCv]) {
    c.style.width = W * s + "px";
    c.style.height = H * s + "px";
  }
  hudCv.width = Math.round(W * k);
  hudCv.height = Math.round(H * k);
  hud.setTransform(k, 0, 0, k, 0, 0);
}
addEventListener("resize", fit);
fit();

// 視界の外を暗くするための重ね塗り用キャンバス
const fogCv = document.createElement("canvas");
fogCv.width = W; fogCv.height = H;
const fog = fogCv.getContext("2d");

// ===== 状態 =====
let ws = null, myId = null, map = [], grid = null;
let points = []; // capture points {id, x, y, r} (conquest mode only; states come in each snapshot)
const seenPins = new Set(); // pin ids already announced with a sound
let prev = null, curr = null, currAt = 0;
let audio = null;
const keys = new Set();
const mouse = { x: W / 2 + 30, y: H / 2, down: false };
let lastSentKey = "", lastSentAt = 0;
const cam = { x: 0, y: 0 };

// ===== 自機の予測処理 =====
// 入力をすぐ自機に反映し、サーバーの結果で少しずつ補正する
const PREDICT = {
  snapDist: 24, // これ以上ずれたら補正せず即座に合わせる（復活・大きなずれ）
  correct: 0.15, // スナップショット1回ごとに縮めるずれの割合
  historyMs: 1000, // 予測位置の履歴を残す長さ
};
let pred = null; // 予測中の自機 {x, y, body, aim, type}
let history = []; // [{t, x, y}] 過去の予測位置
let seq = 0; // 入力の確認番号
const sentAt = new Map(); // 確認番号 → 送信時刻
let rtt = 100; // 入力がサーバーに反映されて戻るまでの時間（ms、平滑化）
let lastFrameAt = performance.now();

// ===== 戦車の選択（タイトル画面） =====
const TANK_ORDER = ["light", "medium", "heavy"];
let tankType = DEFAULT_TANK;
try { const saved = localStorage.getItem("ft.tank"); if (saved in TANK_TYPES) tankType = saved; } catch { /* 保存できない環境では既定値 */ }
const tankButtons = document.getElementById("tanks");
for (const type of TANK_ORDER) {
  const s = TANK_TYPES[type];
  const btn = document.createElement("button");
  btn.type = "button";
  btn.dataset.type = type;
  btn.innerHTML = `<b>${s.name}</b><small>${s.role}<br>HP ${s.hp}・ダメージ ${s.damage}<br>視野角 ${Math.round((s.fov * 180) / Math.PI)}°</small>`;
  btn.addEventListener("click", (e) => { e.stopPropagation(); chooseTank(type); start(); });
  tankButtons.append(btn);
}
function chooseTank(type) {
  tankType = type;
  try { localStorage.setItem("ft.tank", type); } catch { /* 保存できなくても続行 */ }
  for (const b of tankButtons.children) b.setAttribute("aria-pressed", String(b.dataset.type === type));
}
chooseTank(tankType);

// ===== 開始・接続 =====
overlay.addEventListener("click", start);
addEventListener("keydown", (e) => {
  if (overlay.style.display === "none") return;
  const i = ["Digit1", "Digit2", "Digit3"].indexOf(e.code);
  if (i >= 0) chooseTank(TANK_ORDER[i]);
  if (e.key === "Enter") start();
});

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
  const params = new URLSearchParams(location.search);
  const room = params.get("room") || "default";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // Room settings (?mode=, ?bot=) are passed through; the server uses them only from the first player
  const q = new URLSearchParams({ room, tank: tankType });
  for (const key of ["mode", "bot"]) if (params.has(key)) q.set(key, params.get(key));
  ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === "init") {
      myId = null; map = m.map; grid = makeGrid(map); prev = curr = null;
      points = m.points || [];
      pred = null; history = []; sentAt.clear();
    } else if (m.t === "s") {
      if (curr && curr.g.ph !== m.g.ph) playPhase(m.g, m.team);
      for (const pin of m.pins) {
        if (seenPins.has(pin.id)) continue;
        seenPins.add(pin.id);
        if (audio && curr) tone(1200, 1500, 0.08, "square", 0.5); // new pin from the team (skip on first snapshot)
      }
      prev = curr; curr = m; currAt = performance.now();
      myId = m.me; // 自分が操作している戦車（bot の枠を引き継ぐので接続IDとは別。観戦中は null）
      reconcile(m);
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
  // 部屋主は待機中に Enter ですぐ開始できる
  if (e.code === "Enter" && overlay.style.display === "none" && curr && curr.g.ph === "wait" && curr.g.owner) {
    ws?.send(JSON.stringify({ t: "start" }));
  }
  if (e.code === "Space") { mouse.down = true; e.preventDefault(); }
  // Q: "enemy spotted" pin at the mouse position, shared with the team
  if (e.code === "KeyQ" && !e.repeat && ws?.readyState === WebSocket.OPEN && curr?.me) {
    ws.send(JSON.stringify({ t: "pin", x: Math.round(mouse.x + cam.x), y: Math.round(mouse.y + cam.y) }));
  }
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

// 自機から見たマウスの方向（砲塔・視界の向き）
function localAim(me) {
  return me ? Math.atan2(mouse.y - (me.y - cam.y), mouse.x - (me.x - cam.x)) : 0;
}

function sendInput(aim) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const { mx, my } = moveInput();
  const fire = mouse.down;
  // 変化したときだけ、最短50ms間隔で送る（無料枠の節約）
  const key = `${mx},${my},${Math.round(aim * 40)},${fire}`;
  const now = performance.now();
  if (key === lastSentKey || now - lastSentAt < 50) return;
  seq++;
  sentAt.set(seq, now);
  ws.send(JSON.stringify({ t: "in", q: seq, mx, my, aim: Math.round(aim * 1000) / 1000, fire }));
  lastSentKey = key;
  lastSentAt = now;
}

function moveInput() {
  return {
    mx: (keys.has("right") ? 1 : 0) - (keys.has("left") ? 1 : 0),
    my: (keys.has("down") ? 1 : 0) - (keys.has("up") ? 1 : 0),
  };
}

// 毎フレーム、現在の入力で自機を先に動かす（壁判定はサーバーと同じ stepTank）
function predict(dt) {
  const me = curr && curr.tanks.find((k) => k.id === myId);
  // サーバーが動かさない段階（カウントダウン・結果表示）では予測しない
  const canMove = curr && (curr.g.ph === "wait" || curr.g.ph === "play");
  if (!me || me.dead || !canMove) { pred = null; history = []; return; }
  if (!pred) pred = { x: me.x, y: me.y, body: me.b, aim: me.a, type: me.k };
  const { mx, my } = moveInput();
  stepTank(grid, pred, mx, my, dt);
  const now = performance.now();
  history.push({ t: now, x: pred.x, y: pred.y });
  while (history.length && history[0].t < now - PREDICT.historyMs) history.shift();
}

// スナップショット受信時：往復遅延ぶん前の予測位置とサーバー位置を比べて補正する
function reconcile(m) {
  const now = performance.now();
  const t = sentAt.get(m.q);
  if (t !== undefined) {
    rtt = rtt * 0.8 + (now - t) * 0.2;
    for (const q of sentAt.keys()) if (q <= m.q) sentAt.delete(q);
  }
  const me = m.tanks.find((k) => k.id === myId);
  if (!pred || !me || me.dead) return;
  const target = now - rtt;
  const past = history.find((h) => h.t >= target) || { x: pred.x, y: pred.y };
  const ex = me.x - past.x, ey = me.y - past.y;
  if (Math.hypot(ex, ey) > PREDICT.snapDist) {
    pred = { x: me.x, y: me.y, body: me.b, aim: me.a, type: me.k };
    history = [];
    return;
  }
  const cx = ex * PREDICT.correct, cy = ey * PREDICT.correct;
  pred.x += cx; pred.y += cy;
  for (const h of history) { h.x += cx; h.y += cy; }
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

// 車種ごとの見た目（l：車体の半分の長さ、w：半分の幅、gun：砲身の長さ、head：砲塔の大きさ）
const SPRITE = {
  light: { l: 5, w: 3, gun: 7, head: 3 },
  medium: { l: 6, w: 4, gun: 9, head: 4 },
  heavy: { l: 7, w: 5, gun: 10, head: 6 },
};

function drawTank(k, isMe) {
  const x = Math.round(k.x - cam.x), y = Math.round(k.y - cam.y);
  const sp = SPRITE[k.k] || SPRITE.medium;
  // 車体（8方向にスナップしてドット感を保つ）
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(snap8(k.b));
  ctx.fillStyle = PALETTE.tread;
  ctx.fillRect(-sp.l, -sp.w - 2, sp.l * 2, 3);
  ctx.fillRect(-sp.l, sp.w - 1, sp.l * 2, 3);
  ctx.fillStyle = PALETTE[k.team];
  ctx.fillRect(-sp.l + 1, -sp.w, sp.l * 2 - 2, sp.w * 2);
  ctx.restore();
  // 砲塔
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(k.a);
  ctx.fillStyle = "#e9e4d4";
  ctx.fillRect(0, -1, sp.gun, 2);
  ctx.fillStyle = isMe ? PALETTE.flare : "#e9e4d4";
  ctx.fillRect(-sp.head / 2, -sp.head / 2, sp.head, sp.head);
  ctx.restore();
  // HPバー（車種ごとの最大HPに対する割合）
  const top = y - sp.l - 4;
  ctx.fillStyle = PALETTE.hpBack; ctx.fillRect(x - 6, top, 12, 2);
  ctx.fillStyle = isMe ? PALETTE.flare : PALETTE.hpFore;
  ctx.fillRect(x - 6, top, Math.round((12 * k.hp) / tankSpec(k.k).hp), 2);
}

// 可視ポリゴン ∩（扇形 ∪ 全周の円）の外側を暗くする。
// 判定はサーバーと同じ形だが、向きはマウスの現在値を使うので、サーバーより少し先に明るくなる
function drawFog(me, aim) {
  fog.globalCompositeOperation = "source-over";
  fog.clearRect(0, 0, W, H);
  fog.fillStyle = PALETTE.fog;
  fog.fillRect(0, 0, W, H);
  if (!me) return ctx.drawImage(fogCv, 0, 0);
  const x = me.x - cam.x, y = me.y - cam.y;
  const spec = tankSpec(me.k);
  const pts = visibilityPolygon(grid, me.x, me.y, spec.range);
  fog.save();
  fog.beginPath();
  pts.forEach(([px, py], i) => (i ? fog.lineTo(px - cam.x, py - cam.y) : fog.moveTo(px - cam.x, py - cam.y)));
  fog.closePath();
  fog.clip();
  fog.globalCompositeOperation = "destination-out";
  fog.fillStyle = "#000";
  fog.beginPath();
  fog.moveTo(x, y);
  fog.arc(x, y, spec.range, aim - spec.fov / 2, aim + spec.fov / 2);
  fog.closePath();
  fog.fill();
  fog.beginPath();
  fog.arc(x, y, NEAR_VIEW, 0, Math.PI * 2);
  fog.fill();
  fog.restore();
  ctx.drawImage(fogCv, 0, 0);
}

const TEAM_NAME = { A: "Aチーム", B: "Bチーム" };
const fmtTime = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
// 自分のチームから見た結果
const resultText = (r) => (r === "draw" ? "引き分け" : r === curr.team ? "勝利" : "敗北");

const MODE_NAME = { elim: "殲滅モード", conquest: "拠点制圧モード" };
const ownerColor = (o) => (o ? PALETTE[o] : "#8a8778");

// Capture zones: ring in the owner's color, arc = capture progress of the leading team.
// Drawn above the fog because point states are public
function drawPoints() {
  for (const p of points) {
    const st = curr.g.pts.find((q) => q.id === p.id);
    if (!st) continue;
    const x = Math.round(p.x - cam.x), y = Math.round(p.y - cam.y);
    ctx.globalAlpha = st.c && Math.floor(performance.now() / 250) % 2 ? 0.35 : 0.8; // blink while contested
    ctx.lineWidth = 1;
    ctx.strokeStyle = ownerColor(st.o);
    ctx.beginPath(); ctx.arc(x, y, p.r, 0, Math.PI * 2); ctx.stroke();
    if (st.p !== 0 && Math.abs(st.p) < 1) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = PALETTE[st.p > 0 ? "A" : "B"];
      ctx.beginPath(); ctx.arc(x, y, p.r - 2, -Math.PI / 2, -Math.PI / 2 + Math.abs(st.p) * Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

// Team pins: a blinking marker in the world, or an arrow on the screen edge when off-screen
function drawPins() {
  const blink = Math.floor(performance.now() / 200) % 2;
  for (const pin of curr.pins) {
    ctx.globalAlpha = pin.life < 1 ? Math.max(0.2, pin.life) : 1; // fade out in the last second
    ctx.fillStyle = blink ? PALETTE.flare : "#fff3c4";
    const x = Math.round(pin.x - cam.x), y = Math.round(pin.y - cam.y);
    if (x >= 4 && x <= W - 4 && y >= 16 && y <= H - 4) {
      // Downward triangle above the spot, with a dot on the spot itself
      ctx.beginPath(); ctx.moveTo(x - 4, y - 9); ctx.lineTo(x + 4, y - 9); ctx.lineTo(x, y - 3); ctx.closePath(); ctx.fill();
      ctx.fillRect(x - 1, y - 1, 2, 2);
    } else {
      const ex = clamp(x, 6, W - 6), ey = clamp(y, 18, H - 6);
      const a = Math.atan2(y - ey, x - ex);
      ctx.save(); ctx.translate(ex, ey); ctx.rotate(a);
      ctx.beginPath(); ctx.moveTo(5, 0); ctx.lineTo(-3, -4); ctx.lineTo(-3, 4); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
}

// Point letters are text, so they go on the high-resolution HUD layer
function drawPointLabels() {
  hud.font = "8px DotGothic16, monospace";
  hud.textAlign = "center";
  hud.textBaseline = "middle";
  for (const p of points) {
    const st = curr.g.pts.find((q) => q.id === p.id);
    if (!st) continue;
    hud.fillStyle = ownerColor(st.o);
    hud.fillText(p.id, p.x - cam.x, p.y - cam.y);
  }
  hud.textAlign = "left";
  hud.textBaseline = "top";
}

// 案内の帯。cy は帯の中心の高さ（既定は画面中央）
function banner(lines, big = false, cy = H / 2) {
  const h = big ? 28 : 12 * lines.length + 8;
  hud.fillStyle = "rgba(0,0,0,0.6)";
  hud.fillRect(0, cy - h / 2, W, h);
  hud.textAlign = "center";
  hud.fillStyle = PALETTE.flare;
  if (big) {
    hud.font = "16px DotGothic16, monospace";
    hud.fillText(lines[0], W / 2, cy - 8);
    hud.font = "8px DotGothic16, monospace";
  } else {
    lines.forEach((t, i) => hud.fillText(t, W / 2, cy - h / 2 + 5 + i * 12));
  }
  hud.textAlign = "left";
}

function drawHud(me) {
  const g = curr.g;
  hud.font = "8px DotGothic16, monospace";
  hud.textBaseline = "top";
  hud.fillStyle = "rgba(0,0,0,0.5)"; hud.fillRect(0, 0, W, 12);
  if (g.mode === "conquest") {
    // Left: scores toward the target, then each point's owner
    hud.fillStyle = PALETTE.A; hud.fillText(`A ${g.sc[0]}`, 4, 2);
    hud.fillStyle = PALETTE.B; hud.fillText(`B ${g.sc[1]}`, 38, 2);
    hud.fillStyle = "#c9c4b3"; hud.fillText(`/ ${g.tg}`, 72, 2);
    g.pts.forEach((p, i) => { hud.fillStyle = ownerColor(p.o); hud.fillText(p.c ? `${p.id}!` : p.id, 100 + i * 12, 2); });
  } else {
    // 左：ラウンド、各チームの勝ち数（●）と生存数
    const marks = (n) => "●".repeat(n) + "○".repeat(Math.max(0, g.wr - n));
    hud.fillStyle = "#c9c4b3"; hud.fillText(`R${g.r}`, 4, 2);
    hud.fillStyle = PALETTE.A; hud.fillText(`A ${marks(g.w[0])} ${g.al[0]}機`, 22, 2);
    hud.fillStyle = PALETTE.B; hud.fillText(`B ${marks(g.w[1])} ${g.al[1]}機`, 82, 2);
  }
  // 中央：残り時間
  hud.textAlign = "center";
  hud.fillStyle = "#c9c4b3";
  if (g.ph === "play") hud.fillText(fmtTime(g.t), W / 2 + 20, 2);
  // 右：自分の車種とHP
  hud.textAlign = "right";
  if (me) {
    hud.fillStyle = PALETTE.flare;
    hud.fillText(`${tankSpec(me.k).name}  HP ${me.hp}`, W - 4, 2);
  }
  hud.textAlign = "left";

  if (g.ph === "wait") {
    banner([
      `${MODE_NAME[g.mode]}　待機中　あと ${g.t} 秒で開始（空いた枠は bot が入ります）`,
      g.owner ? "Enter キーで今すぐ開始　／　ウォームアップ中は撃てません" : "部屋主の開始を待っています　／　ウォームアップ中は撃てません",
    ], false, H - 20); // 自機に重ならないよう画面下に出す
  } else if (g.ph === "countdown") {
    banner([String(g.t)], true);
  } else if (g.ph === "roundEnd") {
    banner([`ラウンド${g.r}　${resultText(g.rr)}`, g.rr === "draw" ? "" : `${TEAM_NAME[g.rr]}の勝ち`]);
  } else if (g.ph === "matchEnd") {
    const score = g.mode === "conquest" ? `A ${g.sc[0]} - ${g.sc[1]} B` : `A ${g.w[0]} - ${g.w[1]} B`;
    banner([`試合終了　${resultText(g.mr)}`, `${score}　まもなく次の試合の待機に戻ります`]);
  }
  // 観戦の案内（画面下）
  const note = !me ? "観戦中：次のラウンドから参加します（味方の視点のみ）"
    : me.dead && g.ph === "play"
      ? (g.mode === "conquest" ? `撃破されました　${curr.rs} 秒後に自陣で復活します` : "撃破されました　味方の視点で観戦中")
      : "";
  if (note) {
    hud.fillStyle = "rgba(0,0,0,0.5)"; hud.fillRect(0, H - 14, W, 14);
    hud.fillStyle = PALETTE.flare; hud.textAlign = "center";
    hud.fillText(note, W / 2, H - 11);
    hud.textAlign = "left";
  }
}

function frame() {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  hud.clearRect(0, 0, W, H);
  if (!curr || !map.length) {
    requestAnimationFrame(frame);
    return;
  }
  const nowMs = performance.now();
  const dt = Math.min(0.05, (nowMs - lastFrameAt) / 1000);
  predict(dt);
  lastFrameAt = nowMs;
  // 自機は予測位置で描く（スナップショット本体は補正に使うので書き換えない）
  const tanks = interpolatedTanks().map((k) => (k.id === myId && pred ? { ...k, x: pred.x, y: pred.y, b: pred.body } : k));
  const me = tanks.find((k) => k.id === myId);
  // 視界とカメラの元：自分が生きていれば自機、撃破中・観戦中はサーバーが選んだ味方
  const view = tanks.find((k) => k.id === curr.view) || me;
  const mapW = map[0].length * TILE, mapH = map.length * TILE;
  if (view) {
    cam.x = clamp(Math.round(view.x - W / 2), 0, mapW - W);
    cam.y = clamp(Math.round(view.y - H / 2), 0, mapH - H);
  }
  // 砲塔はマウスの向きへ、サーバーと同じ旋回速度の上限で回す（サーバーには目標の向きを送る）
  const target = localAim(me);
  if (me && pred) me.a = pred.aim = turnTurret(pred.type, pred.aim, target, dt);
  if (me && !me.dead) sendInput(target);
  drawMap();
  drawFog(view, view ? view.a : 0);
  ctx.fillStyle = PALETTE.bullet;
  for (const [bx, by] of curr.bullets) ctx.fillRect(Math.round(bx - cam.x) - 1, Math.round(by - cam.y) - 1, 2, 2);
  drawPoints();
  for (const k of tanks) if (!k.dead) drawTank(k, k.id === myId);
  drawPins();
  drawPointLabels();
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

// 試合の段階が変わったときの合図
function playPhase(g, team) {
  if (!audio) return;
  if (g.ph === "countdown") tone(440, 440, 0.12, "square", 0.6);
  else if (g.ph === "play") tone(880, 880, 0.25, "square", 0.7);
  else if (g.ph === "roundEnd" || g.ph === "matchEnd") {
    const r = g.ph === "roundEnd" ? g.rr : g.mr;
    if (r === team) { tone(523, 1046, 0.3, "square", 0.6); } else { tone(400, 120, 0.5, "sawtooth", 0.6); }
  }
}

function playEvent(e) {
  if (!audio || !curr) return;
  // Capture point changed owner: heard everywhere, rising for us, falling for them
  if (e.e === "cap") {
    if (e.team === curr.team) tone(660, 990, 0.25, "triangle", 0.7);
    else tone(500, 250, 0.3, "triangle", 0.7);
    return;
  }
  // 音の距離は、いま見ている視点（自機、または観戦中の味方）から測る
  const me = curr.tanks.find((k) => k.id === curr.view);
  const dist = me ? Math.hypot(me.x - e.x, me.y - e.y) : 0;
  const vol = Math.max(0, 1 - dist / 260); // 遠いほど小さく
  if (vol <= 0) return;
  if (e.e === "fire") tone(880, 220, 0.08, "square", vol);
  else if (e.e === "wall") tone(200, 80, 0.05, "square", vol * 0.5);
  else if (e.e === "hit") noise(0.12, vol);
  else if (e.e === "kill") { noise(0.45, vol); tone(300, 40, 0.4, "sawtooth", vol); }
}
