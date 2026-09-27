import { updateGhosts, GHOST } from "./ghosts.js";
import { STICK, stickVector, moveFromStick, aimFromStick, assistAim } from "./touch.js";
import { INTERP, sample, pushSnapshot } from "./interp.js";
import { MINIMAP, minimapLayout, minimapDots, minimapWalls } from "./minimap.js";
import { SFX, FIRE_SFX, synth } from "./sfx.js";
import { t, setLang, getLang, detectLang, applyI18n } from "./i18n.js";

// ===== Language (English / Japanese): saved choice, else the browser's preference =====
{
  let saved = null;
  try { saved = localStorage.getItem("ft.lang"); } catch { /* storage may be unavailable */ }
  setLang(saved ?? detectLang(navigator.languages ?? [navigator.language]));
  applyI18n(document);
}
import { TILE, TANK_TYPES, DEFAULT_TANK, NEAR_VIEW, tankSpec, makeGrid, stepTank, turnTurret, visibilityPolygon, angleDiff } from "./shared.js";

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
  headlight: "#fff3c4", // front corners of the hull, so the facing is easy to read
  rearShade: "rgba(0, 0, 0, 0.4)", // darker back end of the hull
  A: "#5ad1c8", B: "#e8506a",
  noseA: "#2f8f88", noseB: "#a3334a", // darker front armor, so the hull's front stands out at any angle
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
let settings = null; // room settings from the server (init / cfg)
const seenPins = new Set(); // pin ids already announced with a sound
const ghosts = new Map(); // last-seen afterimages of enemies (see ghosts.js)
let marks = []; // edge indicators: {kind: "hurt" | "shot", dir, d, at}
const MARK = { hurtSec: 1.2, shotSec: 1.0 }; // how long edge indicators stay
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
  snapAngle: 0.8, // hull angle error (rad) beyond which the prediction is reset
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
// Card text: name, role, HP / damage, view angle (rebuilt when the language changes)
function tankCard(btn, type) {
  const s = TANK_TYPES[type];
  const name = document.createElement("b");
  name.textContent = t(`tank.${type}.name`);
  const small = document.createElement("small");
  const lines = [t(`tank.${type}.role`), t("tank.hpDamage", { hp: s.hp, damage: s.damage }), t("tank.fov", { fov: Math.round((s.fov * 180) / Math.PI) })];
  lines.forEach((line, i) => { if (i) small.append(document.createElement("br")); small.append(line); });
  btn.replaceChildren(name, small);
}
for (const type of TANK_ORDER) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.dataset.type = type;
  tankCard(btn, type);
  btn.addEventListener("click", async () => {
    chooseTank(type);
    btn.setAttribute("aria-busy", "true"); // show the click registered while we sign in
    try { await goLobby(); } finally { btn.removeAttribute("aria-busy"); }
  });
  tankButtons.append(btn);
}
function chooseTank(type) {
  tankType = type;
  try { localStorage.setItem("ft.tank", type); } catch { /* 保存できなくても続行 */ }
  for (const b of tankButtons.children) b.setAttribute("aria-pressed", String(b.dataset.type === type));
}
chooseTank(tankType);

// ===== 開始・接続 =====
// ===== Guest name and signed token (saved in the browser) =====
const nameInput = document.getElementById("name");
const errBox = document.getElementById("err");
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode etc.: keep going without saving */ } },
};
let guest = { token: store.get("ft.token"), name: store.get("ft.name") || "" };
nameInput.value = guest.name;

// Ask the server to check the name and sign (or renew) our token
async function signIn() {
  const res = await fetch("/api/guest", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: nameInput.value, token: guest.token }),
  });
  const body = await res.json().catch(() => ({ code: "network" }));
  if (!res.ok) throw new Error(errorText(body));
  guest = { token: body.token, name: body.name };
  store.set("ft.token", guest.token);
  store.set("ft.name", guest.name);
}

// ===== Turnstile (bot check before creating or joining a room). Tokens are single-use =====
let turnstileKey = null;
let turnstileWidget = null;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.onload = resolve;
    s.onerror = () => reject(new Error(t("err.turnstileLoad")));
    document.head.append(s);
  });
}
// A fresh token; the widget only shows itself if Cloudflare wants the player to interact
async function humanToken() {
  turnstileKey ??= (await (await fetch("/api/config")).json()).turnstileSiteKey;
  await loadTurnstile();
  return new Promise((resolve, reject) => {
    if (turnstileWidget !== null) window.turnstile.remove(turnstileWidget);
    // The container must not have id="turnstile": that id would shadow window.turnstile
    turnstileWidget = window.turnstile.render("#humanCheck", {
      sitekey: turnstileKey, appearance: "interaction-only", callback: resolve,
      "error-callback": () => reject(new Error(t("err.turnstileFail"))),
    });
  });
}

// Server errors carry a code (see src/index.ts); the words come from i18n.js
const errorText = (body) => (body?.code ? t(`err.${body.code}`, body) : body?.error || t("err.network"));

// Room actions go through the Worker with our token. Returns the JSON body or throws with its error text
async function api(path, body = {}) {
  const res = await fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: guest.token, ...body }),
  });
  const data = await res.json().catch(() => ({ code: "network" }));
  if (!res.ok) throw new Error(errorText(data));
  return data;
}

addEventListener("keydown", (e) => {
  if (overlay.style.display === "none" || titleView.hidden) return;
  if (e.key === "Enter") return goLobby();
  if (e.target === nameInput) return; // 1/2/3 while typing the name are just characters
  const i = ["Digit1", "Digit2", "Digit3"].indexOf(e.code);
  if (i >= 0) chooseTank(TANK_ORDER[i]);
});

// ===== Screens: title (name + tank) -> lobby (room list) -> game =====
const titleView = document.getElementById("title");
const lobbyView = document.getElementById("lobby");
const lobbyMsg = document.getElementById("lobbyMsg");
const roomList = document.getElementById("rooms");
const createForm = document.getElementById("createForm");
const rejoinBtn = document.getElementById("rejoin");
let lobbyWs = null;
let lastRoom = null; // {id, adhoc} of the room we were in, to go back within the reconnect window

function showScreen(name, text = "") {
  overlay.style.display = name === "game" ? "none" : "flex";
  titleView.hidden = name !== "title";
  lobbyView.hidden = name !== "lobby";
  if (name === "lobby") { lobbyMsg.textContent = text; openLobby(); } else closeLobby();
  if (name === "title") msg.textContent = text || msg.textContent;
  rejoinBtn.hidden = !lastRoom;
}

let busy = false;
async function goLobby() {
  if (busy) return;
  // iOS対策：ユーザー操作の中で音を有効化する
  if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
  audio.resume();
  busy = true;
  errBox.textContent = "";
  try {
    await signIn();
  } catch (e) {
    errBox.textContent = e.message;
    nameInput.focus();
    return;
  } finally {
    busy = false;
  }
  // Links straight into a room: ?code=123456 (invite) or ?room=name (dev-only ad-hoc room)
  const params = new URLSearchParams(location.search);
  // If a direct link fails, open the lobby with the reason
  try {
    if (params.has("room")) return await enterRoom(params.get("room"), true);
    if (params.has("code")) {
      const code = params.get("code");
      window.history.replaceState(null, "", location.pathname); // don't auto-join again after leaving (a local "history" shadows it)
      return await joinByCode(code);
    }
  } catch (e) {
    return showScreen("lobby", e.message);
  }
  showScreen("lobby");
}

// Live room list over a WebSocket (the lobby pushes changes; no polling)
function openLobby() {
  if (lobbyWs) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  lobbyWs = new WebSocket(`${proto}://${location.host}/lobby?token=${encodeURIComponent(guest.token)}`);
  lobbyWs.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.t === "rooms") renderRooms(m.rooms); };
  lobbyWs.onclose = () => { lobbyWs = null; };
}
function closeLobby() {
  lobbyWs?.close();
  lobbyWs = null;
}

let pendingRooms = null; // a list update that arrived while a lobby action was in progress
let shownRooms = []; // the last list, redrawn when the language changes
function renderRooms(rooms) {
  shownRooms = rooms;
  // Don't swap out the buttons under the player's click while they're joining
  if (lobbyBusy) { pendingRooms = rooms; return; }
  pendingRooms = null;
  roomList.replaceChildren();
  if (!rooms.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = t("lobby.empty");
    roomList.append(li);
    return;
  }
  for (const r of rooms) {
    const li = document.createElement("li");
    const info = document.createElement("div");
    const rule = r.mode === "elim" ? `${t("set.mode.elim")} · ${t("rule.elim", { n: r.winRounds })}` : t("set.mode.conquest");
    const head = document.createElement("div");
    head.textContent = `${rule} · ${mapText(r)}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = [t("lobby.players", { n: r.humans, cap: r.capacity }), t(r.playing ? "lobby.playing" : "lobby.waiting"),
      t("rule.bot", { n: r.botLevel }), t(r.ff ? "rule.ffOn" : "rule.ffOff")].join(" · ");
    info.append(head, meta);
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.type = "button";
    btn.textContent = t(r.humans >= r.capacity ? "lobby.full" : "lobby.join");
    btn.disabled = r.humans >= r.capacity;
    btn.addEventListener("click", busyButton(btn, "lobby.joining", () => enterRoom(r.id)));
    li.append(info, btn);
    roomList.append(li);
  }
}

// Joining takes a few seconds (Turnstile + connecting), so show that the click registered:
// the button changes its text and color, and other lobby actions wait until this one finishes
let lobbyBusy = false;
function busyButton(btn, textKey, fn) {
  return async (...args) => {
    if (lobbyBusy) return;
    lobbyBusy = true;
    const label = btn.textContent;
    btn.setAttribute("aria-busy", "true");
    btn.disabled = true;
    btn.textContent = t(textKey);
    lobbyMsg.textContent = "";
    try {
      await fn(...args);
    } catch (e) {
      lobbyMsg.textContent = e.message;
    } finally {
      lobbyBusy = false;
      btn.removeAttribute("aria-busy");
      btn.disabled = false;
      btn.textContent = label;
      if (pendingRooms) renderRooms(pendingRooms);
    }
  };
}

const joinByCode = async (code) => {
  if (!/^\d{6}$/.test(code)) throw new Error(t("err.code_format"));
  const { id } = await api("/api/code", { code });
  await enterRoom(id);
};
const quickBtn = document.getElementById("quick");
quickBtn.addEventListener("click", busyButton(quickBtn, "lobby.searching", async () => {
  await enterRoom((await api("/api/quick", { ts: await humanToken() })).id);
}));
document.getElementById("create").addEventListener("click", () => { createForm.hidden = false; });
document.getElementById("cancelCreate").addEventListener("click", () => { createForm.hidden = true; });
document.getElementById("back").addEventListener("click", () => showScreen("title"));
const codeForm = document.getElementById("codeForm");
const joinCode = busyButton(codeForm.querySelector("button"), "lobby.joining", () => joinByCode(document.getElementById("code").value.trim()));
codeForm.addEventListener("submit", (e) => { e.preventDefault(); joinCode(); });
const createRoom = busyButton(createForm.querySelector("button[type=submit]"), "lobby.creating", async () => {
  const f = createForm.elements;
  const settings = {
    mode: f.mode.value, winRounds: Number(f.winRounds.value), botLevel: Number(f.botLevel.value),
    ff: f.ff.checked, public: f.public.checked,
    map: f.map.value, mapSeed: f.mapSeed.value === "" ? null : Number(f.mapSeed.value),
  };
  const { id } = await api("/api/rooms", { settings, ts: await humanToken() });
  createForm.hidden = true;
  await enterRoom(id);
});
createForm.addEventListener("submit", (e) => { e.preventDefault(); createRoom(); });
rejoinBtn.addEventListener("click", busyButton(rejoinBtn, "lobby.joining", async () => lastRoom && enterRoom(lastRoom.id, lastRoom.adhoc)));

// Language switch on the title screen: redraw everything that has text
document.getElementById("langBtn").addEventListener("click", () => {
  setLang(getLang() === "ja" ? "en" : "ja");
  store.set("ft.lang", getLang());
  applyI18n(document);
  for (const b of tankButtons.children) tankCard(b, b.dataset.type);
  setMuted(muted); // the sound button's text
  renderRooms(shownRooms);
  renderPlayers();
});

// Joining needs its own Turnstile token too (spec: check on create and join)
async function enterRoom(id, adhoc = false) {
  // Phones: go full screen in landscape where the browser allows it (must happen during the tap)
  if (touchMode && document.documentElement.requestFullscreen && !document.fullscreenElement) {
    document.documentElement.requestFullscreen().then(() => screen.orientation?.lock?.("landscape")).catch(() => {});
  }
  const ts = await humanToken();
  lastRoom = { id, adhoc };
  showScreen("game");
  connect(id, adhoc, ts);
}

// App switch / screen lock (spec: treat as a disconnect; a bot takes over). Coming back within the
// reconnect window rejoins the same room automatically, which gives the tank back
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (!ws || !inGame()) return;
    hiddenAt = performance.now();
    leaveRoom(t("close.hidden"));
  } else if (hiddenAt && lastRoom && performance.now() - hiddenAt < REJOIN_WITHIN_MS) {
    hiddenAt = 0;
    rejoinBtn.click();
  }
});
const REJOIN_WITHIN_MS = 28000; // a little under the server's 30 s hold on the tank

// Esc (or the leave button) goes back to the lobby right away, without waiting for the close handshake
function leaveRoom(message) {
  if (!ws) return;
  const sock = ws;
  sock.onclose = null;
  sock.close(1000);
  roomClosed(1000, true, message);
}
addEventListener("keydown", (e) => {
  if (e.code === "Escape" && ws && overlay.style.display === "none") leaveRoom();
});

// A new map (joining, or the owner changed it): rebuild everything derived from the tiles
function setMap(tiles) {
  map = tiles;
  grid = makeGrid(map);
  snapBuffer = [];
  buildMinimap();
  pred = null; history = [];
  ghosts.clear();
}

function connect(roomId, adhoc, ts) {
  const params = new URLSearchParams(location.search);
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({ room: roomId, tank: tankType, token: guest.token, name: guest.name, ts });
  // Dev-only ad-hoc rooms take their settings from the page URL (?mode=, ?bot=, ...)
  if (adhoc) {
    q.set("adhoc", "1");
    for (const key of ["mode", "bot", "rounds", "ff", "map", "seed"]) if (params.has(key)) q.set(key, params.get(key));
  }
  ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === "init") {
      myId = null; prev = curr = null;
      setMap(m.map);
      sentAt.clear();
      points = m.points || [];
      settings = m.settings;
      inviteCode = m.code;
      ghosts.clear(); marks = [];
    } else if (m.t === "cfg") {
      settings = m.settings; points = m.points || [];
      if (m.map) setMap(m.map); // the owner switched maps while waiting
    } else if (m.t === "players") {
      players = m.players;
      renderPlayers();
    } else if (m.t === "s") {
      if (curr && curr.g.ph !== m.g.ph) playPhase(m.g, m.team);
      else if (curr && m.g.ph === "countdown" && m.g.t !== curr.g.t && m.g.t > 0) play("count"); // 3, 2, 1
      if (m.hurt.length) play("hurt"); // our own tank was hit
      const nowSec = performance.now() / 1000;
      updateGhosts(ghosts, curr, m, nowSec);
      for (const dir of m.hurt) marks.push({ kind: "hurt", dir, at: nowSec });
      for (const e of m.ev) if (e.e === "shot") marks.push({ kind: "shot", dir: e.dir, d: e.d, at: nowSec });
      for (const pin of m.pins) {
        if (seenPins.has(pin.id)) continue;
        seenPins.add(pin.id);
        if (curr) play("pin"); // new pin from the team (skip on first snapshot)
      }
      prev = curr; curr = m; currAt = performance.now();
      pushSnapshot(snapBuffer, m, currAt);
      myId = m.me; // 自分が操作している戦車（bot の枠を引き継ぐので接続IDとは別。観戦中は null）
      reconcile(m);
      m.ev.forEach(playEvent);
    }
  };
  ws.onclose = (e) => roomClosed(e.code, false);
}

// Back to the lobby with the reason. Close codes come from the server (see src/index.ts)
function roomClosed(code, leftOnPurpose, message) {
  ws = null;
  curr = prev = null;
  playersPanel.style.display = "none";
  const why = code === 1000 ? t(leftOnPurpose ? "close.left" : "close.closed")
    : [4000, 4003, 4404, 4005].includes(code) ? t(`close.${code}`) : t("close.lost");
  if ([4003, 4404, 4005].includes(code)) lastRoom = null;
  showScreen("lobby", message ?? why);
}

// ===== Players panel (Tab): invite code / link, and kick for the owner =====
const playersPanel = document.getElementById("players");
let players = [];
let inviteCode = null;
function renderPlayers() {
  const invite = document.getElementById("invite");
  invite.replaceChildren();
  if (inviteCode) {
    const url = `${location.origin}${location.pathname}?code=${inviteCode}`;
    invite.textContent = t("players.invite", { code: inviteCode });
    const copy = document.createElement("button");
    copy.className = "btn";
    copy.type = "button";
    copy.textContent = t("players.copy");
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(url); copy.textContent = t("players.copied"); } catch { copy.textContent = url; }
    });
    invite.append(copy);
  }
  const list = document.getElementById("playerList");
  list.replaceChildren();
  const iAmOwner = !!curr?.g.owner;
  for (const p of players) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = p.team;
    name.textContent = `${p.name}${p.owner ? t("players.owner") : ""}`;
    li.append(name);
    if (iAmOwner && !p.owner) {
      const kick = document.createElement("button");
      kick.className = "btn";
      kick.type = "button";
      kick.textContent = t("players.kick");
      kick.addEventListener("click", () => {
        if (confirm(t("players.kickConfirm", { name: p.name }))) ws?.send(JSON.stringify({ t: "kick", cid: p.cid }));
      });
      li.append(kick);
    }
    list.append(li);
  }
}
function togglePlayers() {
  const open = playersPanel.style.display !== "block";
  playersPanel.style.display = open ? "block" : "none";
  if (open) renderPlayers();
}
addEventListener("keydown", (e) => {
  if (e.code !== "Tab" || overlay.style.display !== "none") return;
  e.preventDefault();
  togglePlayers();
});

// ===== 入力 =====
// Tank controls: W / Up forward, S / Down reverse, A / Left turn the hull left, D / Right turn it right
const KEYMAP = {
  KeyW: "forward", ArrowUp: "forward", KeyS: "reverse", ArrowDown: "reverse",
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
  if (e.code === "KeyQ" && !e.repeat) placePinAtMouse();
});
// "Enemy spotted" pin at the mouse position, shared with the team (Q or right click)
function placePinAtMouse() {
  if (ws?.readyState !== WebSocket.OPEN || !curr?.me) return;
  ws.send(JSON.stringify({ t: "pin", x: Math.round(mouse.x + cam.x), y: Math.round(mouse.y + cam.y) }));
}
addEventListener("keyup", (e) => {
  if (KEYMAP[e.code]) keys.delete(KEYMAP[e.code]);
  if (e.code === "Space") mouse.down = false;
});
addEventListener("mousemove", (e) => {
  const r = cv.getBoundingClientRect();
  mouse.x = ((e.clientX - r.left) * W) / r.width;
  mouse.y = ((e.clientY - r.top) * H) / r.height;
});
addEventListener("mousedown", (e) => {
  if (e.button === 0 && ws) mouse.down = true;
  if (e.button === 2 && e.target === cv) placePinAtMouse(); // right click on the game screen (not on panels)
});
addEventListener("mouseup", (e) => { if (e.button === 0) mouse.down = false; });
addEventListener("contextmenu", (e) => e.preventDefault());
addEventListener("blur", () => { keys.clear(); mouse.down = false; });

// ===== Touch: twin sticks (left half moves, right half aims; see touch.js) =====
// Touch mode turns on for coarse pointers or at the first touch, and shows the on-screen buttons
let touchMode = matchMedia("(pointer: coarse)").matches;
const sticks = new Map(); // touch identifier -> {role: "move" | "aim", origin, point} in CSS px
let touchAim = null; // last aim set with the right stick (kept when the thumb is lifted)
const inGame = () => overlay.style.display === "none";
function setTouchMode() {
  if (!touchMode) return;
  document.body.classList.add("touch");
  if (titleView && !titleView.hidden) { msg.dataset.i18n = "title.msgTouch"; msg.textContent = t("title.msgTouch"); }
}
setTouchMode();
addEventListener("touchstart", (e) => {
  if (!touchMode) { touchMode = true; setTouchMode(); }
  if (!inGame() || e.target.closest("button, select, input, form, #players")) return;
  e.preventDefault();
  for (const t of e.changedTouches) {
    const role = t.clientX < innerWidth / 2 ? "move" : "aim";
    if ([...sticks.values()].some((s) => s.role === role)) continue; // one stick per side
    const p = { x: t.clientX, y: t.clientY };
    sticks.set(t.identifier, { role, origin: p, point: p });
  }
}, { passive: false });
addEventListener("touchmove", (e) => {
  if (!inGame()) return;
  e.preventDefault(); // no scrolling or zooming while playing
  for (const t of e.changedTouches) {
    const s = sticks.get(t.identifier);
    if (s) s.point = { x: t.clientX, y: t.clientY };
  }
}, { passive: false });
const endTouch = (e) => { for (const t of e.changedTouches) sticks.delete(t.identifier); };
addEventListener("touchend", endTouch);
addEventListener("touchcancel", endTouch);
const stickOf = (role) => {
  const s = [...sticks.values()].find((x) => x.role === role);
  return s ? stickVector(s.origin, s.point) : null;
};

// 自機から見たマウスの方向（砲塔・視界の向き）。With touch, the right stick's direction (weak aim assist)
function localAim(me) {
  if (!me) return 0;
  if (touchMode) {
    const v = stickOf("aim");
    const a = v && aimFromStick(v);
    if (a?.active) {
      const enemies = curr.tanks.filter((k) => k.team !== curr.team);
      touchAim = assistAim(a.aim, me, enemies, tankSpec(me.k).range);
    }
    return touchAim ?? me.a;
  }
  return Math.atan2(mouse.y - (me.y - cam.y), mouse.x - (me.x - cam.x));
}

// Fire: mouse / space, or the right stick pushed far enough
function fireInput() {
  const v = touchMode && stickOf("aim");
  return mouse.down || !!(v && aimFromStick(v).fire);
}

// Touch pin: on the nearest visible enemy, or a little ahead of the turret if none is in sight
function touchPin(me) {
  const enemies = curr.tanks.filter((k) => k.team !== curr.team && !k.dead);
  const near = enemies.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))[0];
  const aim = me.a;
  return near ? { x: near.x, y: near.y } : { x: me.x + Math.cos(aim) * TOUCH_PIN_AHEAD, y: me.y + Math.sin(aim) * TOUCH_PIN_AHEAD };
}
const TOUCH_PIN_AHEAD = 100; // px ahead of the turret for a pin with no enemy in sight

function sendInput(aim) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const { drive, turn } = moveInput();
  const fire = fireInput();
  // 変化したときだけ、最短50ms間隔で送る（無料枠の節約）
  const key = `${drive},${turn},${Math.round(aim * 40)},${fire}`;
  const now = performance.now();
  if (key === lastSentKey || now - lastSentAt < 50) return;
  seq++;
  sentAt.set(seq, now);
  ws.send(JSON.stringify({ t: "in", q: seq, drive, turn, aim: Math.round(aim * 1000) / 1000, fire }));
  lastSentKey = key;
  lastSentAt = now;
}

// {drive, turn}: keys, or the left stick (the hull turns toward the stick and drives there)
function moveInput() {
  const v = touchMode && stickOf("move");
  const body = pred?.body ?? curr?.tanks.find((k) => k.id === myId)?.b ?? 0;
  if (v && v.mag >= STICK.deadZone) return moveFromStick(v, body);
  return {
    drive: (keys.has("forward") ? 1 : 0) - (keys.has("reverse") ? 1 : 0),
    turn: (keys.has("right") ? 1 : 0) - (keys.has("left") ? 1 : 0),
  };
}

// Draw the sticks where the thumbs are (HUD layer, converted from CSS px to 320x180 units)
function drawSticks() {
  if (!sticks.size) return;
  const r = cv.getBoundingClientRect();
  const k = W / r.width;
  for (const s of sticks.values()) {
    const v = stickVector(s.origin, s.point);
    const ox = (s.origin.x - r.left) * k, oy = (s.origin.y - r.top) * k, rad = STICK.radius * k;
    hud.strokeStyle = "rgba(233, 228, 212, 0.35)";
    hud.lineWidth = 1;
    hud.beginPath(); hud.arc(ox, oy, rad, 0, Math.PI * 2); hud.stroke();
    const firing = s.role === "aim" && v.mag >= STICK.fireAt;
    hud.fillStyle = firing ? "rgba(255, 179, 71, 0.7)" : "rgba(233, 228, 212, 0.45)";
    hud.beginPath(); hud.arc(ox + v.dx * rad, oy + v.dy * rad, rad * 0.4, 0, Math.PI * 2); hud.fill();
  }
}

// ===== On-screen buttons for touch (top of the screen, clear of the thumbs) =====
const touchBar = document.getElementById("touchBar");
touchBar.addEventListener("click", (e) => {
  const act = e.target.closest("button")?.dataset.act;
  if (!act || !ws) return;
  const me = curr?.tanks.find((k) => k.id === myId);
  if (act === "pin" && me && !me.dead) ws.send(JSON.stringify({ t: "pin", ...roundPoint(touchPin(me)) }));
  if (act === "start") ws.send(JSON.stringify({ t: "start" }));
  if (act === "settings") touchSettingsOpen = !touchSettingsOpen;
  if (act === "players") togglePlayers();
  if (act === "sound") setMuted(!muted);
  if (act === "leave") leaveRoom();
});
const roundPoint = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });
let touchSettingsOpen = false; // on phones the owner's settings panel opens from the bar (it would cover the right stick)
function syncTouchBar() {
  touchBar.style.display = touchMode && inGame() ? "flex" : "none";
  const ownerWaiting = !!(curr?.g.ph === "wait" && curr.g.owner);
  touchBar.querySelector("[data-act=start]").hidden = !ownerWaiting;
  touchBar.querySelector("[data-act=settings]").hidden = !ownerWaiting;
  if (!ownerWaiting) touchSettingsOpen = false;
}

// 毎フレーム、現在の入力で自機を先に動かす（壁判定はサーバーと同じ stepTank）
function predict(dt) {
  const me = curr && curr.tanks.find((k) => k.id === myId);
  // サーバーが動かさない段階（カウントダウン・結果表示）では予測しない
  const canMove = curr && (curr.g.ph === "wait" || curr.g.ph === "play");
  if (!me || me.dead || !canMove) { pred = null; history = []; return; }
  if (!pred) pred = { x: me.x, y: me.y, body: me.b, aim: me.a, type: me.k };
  const { drive, turn } = moveInput();
  stepTank(grid, pred, drive, turn, dt);
  const now = performance.now();
  history.push({ t: now, x: pred.x, y: pred.y, body: pred.body });
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
  const past = history.find((h) => h.t >= target) || { x: pred.x, y: pred.y, body: pred.body };
  const ex = me.x - past.x, ey = me.y - past.y;
  const eb = angleDiff(me.b, past.body); // the hull angle drifts too now that it turns over time
  if (Math.hypot(ex, ey) > PREDICT.snapDist || Math.abs(eb) > PREDICT.snapAngle) {
    pred = { x: me.x, y: me.y, body: me.b, aim: me.a, type: me.k };
    history = [];
    return;
  }
  const cx = ex * PREDICT.correct, cy = ey * PREDICT.correct, cb = eb * PREDICT.correct;
  pred.x += cx; pred.y += cy; pred.body += cb;
  for (const h of history) { h.x += cx; h.y += cy; h.body += cb; }
}

// ===== 補間 =====
// Other tanks and bullets are drawn slightly in the past from a snapshot buffer (see interp.js)
let snapBuffer = [];
function interpolated() {
  const delay = touchMode ? INTERP.touchDelayMs : INTERP.delayMs;
  return sample(snapBuffer, performance.now() - delay) ?? { snap: curr, tanks: curr.tanks };
}

// ===== Minimap (top-left): walls pre-rendered once per map, then dots each frame =====
const mmCv = document.createElement("canvas");
const mm = mmCv.getContext("2d");
let mmLayout = null;
function buildMinimap() {
  mmLayout = minimapLayout(map[0].length, map.length);
  mmCv.width = Math.ceil(mmLayout.w);
  mmCv.height = Math.ceil(mmLayout.h);
  // Background, then each pixel shaded by how much of it is wall
  const img = mm.createImageData(mmCv.width, mmCv.height);
  const cover = minimapWalls(map, mmLayout);
  for (let i = 0; i < cover.length; i++) {
    const k = Math.min(1, cover[i] * 1.3);
    img.data.set([10 + (143 - 10) * k, 14 + (139 - 14) * k, 11 + (120 - 11) * k, 200], i * 4);
  }
  mm.putImageData(img, 0, 0);
}
function drawMinimap() {
  if (!mmLayout) return;
  const k = mmLayout.scale / TILE; // world px -> minimap units
  const ox = MINIMAP.x, oy = MINIMAP.y;
  ctx.drawImage(mmCv, ox, oy);
  for (const p of points) {
    const st = curr.g.pts.find((q) => q.id === p.id);
    ctx.strokeStyle = ownerColor(st?.o);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(ox + p.x * k, oy + p.y * k, Math.max(2, p.r * k), 0, Math.PI * 2); ctx.stroke();
  }
  for (const d of minimapDots(curr, ghosts)) {
    ctx.globalAlpha = d.kind === "ghost" ? 0.4 : 1;
    ctx.fillStyle = d.me ? PALETTE.flare : PALETTE[d.team];
    const size = d.me ? 3 : 2;
    ctx.fillRect(Math.round(ox + d.x * k - size / 2), Math.round(oy + d.y * k - size / 2), size, size);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = PALETTE.flare;
  for (const pin of curr.pins) ctx.fillRect(Math.round(ox + pin.x * k) - 1, Math.round(oy + pin.y * k) - 1, 2, 2);
  // What the screen currently shows
  ctx.strokeStyle = "rgba(233, 228, 212, 0.5)";
  ctx.strokeRect(Math.round(ox + cam.x * k) + 0.5, Math.round(oy + cam.y * k) + 0.5, Math.round(W * k), Math.round(H * k));
}

// ===== 描画 =====
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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
  // 車体 (drawn at its real angle: the hull turns smoothly like a tank). Local +x is the front:
  // a sloped nose sticking out past the treads, two headlights on the front corners, a dark rear edge
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(k.b);
  ctx.fillStyle = PALETTE.tread;
  ctx.fillRect(-sp.l, -sp.w - 2, sp.l * 2, 3);
  ctx.fillRect(-sp.l, sp.w - 1, sp.l * 2, 3);
  ctx.fillStyle = PALETTE[k.team];
  ctx.fillRect(-sp.l + 1, -sp.w, sp.l * 2 - 3, sp.w * 2);
  ctx.fillStyle = PALETTE[`nose${k.team}`];
  ctx.beginPath(); // sloped front armor
  ctx.moveTo(sp.l - 2, -sp.w);
  ctx.lineTo(sp.l + 2, -sp.w + 2);
  ctx.lineTo(sp.l + 2, sp.w - 2);
  ctx.lineTo(sp.l - 2, sp.w);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = PALETTE.rearShade;
  ctx.fillRect(-sp.l + 1, -sp.w, 2, sp.w * 2);
  ctx.fillStyle = PALETTE.headlight;
  ctx.fillRect(sp.l, -sp.w + 1, 2, 1);
  ctx.fillRect(sp.l, sp.w - 2, 2, 1);
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

const fmtTime = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
// 自分のチームから見た結果
const resultText = (r) => t(r === "draw" ? "result.draw" : r === curr.team ? "result.win" : "result.lose");


// ===== Room settings panel (owner, waiting phase only) =====
const settingsForm = document.getElementById("settings");
settingsForm.addEventListener("change", () => {
  const f = settingsForm.elements;
  const next = {
    mode: f.mode.value, winRounds: Number(f.winRounds.value), botLevel: Number(f.botLevel.value), ff: f.ff.checked,
    map: f.map.value, mapSeed: f.mapSeed.value === "" ? null : Number(f.mapSeed.value), // empty = a new random map
  };
  ws?.send(JSON.stringify({ t: "settings", settings: next }));
});
settingsForm.addEventListener("submit", (e) => e.preventDefault());
// Keep the panel's visibility and values in sync with the server (skipping a field being edited)
function syncSettingsPanel() {
  const show = !!(curr && settings && curr.g.ph === "wait" && curr.g.owner && overlay.style.display === "none")
    && (!touchMode || touchSettingsOpen);
  settingsForm.style.display = show ? "block" : "none";
  if (!show) return;
  const f = settingsForm.elements;
  for (const [name, value] of Object.entries(settings)) {
    const el = f[name];
    if (!el || el === document.activeElement) continue;
    if (el.type === "checkbox") el.checked = value; else el.value = value === null ? "" : String(value);
  }
}
const mapText = (s) => (s.map === "random" ? t("map.random", { seed: s.mapSeed ?? t("map.seedAuto") }) : t("map.basic"));
const settingsText = (s) => [mapText(s), s.mode === "elim" ? t("rule.elim", { n: s.winRounds }) : t("rule.conquest", { n: curr.g.tg }),
  t("rule.bot", { n: s.botLevel }), t(s.ff ? "rule.ffOn" : "rule.ffOff")].join(" · ");
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

// Enemies we saw a moment ago, faded at their last known position
function drawGhosts() {
  const now = performance.now() / 1000;
  for (const g of ghosts.values()) {
    ctx.globalAlpha = 0.4 * Math.max(0, 1 - (now - g.at) / GHOST.lifeSec);
    drawTank(g.tank, false);
  }
  ctx.globalAlpha = 1;
}

// Edge indicators around the viewpoint: red wedges for where hits came from,
// pale ticks for unseen gunfire (bigger = closer). Directions are world angles
function drawMarks(view) {
  const now = performance.now() / 1000;
  marks = marks.filter((m) => now - m.at < (m.kind === "hurt" ? MARK.hurtSec : MARK.shotSec));
  if (!view) return;
  const cx = view.x - cam.x, cy = view.y - cam.y;
  for (const m of marks) {
    const life = m.kind === "hurt" ? MARK.hurtSec : MARK.shotSec;
    const dx = Math.cos(m.dir), dy = Math.sin(m.dir);
    // Where the ray from the viewpoint leaves the screen (inset from the edges and the top bar)
    const tx = dx > 0 ? (W - 8 - cx) / dx : dx < 0 ? (8 - cx) / dx : Infinity;
    const ty = dy > 0 ? (H - 8 - cy) / dy : dy < 0 ? (20 - cy) / dy : Infinity;
    const t = Math.max(0, Math.min(tx, ty));
    const size = m.kind === "hurt" ? 7 : [6, 4, 3][m.d];
    ctx.globalAlpha = Math.max(0, 1 - (now - m.at) / life);
    ctx.fillStyle = m.kind === "hurt" ? "#ff3b3b" : "#e9e4d4";
    ctx.save();
    ctx.translate(cx + dx * t, cy + dy * t);
    ctx.rotate(m.dir);
    ctx.beginPath(); ctx.moveTo(size, 0); ctx.lineTo(-size, -size); ctx.lineTo(-size / 2, 0); ctx.lineTo(-size, size); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

// Point letters are text, so they go on the high-resolution HUD layer
// Names over tanks (HUD layer so kanji stay sharp). Bots are labeled "bot"
function drawNames(tanks) {
  hud.font = "7px DotGothic16, monospace";
  hud.textAlign = "center";
  hud.textBaseline = "bottom";
  for (const k of tanks) {
    if (k.dead) continue;
    const sp = SPRITE[k.k] || SPRITE.medium;
    hud.fillStyle = k.id === myId ? PALETTE.flare : k.n ? "#e9e4d4" : "#8a8778";
    hud.fillText(k.n ?? "bot", k.x - cam.x, k.y - cam.y - sp.l - 5);
  }
  hud.textAlign = "left";
  hud.textBaseline = "top";
}

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
    // Lines too wide for the screen (English runs longer than Japanese) are drawn smaller to fit
    lines.forEach((line, i) => {
      const width = hud.measureText(line).width;
      const size = width > W - 8 ? Math.max(5, (8 * (W - 8)) / width) : 8;
      hud.font = `${size}px DotGothic16, monospace`;
      hud.fillText(line, W / 2, cy - h / 2 + 5 + i * 12 + (8 - size) / 2);
    });
    hud.font = "8px DotGothic16, monospace";
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
    hud.fillStyle = PALETTE.A; hud.fillText(`A ${marks(g.w[0])} ${t("hud.alive", { n: g.al[0] })}`, 22, 2);
    hud.fillStyle = PALETTE.B; hud.fillText(`B ${marks(g.w[1])} ${t("hud.alive", { n: g.al[1] })}`, 82, 2);
  }
  // 中央：残り時間
  hud.textAlign = "center";
  hud.fillStyle = "#c9c4b3";
  if (g.ph === "play") hud.fillText(fmtTime(g.t), W / 2 + 20, 2);
  // 右：自分の車種とHP
  hud.textAlign = "right";
  if (muted) { hud.fillStyle = "#8a8778"; hud.fillText(t(touchMode ? "hud.mutedTouch" : "hud.muted"), W - 4, 14); } // just under the bar
  if (me) {
    hud.fillStyle = PALETTE.flare;
    hud.fillText(`${t(`tank.${me.k}.name`)}  HP ${me.hp}`, W - 4, 2);
  }
  hud.textAlign = "left";

  if (g.ph === "wait") {
    banner([
      t("wait.line1", { mode: t(`mode.${g.mode}`), t: g.t }),
      t(g.owner ? (touchMode ? "wait.ownerTouch" : "wait.ownerKey") : "wait.guest") + t("wait.noFire"),
      settings ? settingsText(settings) : "",
      ...(inviteCode ? [t("wait.invite", { code: inviteCode }).trim()] : []),
    ], false, inviteCode ? H - 32 : H - 26); // 自機に重ならないよう画面下に出す
  } else if (g.ph === "countdown") {
    banner([String(g.t)], true);
  } else if (g.ph === "roundEnd") {
    banner([t("round.result", { r: g.r, result: resultText(g.rr) }), g.rr === "draw" ? "" : t("round.teamWins", { team: t(`team.${g.rr}`) })]);
  } else if (g.ph === "matchEnd") {
    const score = g.mode === "conquest" ? `A ${g.sc[0]} - ${g.sc[1]} B` : `A ${g.w[0]} - ${g.w[1]} B`;
    banner([t("match.result", { result: resultText(g.mr) }), t("match.back", { score })]);
  }
  // 観戦の案内（画面下）
  const note = !me ? t("note.spectate")
    : me.dead && g.ph === "play"
      ? (g.mode === "conquest" ? t("note.respawn", { s: curr.rs }) : t("note.watchAlly"))
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
    syncSettingsPanel(); // hide room-only panels once we're out of the room
    syncTouchBar();
    requestAnimationFrame(frame);
    return;
  }
  const nowMs = performance.now();
  const dt = Math.min(0.05, (nowMs - lastFrameAt) / 1000);
  predict(dt);
  lastFrameAt = nowMs;
  // 自機は予測位置で描く（スナップショット本体は補正に使うので書き換えない）
  const shown = interpolated();
  const tanks = shown.tanks.map((k) => (k.id === myId && pred ? { ...k, x: pred.x, y: pred.y, b: pred.body } : k));
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
  else touchAim = null;
  drawMap();
  drawFog(view, view ? view.a : 0);
  ctx.fillStyle = PALETTE.bullet;
  for (const [bx, by] of shown.snap.bullets) ctx.fillRect(Math.round(bx - cam.x) - 1, Math.round(by - cam.y) - 1, 2, 2);
  drawPoints();
  drawGhosts();
  for (const k of tanks) if (!k.dead) drawTank(k, k.id === myId);
  drawPins();
  drawMarks(view);
  drawPointLabels();
  drawNames(tanks);
  drawMinimap();
  drawHud(me);
  drawSticks();
  syncSettingsPanel();
  syncTouchBar();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// PWA: the service worker lets the game be installed to the home screen (see sw.js)
if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => { /* still playable without it */ }));
}

// ===== 効果音（jsfxr 系の設定値から生成して Web Audio API で再生。see sfx.js） =====
const SOUND = {
  hearDist: 260, // visible events fade out over this distance (px)
  panDist: 160, // horizontal offset (px) at which a sound is fully left/right
  hintVol: [0.8, 0.5, 0.3], // unseen gunfire volume by distance bucket (near, mid, far)
  master: 0.7, // overall volume
};
let muted = store.get("ft.mute") === "1";
let masterGain = null;
const buffers = new Map(); // effect name -> AudioBuffer, rendered on first use

function setMuted(on) {
  muted = on;
  store.set("ft.mute", on ? "1" : "0");
  if (masterGain) masterGain.gain.value = on ? 0 : SOUND.master;
  touchBar.querySelector("[data-act=sound]").textContent = t(on ? "touch.soundOff" : "touch.soundOn");
}
addEventListener("keydown", (e) => { if (e.code === "KeyM" && inGame()) setMuted(!muted); });
setMuted(muted); // show the saved setting on the button

// Play an effect at a volume (0..1), panned left (-1) .. right (+1) where supported
function play(name, vol = 1, pan = 0) {
  if (!audio || vol <= 0) return;
  if (!masterGain) {
    masterGain = audio.createGain();
    masterGain.gain.value = muted ? 0 : SOUND.master;
    masterGain.connect(audio.destination);
  }
  let buf = buffers.get(name);
  if (!buf) {
    const samples = synth(SFX[name], audio.sampleRate);
    buf = audio.createBuffer(1, samples.length, audio.sampleRate);
    buf.getChannelData(0).set(samples);
    buffers.set(name, buf);
  }
  const src = audio.createBufferSource(), g = audio.createGain();
  src.buffer = buf;
  g.gain.value = vol;
  let node = src.connect(g);
  if (pan && audio.createStereoPanner) {
    const p = audio.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    node = node.connect(p);
  }
  node.connect(masterGain);
  src.start();
}

// 試合の段階が変わったときの合図
function playPhase(g, team) {
  if (g.ph === "countdown") play("count");
  else if (g.ph === "play") play("go");
  else if (g.ph === "roundEnd" || g.ph === "matchEnd") {
    const r = g.ph === "roundEnd" ? g.rr : g.mr;
    play(r === team ? "win" : "lose");
  }
}

function playEvent(e) {
  if (!audio || !curr) return;
  // Capture point changed owner: heard everywhere, rising for us, falling for them
  if (e.e === "cap") return play(e.team === curr.team ? "capture" : "lost");
  // Unseen gunfire: only a rough direction and distance; a duller shot panned toward it
  if (e.e === "shot") return play("hint", SOUND.hintVol[e.d], Math.cos(e.dir) * 0.9);
  // 音の距離は、いま見ている視点（自機、または観戦中の味方）から測る。左右は横方向のずれで振る
  const me = curr.tanks.find((k) => k.id === curr.view);
  const dist = me ? Math.hypot(me.x - e.x, me.y - e.y) : 0;
  const vol = Math.max(0, 1 - dist / SOUND.hearDist); // 遠いほど小さく
  const pan = me ? (e.x - me.x) / SOUND.panDist : 0;
  if (vol <= 0) return;
  if (e.e === "fire") play(FIRE_SFX[e.k] ?? "fireMedium", vol, pan);
  else if (e.e === "wall") play("wall", vol, pan);
  else if (e.e === "hit") play("hit", vol, pan);
  else if (e.e === "kill") play("kill", vol, pan);
}
