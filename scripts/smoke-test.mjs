// 動作確認用：3クライアント（A・B・Aの順に参加）で接続し、撃ち合いと視界の絞り込みを確認する。
// 空いた枠は bot が埋めるので、このシナリオではデバッグ用コマンドで bot を止めておく。
// 別の部屋で bot の巡回と、切断した戦車を bot が引き継ぐことも並行して確認する
// 使い方：別ターミナルで `npm run dev` を起動してから `npm run test:smoke`
import {
  makeGrid, stepTank, canSeePoint, canSeeTank, lineOfSight, visibilityPolygon, isWall, angleDiff, tankSpec, TICK_MS, TILE,
} from "../public/shared.js";
import { botChecks } from "./bot-checks.mjs";
import { updateGhosts, GHOST } from "../public/ghosts.js";
import { STICK, stickVector, moveFromStick, aimFromStick, assistAim } from "../public/touch.js";
import { sample, pushSnapshot, INTERP } from "../public/interp.js";
import { minimapLayout, minimapDots, minimapWalls, MINIMAP } from "../public/minimap.js";
import { readFileSync } from "node:fs";
import { SFX, FIRE_SFX, synth } from "../public/sfx.js";
import { STRINGS, LANGS, t as tr, setLang, detectLang } from "../public/i18n.js";
import { generateMap, assemble, validate, disjointPaths, GEN } from "../src/mapgen.ts";
import { RANDOM_CHUNKS, BASE_CHUNK, POINT_CHUNK, PLAZA_CHUNK, CHUNK, transform } from "../src/chunks.ts";
import vm from "node:vm";
import { signToken, verifyToken, checkName, uniqueName, newGuestId } from "../src/guest.ts";
import { LOBBY, pickQuick, expired, newCode, rateLimited, overBudget, publicList } from "../src/lobby.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";

const BASE = process.env.WS_URL || "ws://localhost:8787/ws";
const HTTP = BASE.replace(/^ws/, "http").replace(/\/ws$/, "");
// Turnstile: npm run dev uses Cloudflare's always-pass test keys, which accept this dummy token
const TS = "XXXX.DUMMY.TOKEN.XXXX";
// Each run poses as its own IP (dev only) so the per-IP room creation limit doesn't carry over between runs
const TEST_IP = `10.${Date.now() % 250}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
// Get a signed guest token (spec: guest identity). Returns {status, body}
async function guest(name, token) {
  const res = await fetch(`${HTTP}/api/guest`, { method: "POST", body: JSON.stringify({ name, token }) });
  return { status: res.status, body: await res.json() };
}
const room = "smoke-" + Date.now();
// The main scenario runs until B is destroyed (at least MIN_MS, at most MAX_MS): under load the server
// ticks slower and B takes longer to reach A, so a fixed duration made the test flaky
const MIN_MS = 20000;
const MAX_MS = 40000;
let grid = null;

// 参加して最初のスナップショットを受け取るまで待つ（順番に参加させてチームを A・B・A に固定する）
// c.id は自分が操作している戦車のID（bot の枠を引き継ぐので、スナップショットの me で知る）
// who: {name, token} to join as a given guest (a fresh guest token is fetched otherwise).
// who.lobby: the room was created through the lobby; otherwise it's a dev-only ad-hoc room (adhoc=1)
async function join(tank, roomName = room, extra = "", who = {}) {
  const name = who.name ?? "tester";
  const token = who.token ?? (await guest(name)).body.token;
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({ room: roomName, tank, token, name, ts: TS });
    if (!who.lobby) q.set("adhoc", "1");
    const c = { ws: new WebSocket(`${BASE}?${q}${extra}`), id: null, onSnap: null, token, name };
    c.ws.onerror = () => reject(new Error("接続できません。npm run dev は起動していますか？"));
    c.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === "init") { grid ??= makeGrid(m.map); c.init = m; c.settings = m.settings; }
      else if (m.t === "cfg") { c.settings = m.settings; c.points = m.points; if (m.map) c.map = m.map; }
      else if (m.t === "players") c.players = m.players;
      else if (m.t === "stats") c.stats = m;
      else if (m.t === "s") {
        c.id = m.me; // 観戦中は null
        c.last = m;
        resolve(c);
        if (c.onSnap) c.onSnap(m);
      }
    };
  });
}
const debug = (c, m) => c.ws.send(JSON.stringify({ t: "dbg", ...m }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 条件を満たすまで待つ（満たせば true、時間切れなら false）
const until = (cond, ms = 5000) => new Promise((resolve) => {
  const start = Date.now();
  const iv = setInterval(() => {
    if (cond()) { clearInterval(iv); resolve(true); } else if (Date.now() - start > ms) { clearInterval(iv); resolve(false); }
  }, 20);
});
// 待機中の部屋をすぐ対戦に進める（部屋主が開始 → カウントダウンを飛ばす）
async function startNow(owner) {
  owner.ws.send(JSON.stringify({ t: "start" }));
  const counted = await until(() => owner.last.g.ph === "countdown", 2000);
  debug(owner, { phaseSec: 0 });
  const playing = await until(() => owner.last.g.ph === "play", 2000);
  return `${counted ? "countdown" : "no-countdown"}/${playing ? "play" : owner.last.g.ph}`;
}
// 入力には確認番号 q を付ける（クライアントの予測補正と同じ形式）
const send = (c, m) => {
  if (c.ws.readyState !== 1) return;
  c.q = (c.q || 0) + 1;
  c.sentAt = { ...c.sentAt, [c.q]: Date.now() };
  c.ws.send(JSON.stringify({ t: "in", q: c.q, aim: 0, fire: false, ...m }));
};
const view = (k) => ({ x: k.x, y: k.y, aim: k.a, type: k.k });

const a = await join("medium"); // チームA：撃つ側
debug(a, { freezeBots: true });
const b = await join("medium"); // チームB：近づいて撃たれる側
const c = await join("light"); // チームA：少し下へ動いて待機（味方表示・軽戦車の確認用）
const startedOk = await startNow(a);
const t0 = Date.now();

// ===== 別の部屋：bot の巡回と、切断した戦車の引き継ぎ =====
const bots = { moved: 0, takenOver: false, alliesMax: 0, fires: 0, botPins: 0 };
(async () => {
  const room2 = room + "-bots";
  const x = await join("medium", room2, "&bot=5"); // A。最初の人が bot の強さを決める
  await join("medium", room2); // B
  const z = await join("heavy", room2); // A。1秒後に切断する
  await startNow(x);
  const start = new Map();
  x.onSnap = (m) => {
    const team = m.tanks.filter((k) => k.team === "A");
    bots.alliesMax = Math.max(bots.alliesMax, team.length);
    bots.fires += m.ev.filter((e) => e.e === "fire").length; // x は撃たないので、味方 bot か見えた敵 bot の発射
    bots.botPins += m.pins.filter((p) => p.by !== x.id).length; // pins from Lv5 ally bots
    for (const k of team) {
      if (!k.bot) continue;
      if (!start.has(k.id)) start.set(k.id, k);
      const s0 = start.get(k.id);
      if (k.id !== z.id && Math.hypot(k.x - s0.x, k.y - s0.y) > 24) bots.moved++;
      if (k.id === z.id && k.k === "heavy") bots.takenOver = true;
    }
  };
  setTimeout(() => z.ws.close(), 1000);
})();

// ===== 別の部屋：殲滅モードの流れ（bot は止め、デバッグ用コマンドで状況を作る） =====
const flow = [];
const step = (name, ok, detail = "") => flow.push([name, ok, detail]);
const flowDone = (async () => {
  const room3 = room + "-match";
  const p = await join("medium", room3); // A。部屋主
  const q = await join("heavy", room3); // B
  debug(p, { freezeBots: true });
  const g = () => p.last.g;
  step("待機から始まる（30秒）", await until(() => g().ph === "wait" && g().t > 20), `ph=${g().ph} t=${g().t}`);
  q.ws.send(JSON.stringify({ t: "start" }));
  await sleep(300);
  step("部屋主以外は開始できない", g().ph === "wait", `ph=${g().ph}`);
  p.ws.send(JSON.stringify({ t: "start" }));
  await until(() => g().ph === "countdown");
  const x0 = p.last.tanks.find((k) => k.id === p.id).x;
  send(p, { mx: 1, my: 0 });
  await sleep(500);
  const x1 = p.last.tanks.find((k) => k.id === p.id).x;
  step("カウントダウン中は動けない", g().ph === "countdown" && x0 === x1, `x=${x0}→${x1}`);
  step("カウントダウン後に対戦が始まる", await until(() => g().ph === "play", 4000), `ph=${g().ph} t=${g().t}`);
  send(p, { mx: 0, my: 0 });

  const r = await join("light", room3); // 対戦中に参加 → 観戦
  const rView = r.last.tanks.find((k) => k.id === r.last.view);
  step("対戦中の参加者は味方の視点で観戦", r.id === null && rView?.team === r.last.team, `me=${r.id} view=${r.last.view}`);

  debug(p, { killTeam: "B" });
  step("全滅したチームの負け", await until(() => g().ph === "roundEnd" && g().rr === "A" && g().w[0] === 1), `rr=${g().rr} w=${g().w}`);
  await sleep(1000);
  step("殲滅モードは復活しない", q.last.tanks.filter((k) => k.team === "B").every((k) => k.dead), `al=${g().al}`);

  debug(p, { phaseSec: 0 });
  step("次のラウンドで観戦者が参加する", await until(() => g().r === 2 && r.id !== null), `r=${g().r} me=${r.id}`);
  await until(() => g().ph === "countdown" || g().ph === "play");
  debug(p, { phaseSec: 0 });
  await until(() => g().ph === "play");
  debug(p, { hpTeam: "B", hp: 1 });
  await sleep(200);
  debug(p, { phaseSec: 0 }); // 時間切れにする
  step("時間切れは残りHPの合計で判定", await until(() => g().ph === "roundEnd" && g().rr === "A" && g().w[0] === 2), `rr=${g().rr} w=${g().w}`);
  debug(p, { phaseSec: 0 });
  step("2ラウンド先取で試合終了", await until(() => g().ph === "matchEnd" && g().mr === "A"), `mr=${g().mr}`);
  debug(p, { phaseSec: 0 });
  step("試合後は同じ部屋で待機に戻る", await until(() => g().ph === "wait" && g().w[0] === 0 && g().r === 1), `ph=${g().ph} w=${g().w}`);
  step("部屋主にだけ owner が付く", p.last.g.owner === true && q.last.g.owner === false && r.last.g.owner === false);
})();

// ===== Another room: conquest mode flow (bots frozen; situations set up with debug commands) =====
const conquest = [];
const cstep = (name, ok, detail = "") => conquest.push([name, ok, detail]);
const conquestDone = (async () => {
  const room4 = room + "-conquest";
  const p = await join("medium", room4, "&mode=conquest"); // A, owner; the first player picks the mode
  const q = await join("medium", room4); // B
  debug(p, { freezeBots: true });
  const qEvents = [];
  q.onSnap = (m) => qEvents.push(...m.ev);
  const g = () => p.last.g;
  const pt = (id) => g().pts.find((x) => x.id === id);
  const P = Object.fromEntries(p.init.points.map((x) => [x.id, x]));
  const W = grid.w * TILE, H = grid.h * TILE;
  const near = (v, w) => Math.abs(v - w) < 0.5;
  cstep("拠点は3か所（Cは中央、A・Bは点対称）",
    p.init.points.length === 3 && near(P.A.x + P.B.x, W) && near(P.A.y + P.B.y, H) && near(P.C.x, W / 2) && near(P.C.y, H / 2)
      && ["A", "B", "C"].every((id) => !isWall(grid, P[id].x, P[id].y)),
    p.init.points.map((x) => `${x.id}(${x.x},${x.y})`).join(" "));

  await startNow(p);
  debug(p, { moveX: P.A.x, moveY: P.A.y });
  await sleep(1000);
  const p1 = pt("A").p;
  cstep("自チームだけが範囲内なら制圧が進む", p1 > 0.1 && p1 < 0.4 && pt("A").o === null, `progress=${p1}`);
  debug(q, { moveX: P.A.x + 8, moveY: P.A.y });
  await sleep(300);
  const c0 = pt("A").p;
  await sleep(500);
  cstep("敵味方が両方いると競合中で止まる", pt("A").c && pt("A").p === c0, `contested=${pt("A").c} ${c0}→${pt("A").p}`);
  debug(q, { moveX: P.B.x, moveY: P.B.y });
  const owned = await until(() => pt("A").o === "A", 6000);
  cstep("制圧が完了すると拠点を持つ", owned, `owner=${pt("A").o}`);
  // q's snapshot for the same tick may arrive a little after p's, so wait for it
  const notified = await until(() => qEvents.some((e) => e.e === "cap" && e.team === "A"), 1000);
  cstep("制圧は相手チームにも通知される", notified, `cap events=${qEvents.filter((e) => e.e === "cap").length}`);
  const s0 = g().sc[0];
  await sleep(2000);
  const gain = g().sc[0] - s0;
  cstep("拠点1か所につき毎秒1pt", gain >= 1 && gain <= 3, `+${gain}pt / 2s`);

  debug(p, { killTeam: "B" });
  await until(() => q.last.tanks.find((k) => k.id === q.id)?.dead);
  const deadAt = Date.now();
  const back = await until(() => !q.last.tanks.find((k) => k.id === q.id).dead, 7000);
  const sec = (Date.now() - deadAt) / 1000;
  const qTank = q.last.tanks.find((k) => k.id === q.id);
  cstep("撃破から5秒後に自陣で復活", back && sec > 4 && sec < 6.5 && qTank.x > W / 2, `${sec.toFixed(1)}s x=${qTank.x}`);

  const r = await join("light", room4); // joins mid-match
  cstep("途中参加は即参加（bot と交代）", r.id !== null && g().ph === "play", `me=${r.id}`);

  // Gunfire hints: q looks east, p is 200 px to the west (out of sight) and fires 5 shots northward
  debug(q, { moveX: P.C.x, moveY: P.C.y });
  send(q, { mx: 0, my: 0, aim: 0 });
  debug(p, { moveX: P.C.x - 200, moveY: P.C.y });
  await sleep(300);
  const hintStart = qEvents.length;
  send(p, { mx: 0, my: 0, aim: -Math.PI / 2, fire: true });
  await sleep(2700);
  send(p, { mx: 0, my: 0, aim: -Math.PI / 2, fire: false });
  await sleep(200);
  const hints = qEvents.slice(hintStart).filter((e) => e.e === "shot");
  const leaked = qEvents.slice(hintStart).filter((e) => e.e === "fire");
  cstep("見えない位置からの発砲は、向き（西）と距離「中」だけ届く",
    hints.length >= 4 && leaked.length === 0 && hints.every((e) => Math.abs(angleDiff(e.dir, Math.PI)) < 0.01 && e.d === 1),
    `hints=${hints.length} fire=${leaked.length} ${JSON.stringify(hints[0] ?? {})}`);

  debug(p, { score: { A: 499.5 } });
  cstep("先に500ptに届いたチームの勝ち", await until(() => g().ph === "matchEnd" && g().mr === "A"), `sc=${g().sc} mr=${g().mr}`);
  debug(p, { phaseSec: 0 });
  await until(() => g().ph === "wait");
  cstep("次の試合では拠点とポイントがリセット", g().sc[0] === 0 && g().pts.every((x) => x.o === null && x.p === 0), `sc=${g().sc}`);
  await startNow(p);
  debug(p, { score: { A: 3, B: 10 } });
  debug(p, { phaseSec: 0 });
  cstep("時間切れはポイントが多い側の勝ち", await until(() => g().ph === "matchEnd" && g().mr === "B"), `sc=${g().sc} mr=${g().mr}`);
})();

// ===== Another room: bots capture points on their own in conquest mode =====
const botCapture = { owned: null };
const botCaptureDone = (async () => {
  const x = await join("medium", room + "-botcap", "&mode=conquest&bot=3"); // idle human; the other 5 are bots
  await startNow(x);
  // Bots may fight or ambush on the way, so allow some time (walk ~4 s + capture 5 s when unhindered)
  const got = await until(() => x.last.g.pts.some((p) => p.o), 25000);
  botCapture.owned = got ? x.last.g.pts.filter((p) => p.o).map((p) => `${p.id}:${p.o}`).join(",") : null;
})();

// ===== Another room: room settings and friendly fire =====
const setting = [];
const sstep = (name, ok, detail = "") => setting.push([name, ok, detail]);
const settingsDone = (async () => {
  const room6 = room + "-settings";
  const p = await join("medium", room6, "&ff=1&rounds=1"); // A, owner
  const q = await join("medium", room6); // B
  const r = await join("medium", room6); // A (p's teammate)
  debug(p, { freezeBots: true });
  const g = () => p.last.g;
  sstep("部屋の設定がクエリから反映される", p.settings.ff === true && p.settings.winRounds === 1 && p.settings.mode === "elim",
    JSON.stringify(p.settings));
  const set = (c, settings) => c.ws.send(JSON.stringify({ t: "settings", settings }));
  set(q, { mode: "conquest" });
  await sleep(300);
  sstep("部屋主以外は設定を変えられない", p.settings.mode === "elim", `mode=${p.settings.mode}`);
  set(p, { mode: "conquest", botLevel: 5, winRounds: 9 });
  await until(() => p.settings.mode === "conquest");
  sstep("部屋主は待機中に設定を変えられる（不正な値は無視）",
    p.settings.mode === "conquest" && p.settings.botLevel === 5 && p.settings.winRounds === 1 && q.settings.mode === "conquest"
      && p.points?.length === 3, JSON.stringify(p.settings));
  set(p, { mode: "elim" });
  await until(() => p.settings.mode === "elim");

  await startNow(p);
  set(p, { mode: "conquest" });
  await sleep(300);
  sstep("対戦中は設定を変えられない", p.settings.mode === "elim", `mode=${p.settings.mode}`);

  // Friendly fire on: p shoots east into r standing 40 px away
  const shootAlly = async () => {
    const me = p.last.tanks.find((k) => k.id === p.id);
    debug(r, { moveX: me.x + 40, moveY: me.y });
    await sleep(200);
    const hp0 = p.last.tanks.find((k) => k.id === r.id).hp;
    send(p, { mx: 0, my: 0, aim: 0, fire: true });
    await sleep(900);
    send(p, { mx: 0, my: 0, aim: 0, fire: false });
    await sleep(300);
    return { lost: hp0 - p.last.tanks.find((k) => k.id === r.id).hp, self: p.last.tanks.find((k) => k.id === p.id).hp };
  };
  const on = await shootAlly();
  sstep("フレンドリーファイアありなら味方に当たる（自分には当たらない）", on.lost > 0 && on.self === tankSpec("medium").hp,
    `ally lost ${on.lost}hp, self ${on.self}hp`);

  debug(p, { killTeam: "B" });
  await until(() => g().ph === "roundEnd");
  debug(p, { phaseSec: 0 });
  sstep("1ラウンド先取の設定なら1勝で試合終了", await until(() => g().ph === "matchEnd" && g().mr === "A"), `ph=${g().ph} w=${g().w}`);
  debug(p, { phaseSec: 0 });
  await until(() => g().ph === "wait");
  set(p, { ff: false });
  await until(() => p.settings.ff === false);
  await startNow(p);
  const off = await shootAlly();
  sstep("フレンドリーファイアなしなら味方に当たらない", off.lost === 0, `ally lost ${off.lost}hp`);
})();

// ===== Another room: generated maps in a real room (seed, reproducibility, switching maps while waiting) =====
const mapRoom = [];
const mstep = (name, ok, detail = "") => mapRoom.push([name, ok, detail]);
const mapRoomDone = (async () => {
  const room8 = room + "-map";
  const p = await join("medium", room8, "&map=random&seed=777&mode=conquest"); // A, owner
  const q = await join("medium", room8); // B
  const want = generateMap(777);
  const mine = p.last.tanks.find((k) => k.id === p.id);
  const slot = Number(p.id.slice(1));
  mstep("自動生成マップの部屋：シードどおりのマップ・拠点・出撃位置が使われる",
    p.init.map.length === 128 && p.init.map.join("") === want.tiles.join("") && p.settings.mapSeed === 777
      && JSON.stringify(p.init.points.map(({ id, x, y }) => [id, x, y])) === JSON.stringify(want.points.map(({ id, x, y }) => [id, x, y]))
      && Math.hypot(mine.x - want.spawns.A[slot].x, mine.y - want.spawns.A[slot].y) < 1,
    `rows=${p.init.map.length} seed=${p.settings.mapSeed} me=(${mine.x},${mine.y})`);
  const set = (c, settings) => c.ws.send(JSON.stringify({ t: "settings", settings }));
  set(q, { mapSeed: 5 });
  set(p, { mapSeed: -5 });
  set(p, { mapSeed: 2 ** 31 });
  await sleep(400);
  mstep("シード値は部屋主だけが変えられ、範囲外の値は無視", p.settings.mapSeed === 777 && !p.map, `seed=${p.settings.mapSeed}`);
  set(p, { ...p.settings, mapSeed: 4242 });
  const switched = await until(() => p.map && q.map && p.settings.mapSeed === 4242);
  const next = generateMap(4242);
  await sleep(200);
  const moved = p.last.tanks.find((k) => k.id === p.id);
  mstep("待機中にシードを変えると全員に新しいマップが届き、出撃位置に戻る",
    switched && p.map.join("") === next.tiles.join("") && q.map.join("") === next.tiles.join("")
      && Math.hypot(moved.x - next.spawns.A[slot].x, moved.y - next.spawns.A[slot].y) < 1
      && p.points?.every((pt, i) => pt.x === next.points[i].x), `seed=${p.settings.mapSeed}`);
  set(p, { ...p.settings, mapSeed: null });
  await until(() => p.settings.mapSeed !== 4242 && p.settings.mapSeed !== null);
  mstep("シード値を空にすると、部屋が新しいシードを決めて設定に書き込む",
    Number.isInteger(p.settings.mapSeed) && p.settings.mapSeed !== 4242 && p.map.join("") === generateMap(p.settings.mapSeed).tiles.join(""),
    `seed=${p.settings.mapSeed}`);
  // Server load on a 128x128 map with bots running (the waiting phase lets them move around)
  debug(p, { stats: true }); // reset the counters
  await sleep(3000);
  p.stats = null;
  debug(p, { stats: true });
  await until(() => p.stats);
  mstep("128×128で bot が動く部屋の1ティックの処理時間（平均 <10ms、最大 <50ms）",
    p.stats && p.stats.ticks > 30 && p.stats.avgMs < 10 && p.stats.maxMs < 50,
    p.stats ? `avg ${p.stats.avgMs.toFixed(2)}ms max ${p.stats.maxMs.toFixed(1)}ms / ${p.stats.ticks} ticks` : "no stats");
  p.ws.close();
  q.ws.close();
})();

// Try to join and report how it ended: "ok" (got a snapshot) or the close code
async function tryJoin(roomName, who = {}) {
  const token = who.token ?? (await guest("x")).body.token;
  const q = new URLSearchParams({ room: roomName, tank: "medium", token, name: who.name ?? "x" });
  if (who.adhoc) q.set("adhoc", "1");
  if (!who.noTs) q.set("ts", TS);
  return new Promise((resolve) => {
    const ws = new WebSocket(`${BASE}?${q}`);
    ws.onmessage = (e) => { if (JSON.parse(e.data).t === "s") { resolve("ok"); ws.close(); } };
    ws.onclose = (e) => resolve(e.code);
    setTimeout(() => resolve("timeout"), 3000);
  });
}

// ===== Lobby: room list, create, invite code, quick join, kick, close =====
const lobbyChecks = [];
const lstep = (name, ok, detail = "") => lobbyChecks.push([name, ok, detail]);
const lobbyDone = (async () => {
  const token = (await guest("lobbyist")).body.token;
  const api = async (path, body, ip = TEST_IP) => {
    const r = await fetch(`${HTTP}${path}`, { method: "POST", headers: { "X-Test-IP": ip }, body: JSON.stringify({ token, ts: TS, ...body }) });
    return { status: r.status, body: await r.json() };
  };
  const lists = [];
  const watcher = new WebSocket(`${HTTP.replace(/^http/, "ws")}/lobby?token=${encodeURIComponent(token)}`);
  watcher.onmessage = (e) => lists.push(JSON.parse(e.data));
  lstep("ロビー：接続すると部屋一覧が届く", await until(() => lists[0]?.t === "rooms" && Array.isArray(lists[0].rooms)));
  const listed = (id) => lists.at(-1)?.rooms.find((r) => r.id === id);

  const unauth = await fetch(`${HTTP}/api/rooms`, { method: "POST", body: JSON.stringify({ token: "bad", ts: TS }) });
  lstep("トークンなしでは部屋を作れない", unauth.status === 401, `status=${unauth.status}`);
  const config = await (await fetch(`${HTTP}/api/config`)).json();
  lstep("Turnstile のサイトキーを配る", typeof config.turnstileSiteKey === "string" && config.turnstileSiteKey.length > 0);
  const noTs = await api("/api/rooms", { ts: "" });
  const noTsQuick = await api("/api/quick", { ts: undefined });
  lstep("Turnstile の確認なしでは部屋を作れない（クイック参加も）", noTs.status === 403 && noTsQuick.status === 403,
    `${noTs.status}/${noTsQuick.status}`);
  const pub = (await api("/api/rooms", { settings: { mode: "conquest", botLevel: 2, public: true } })).body;
  lstep("公開部屋を作ると一覧に配信される", await until(() => listed(pub.id)?.mode === "conquest" && listed(pub.id)?.humans === 0),
    JSON.stringify(listed(pub.id)));
  const priv = (await api("/api/rooms", { settings: { public: false, ff: true } })).body;
  await sleep(300);
  lstep("非公開部屋は一覧に出ない（6桁の招待コードが付く）", /^\d{6}$/.test(priv.code) && !listed(priv.id), `code=${priv.code}`);
  const byCode = await api("/api/code", { code: priv.code });
  const badCode = await api("/api/code", { code: "12ab" });
  lstep("招待コードで非公開部屋が見つかる（不正なコードは400）", byCode.body.id === priv.id && badCode.status === 400);

  const p = await join("medium", pub.id, "", { name: "Owner", lobby: true });
  const dflt = (await api("/api/rooms", { settings: { public: false } })).body;
  const d = await join("medium", dflt.id, "", { lobby: true });
  lstep("ロビーで作る部屋の既定は自動生成マップ（シードは部屋が決める）",
    d.settings.map === "random" && Number.isInteger(d.settings.mapSeed) && d.init.map.length === 128, `map=${d.settings.map} seed=${d.settings.mapSeed}`);
  d.ws.close();
  lstep("ロビーで作った部屋に入ると設定と招待コードが届く",
    p.settings.mode === "conquest" && p.settings.botLevel === 2 && p.init.code === pub.code, JSON.stringify(p.settings));
  lstep("入ると一覧の人数が増える", await until(() => listed(pub.id)?.humans === 1), JSON.stringify(listed(pub.id)));
  lstep("ロビーを通さない部屋には入れない（本番の動作）", (await tryJoin(`nope-${Date.now()}`)) === 4404);
  lstep("Turnstile の確認なしでは部屋に入れない", (await tryJoin(pub.id, { noTs: true })) !== "ok");
  const pv = await join("medium", priv.id, "", { lobby: true });
  lstep("非公開部屋にも入れる（設定が反映）", pv.settings.ff === true && pv.settings.public === false);

  const quick = (await api("/api/quick", {})).body;
  const qc = await join("medium", quick.id, "", { lobby: true });
  lstep("クイック参加は空きのある公開部屋に入る", !!quick.id && qc.settings.public === true, `room=${quick.id}`);
  qc.ws.close();

  const g = await join("medium", pub.id, "", { name: "Guest", lobby: true });
  await until(() => p.players?.length === 2);
  const target = p.players?.find((x) => x.name === "Guest");
  lstep("参加者一覧が届く（部屋主に印）", p.players?.find((x) => x.name === "Owner")?.owner === true && target && !target.owner,
    JSON.stringify(p.players));
  g.ws.send(JSON.stringify({ t: "kick", cid: p.players.find((x) => x.name === "Owner").cid }));
  await sleep(300);
  lstep("部屋主以外は追放できない", p.ws.readyState === 1);
  const kicked = new Promise((resolve) => { g.ws.onclose = (e) => resolve(e.code); });
  p.ws.send(JSON.stringify({ t: "kick", cid: target.cid }));
  lstep("部屋主は追放できる", (await Promise.race([kicked, sleep(2000)])) === 4005);
  lstep("追放された人は入り直せない", (await tryJoin(pub.id, { token: g.token, name: "Guest" })) === 4005);

  await startNow(p);
  lstep("対戦中は一覧で「対戦中」になる", await until(() => listed(pub.id)?.playing === true));
  debug(p, { closeWhenEmpty: true });
  p.ws.close();
  lstep("全員が抜けた部屋は一覧から消える", await until(() => lists.length && !listed(pub.id), 4000));
  lstep("閉じた部屋の古いリンクでは入れない", (await tryJoin(pub.id)) === 4404);
  pv.ws.close();
  watcher.close();

  // Per-IP creation limit (a fresh fake IP so earlier creations in this run don't count)
  const ip2 = TEST_IP + "-limit";
  const statuses = [];
  for (let i = 0; i <= LOBBY.createLimit; i++) statuses.push((await api("/api/rooms", { settings: { public: false } }, ip2)).status);
  lstep(`同じ接続元からの部屋作成は${LOBBY.createWindowSec / 60}分に${LOBBY.createLimit}回まで`,
    statuses.slice(0, -1).every((x) => x === 200) && statuses.at(-1) === 429, statuses.join(","));

  // Rooms report incoming message counts to the lobby's daily total
  const post = (path, body) => fetch(`${HTTP}${path}`, { method: "POST", body: JSON.stringify(body) });
  const usage = async () => (await (await post("/api/debug/usage", {})).json()).value;
  const counter = await join("medium", room + "-usage");
  debug(counter, { reportUsage: true }); // flush what's been counted so far (this message included)
  await sleep(300);
  const u0 = await usage();
  for (let i = 0; i < 30; i++) send(counter, { mx: i % 2, my: 0 });
  debug(counter, { reportUsage: true });
  await sleep(500);
  const u1 = await usage();
  lstep("部屋が受信メッセージ数をロビーに報告する", u1 - u0 >= 31, `+${u1 - u0}（送信31件）`);
  counter.ws.close();

  // Daily message budget: pretend today's total is past the cutoff, then restore it
  await post("/api/debug/usage", { value: LOBBY.dailyMessages * LOBBY.stopRatio });
  const over = await api("/api/rooms", { settings: { public: false } }, ip2 + "-b");
  await post("/api/debug/usage", { value: 0 });
  const after = await api("/api/rooms", { settings: { public: false } }, ip2 + "-b");
  lstep("受信メッセージが1日の上限に近いと新しい部屋を作れない", over.status === 503 && after.status === 200, `${over.status} -> ${after.status}`);
})();

// Lobby rules without the server
const lobbyLogic = (() => {
  const now = 10_000;
  const r = (id, extra = {}, set = {}) => ({ id, code: id, humans: 1, phase: "wait", createdAt: now, updatedAt: now,
    settings: { ...DEFAULT_SETTINGS, ...set }, ...extra });
  const rooms = [
    r("full", { humans: 6 }), r("private", {}, { public: false }), r("elimPlay", { phase: "play", humans: 4 }),
    r("conqPlay", { phase: "play" }, { mode: "conquest" }), r("wait1"), r("wait3", { humans: 3 }),
  ];
  const codes = new Set(Array.from({ length: 300 }, () => newCode(rooms)));
  let seq = 0;
  const fixed = () => [0.123456, 0.123456, 0.654321][seq++ % 3];
  return [
    ["ロビー：クイック参加は待機中で人の多い部屋→拠点制圧の対戦中→その他の順", pickQuick(rooms)?.id === "wait3"
      && pickQuick(rooms.filter((x) => x.phase !== "wait"))?.id === "conqPlay", ""],
    ["ロビー：一覧に非公開部屋と招待コードは出ない", publicList(rooms).every((x) => x.id !== "private" && !("code" in x)), ""],
    ["ロビー：だれも入らない部屋と通知の途絶えた部屋を片付ける", expired([
      r("idle", { humans: 0, updatedAt: now - LOBBY.idleSec - 1 }), r("fresh", { humans: 0 }),
      r("stale", { updatedAt: now - LOBBY.staleSec - 1 })], now).map((x) => x.id).join() === "idle,stale", ""],
    ["ロビー：招待コードは6桁で使用中と重ならない", [...codes].every((c) => /^\d{6}$/.test(c))
      && newCode([r("x", { code: "123456" })], fixed) === "654321", ""],
    ["ロビー：作成回数の上限と日ごとの上限の判定", rateLimited(Array(LOBBY.createLimit).fill(now), now) === null
      && rateLimited(Array(LOBBY.createLimit).fill(now - LOBBY.createWindowSec), now)?.length === 1
      && overBudget(LOBBY.dailyMessages) && !overBudget(0), ""],
  ];
})();

// ===== Guest identity: offline checks of src/guest.ts, then the API and a room =====
const guestChecks = [];
const gstep = (name, ok, detail = "") => guestChecks.push([name, ok, detail]);
const guestDone = (async () => {
  const secret = "test-secret";
  const gid = newGuestId();
  const tok = await signToken(secret, gid);
  const tampered = tok.slice(0, -2) + (tok.endsWith("A") ? "BB" : "AA");
  gstep("トークン：署名を検証でき、改ざん・別の鍵は拒否",
    (await verifyToken(secret, tok)) === gid && (await verifyToken(secret, tampered)) === null
      && (await verifyToken("other", tok)) === null && (await verifyToken(secret, "v1.x.1.y")) === null);
  const names = ["", "   ", "１２３４５６７８９０１２３", "Admin", "  よしお  ", "a\u0007b"].map((n) => checkName(n));
  gstep("名前：空・13文字・禁止語は拒否、前後の空白と制御文字は除く",
    names.slice(0, 4).every((r) => "error" in r) && names[4].name === "よしお" && names[5].name === "ab",
    JSON.stringify(names.map((r) => r.name ?? r.error)));
  gstep("同名には番号を付ける", uniqueName("Yoshi", new Set(["Yoshi", "Yoshi(2)"])) === "Yoshi(3)" && uniqueName("A", new Set()) === "A");

  const bad = await guest("x".repeat(13));
  const first = await guest("Yoshi");
  const again = await guest("Yoshi2", first.body.token);
  const forged = await guest("Yoshi", tampered);
  gstep("API：不正な名前は400、正しいトークンは同じゲストIDのまま名前だけ変わる",
    bad.status === 400 && first.status === 200 && again.body.gid === first.body.gid && again.body.name === "Yoshi2"
      && forged.body.gid !== first.body.gid, `bad=${bad.status} gid kept=${again.body.gid === first.body.gid}`);

  const noToken = await new Promise((resolve) => {
    const ws = new WebSocket(`${BASE}?room=${room}-guest&tank=medium&name=x&adhoc=1&ts=${TS}`);
    ws.onmessage = () => resolve(false);
    ws.onerror = ws.onclose = () => resolve(true);
    setTimeout(() => resolve(false), 3000);
  });
  gstep("トークンなしでは部屋に入れない", noToken);

  const room7 = room + "-guest";
  const p = await join("medium", room7, "", { name: "Yoshi" }); // A, owner
  debug(p, { freezeBots: true });
  const q = await join("heavy", room7, "", { name: "Yoshi" }); // B, same display name
  gstep("同じ部屋の同名は「Yoshi(2)」になる", p.init.name === "Yoshi" && q.init.name === "Yoshi(2)",
    `${p.init.name} / ${q.init.name}`);
  const myName = p.last.tanks.find((k) => k.id === p.id)?.n;
  const botName = p.last.tanks.find((k) => k.team === "A" && k.id !== p.id)?.n;
  gstep("スナップショットに名前が入る（bot は null）", myName === "Yoshi" && botName === null, `me=${myName} bot=${botName}`);

  await startNow(p);
  const tankId = q.id;
  q.ws.close();
  await until(() => q.last && false, 300);
  const q2 = await join("medium", room7, "", { name: "Yoshi", token: q.token });
  await until(() => q2.last?.me === tankId);
  gstep("切断から30秒以内なら、対戦中でも自分の戦車に戻れる（車種もそのまま）",
    q2.id === tankId && q2.last.tanks.find((k) => k.id === tankId)?.k === "heavy" && p.last.g.ph === "play",
    `before=${tankId} after=${q2.id}`);

  const closedWith = new Promise((resolve) => { q2.ws.onclose = (e) => resolve(e.code); });
  const q3 = await join("medium", room7, "", { name: "Yoshi", token: q.token });
  const code = await Promise.race([closedWith, sleep(2000).then(() => null)]);
  gstep("同じゲストが別の画面で入ると、古い接続を切って引き継ぐ", code === 4000 && q3.id === tankId, `close=${code} me=${q3.id}`);

  q3.ws.close();
  await sleep(300);
  debug(p, { expireReserve: true });
  const q4 = await join("medium", room7, "", { name: "Yoshi", token: q.token });
  gstep("30秒を過ぎたら戻れない（殲滅の対戦中なので観戦）", q4.id === null, `me=${q4.id}`);
})();

// 描画用の可視ポリゴンが、サーバーの見通し線判定と一致するか（通信なしで計算だけ確認する）
function inPolygon(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const poly = { same: 0, diff: 0 };
for (let n = 0; n < 200; n++) {
  const vx = Math.random() * grid.w * TILE, vy = Math.random() * grid.h * TILE;
  if (isWall(grid, vx, vy)) continue;
  const range = tankSpec("medium").range;
  const pts = visibilityPolygon(grid, vx, vy, range);
  for (let k = 0; k < 50; k++) {
    const r = Math.random() * range * 0.95, th = Math.random() * Math.PI * 2;
    const px = vx + Math.cos(th) * r, py = vy + Math.sin(th) * r;
    if (isWall(grid, px, py)) continue;
    inPolygon(pts, px, py) === lineOfSight(grid, vx, vy, px, py) ? poly.same++ : poly.diff++;
  }
}

// Afterimages (client only): checked without the server
const ghostChecks = (() => {
  const en = (x, extra = {}) => ({ id: "B0", team: "B", k: "medium", x, y: 50, b: 0, a: 0, hp: 100, dead: false, ...extra });
  const ally = { id: "A1", team: "A", k: "medium", x: 10, y: 10, b: 0, a: 0, hp: 100, dead: false };
  const snap = (tanks, ev = []) => ({ team: "A", tanks, ev });
  const g = new Map();
  updateGhosts(g, snap([ally, en(100)]), snap([ally]), 0);
  const left = g.get("B0")?.tank.x === 100 && !g.has("A1");
  updateGhosts(g, snap([ally]), snap([ally, en(120)]), 1);
  const reseen = !g.has("B0");
  updateGhosts(g, snap([ally, en(120)]), snap([ally]), 2);
  updateGhosts(g, snap([ally]), snap([ally]), 2 + GHOST.lifeSec + 0.1);
  const expired = !g.has("B0");
  updateGhosts(g, snap([ally, en(140)]), snap([ally]), 10);
  updateGhosts(g, snap([ally]), snap([ally], [{ e: "kill", x: 141, y: 50 }]), 10.1);
  const killed = !g.has("B0");
  updateGhosts(g, snap([ally, en(160)]), snap([ally, en(160, { dead: true })].filter((k) => !k.dead)), 20);
  return [
    ["残像：見えなくなった敵を最後の位置に残す（味方は残さない）", left],
    ["残像：再び見えたら消える", reseen],
    [`残像：${GHOST.lifeSec}秒で消える`, expired],
    ["残像：その場で撃破されたら消える", killed],
  ].map(([n, ok]) => [n, ok, ""]);
})();

// Touch controls (public/touch.js), checked without a browser
const touchChecks = (() => {
  const o = { x: 100, y: 100 };
  const at = (dx, dy) => stickVector(o, { x: o.x + dx, y: o.y + dy });
  const mv = (dx, dy) => { const m = moveFromStick(at(dx, dy)); return `${m.mx},${m.my}`; };
  const me = { x: 0, y: 0 };
  const enemy = (deg) => ({ x: Math.cos((deg * Math.PI) / 180) * 100, y: Math.sin((deg * Math.PI) / 180) * 100, dead: false });
  const deg = (r) => Math.round((r * 180) / Math.PI);
  return [
    ["スティック：遊びの範囲は無視し、8方向に丸める（WASD と同じ入力）",
      mv(5, 5) === "0,0" && mv(50, 0) === "1,0" && mv(-40, -38) === "-1,-1" && mv(10, 50) === "0,1", ""],
    ["スティック：半径より先は1に丸め、大きく倒すと自動射撃",
      at(500, 0).mag === 1 && aimFromStick(at(STICK.radius, 0)).fire && !aimFromStick(at(STICK.radius * 0.5, 0)).fire
        && !aimFromStick(at(3, 0)).active, ""],
    ["照準補助：近くの角度の敵にだけ少し寄せる（見えている敵のみ）",
      deg(assistAim(0, me, [enemy(10)], 200)) === 5 && deg(assistAim(0, me, [enemy(30)], 200)) === 0
        && deg(assistAim(0, me, [enemy(10)], 50)) === 0, `${deg(assistAim(0, me, [enemy(10)], 200))}°`],
  ].map(([n, ok, d]) => [n, ok, d]);
})();

// Interpolation buffer and minimap (public/interp.js, public/minimap.js), checked without a browser
const clientChecks = (() => {
  const tk = (id, x, extra = {}) => ({ id, team: "B", k: "medium", x, y: 0, b: 0, a: 0, hp: 100, dead: false, ...extra });
  const snap = (tanks) => ({ team: "A", me: "A0", tanks, bullets: [], ev: [], pins: [] });
  const buf = [];
  pushSnapshot(buf, snap([tk("B0", 0), tk("B1", 50)]), 1000);
  pushSnapshot(buf, snap([tk("B0", 30), tk("B2", 90)]), 1050);
  const mid = sample(buf, 1025);
  const late = sample(buf, 2000);
  for (let i = 0; i < INTERP.keep + 5; i++) pushSnapshot(buf, snap([]), 3000 + i);
  const layout = minimapLayout(40, 24);
  const big = minimapLayout(128, 128);
  // Stripes of wall / floor columns shade to about half; all wall = 1, all floor = 0
  const stripes = Array.from({ length: 128 }, () => Array.from({ length: 128 }, (_, x) => (x % 2 ? "#" : ".")).join(""));
  const half = minimapWalls(stripes, big);
  const full = minimapWalls(Array(128).fill("#".repeat(128)), big);
  const empty = minimapWalls(Array(128).fill(".".repeat(128)), big);
  const ghosts = new Map([["B5", { tank: tk("B5", 7), at: 0 }]]);
  const dots = minimapDots(snap([{ ...tk("A0", 1), team: "A" }, tk("B0", 2), tk("B9", 3, { dead: true })]), ghosts);
  return [
    ["補間：前後のスナップショットの間を補間し、見えなくなった戦車は描かない",
      mid.tanks.find((k) => k.id === "B0")?.x === 15 && !mid.tanks.some((k) => k.id === "B1") && mid.tanks.some((k) => k.id === "B2"),
      JSON.stringify(mid.tanks.map((k) => [k.id, k.x]))],
    ["補間：最新より先は先読みせず最新のまま、古いものは捨てる",
      late.tanks.find((k) => k.id === "B0")?.x === 30 && buf.length === INTERP.keep, ""],
    ["ミニマップ：画面上部の枠に収まる大きさ（40×24・128×128）", layout.w <= MINIMAP.maxW && layout.h <= MINIMAP.maxH && layout.w > 50
      && big.w <= MINIMAP.maxW && big.h <= MINIMAP.maxH && big.h >= 40, `${layout.w.toFixed(0)}x${layout.h.toFixed(0)} / ${big.w.toFixed(0)}x${big.h.toFixed(0)}`],
    ["ミニマップ：大きいマップは壁の割合で濃淡を付けて縮小する", Math.abs(half[0] - 0.5) < 0.2 && full[0] === 1 && empty[0] === 0,
      `${half[0].toFixed(2)}`],
    ["ミニマップ：味方・見えている敵・残像だけ（撃破された戦車は出さない）",
      dots.map((d) => `${d.kind}:${d.x}`).join() === "ally:1,enemy:2,ghost:7" && dots[0].me, JSON.stringify(dots.map((d) => d.kind))],
  ];
})();

// Sound effects (public/sfx.js): every effect the game plays exists and renders to sane samples
const sfxChecks = (() => {
  const game = readFileSync(new URL("../public/game.js", import.meta.url), "utf8");
  // Names passed straight to play("..."), and every preset name that appears anywhere in game.js / FIRE_SFX
  const direct = [...game.matchAll(/play\("(\w+)"/g)].map((m) => m[1]);
  const missing = direct.filter((n) => !SFX[n]);
  const unused = Object.keys(SFX).filter((n) => !game.includes(`"${n}"`) && !Object.values(FIRE_SFX).includes(n));
  const sr = 44100;
  const bad = [];
  for (const [name, p] of Object.entries(SFX)) {
    let seed = 1;
    const out = synth(p, sr, () => ((seed = (seed * 16807) % 2147483647) / 2147483647));
    const len = Math.round((p.attack + p.sustain + p.decay) * sr);
    const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    if (out.length !== len || peak <= 0.02 || peak > 1 || out.some(Number.isNaN)) bad.push(`${name}(peak ${peak.toFixed(2)})`);
  }
  const a = synth(SFX.fireLight, sr), b = synth(SFX.fireHeavy, sr);
  return [
    ["効果音：鳴らす音にはすべて設定があり、使われない設定もない", missing.length === 0 && unused.length === 0 && direct.length > 5,
      `missing=${missing.join(",")} unused=${unused.join(",")}`],
    ["効果音：どの音も長さどおりに生成され、無音でも音割れでもない", bad.length === 0, bad.join(" ")],
    ["効果音：車種で発射音が違う（重戦車は長く低い）", b.length > a.length, `${a.length} / ${b.length} samples`],
  ];
})();

// Generated maps (src/mapgen.ts, src/chunks.ts), checked without the server.
// Run at the end: generating 25 maps blocks the event loop, which would disturb the timed online checks
const mapChecks = () => {
  // Every part: 16x16, open outer ring, no sealed pockets, in every rotation / mirror
  const parts = { ...RANDOM_CHUNKS, base: BASE_CHUNK, point: POINT_CHUNK, plaza: PLAZA_CHUNK };
  const badParts = [];
  for (const [name, rows] of Object.entries(parts)) {
    for (let r = 0; r < 4; r++) {
      for (const flip of [false, true]) {
        const g = transform(rows, r, flip);
        const floor = (x, y) => g[y]?.[x] !== undefined && g[y][x] !== "#";
        const ring = [...Array(CHUNK).keys()].every((i) => floor(i, 0) && floor(i, CHUNK - 1) && floor(0, i) && floor(CHUNK - 1, i));
        const total = g.join("").replace(/#/g, "").length;
        const seen = new Set(["0,0"]);
        const q = [[0, 0]];
        while (q.length) {
          const [x, y] = q.pop();
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const k = `${x + dx},${y + dy}`;
            if (floor(x + dx, y + dy) && !seen.has(k)) { seen.add(k); q.push([x + dx, y + dy]); }
          }
        }
        if (g.length !== CHUNK || g.some((row) => row.length !== CHUNK) || !ring || seen.size !== total) badParts.push(`${name}/${r}${flip ? "f" : ""}`);
      }
    }
  }
  // Max flow on tiny maps: an open room vs. a one-tile choke point
  const mk = (rows) => ({ tiles: rows, w: rows[0].length, h: rows.length });
  const room = mk(["#######", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", "#######"]);
  const choke = mk(["#######", "#.....#", "#.....#", "###.###", "#.....#", "#.....#", "#######"]);
  const flowOk = disjointPaths(room, [3, 1], [3, 5], 5) === 3 && disjointPaths(room, [1, 1], [5, 5], 5) === 2
    && disjointPaths(choke, [3, 1], [3, 5], 5) === 1;
  // Many seeds: valid, point-symmetric, reproducible, and quick
  const seeds = Array.from({ length: 25 }, (_, i) => 1000 + i * 7919);
  const bad = [];
  const t = performance.now();
  const maps = seeds.map((seed) => generateMap(seed));
  const ms = (performance.now() - t) / seeds.length;
  for (const m of maps) {
    const fails = validate(m);
    const sym = m.tiles.every((row, y) => [...row].every((c, x) => c === m.tiles[m.h - 1 - y][m.w - 1 - x]));
    const spawnSym = m.spawns.A.every((s, i) => s.x + m.spawns.B[i].x === m.w * TILE && s.y + m.spawns.B[i].y === m.h * TILE);
    if (m.w !== 128 || m.h !== 128 || fails.length || !sym || !spawnSym) bad.push(`${m.seed}:${fails.join("/")}${sym ? "" : " asym"}`);
  }
  const again = generateMap(seeds[3]);
  const distinct = new Set(maps.map((m) => m.tiles.join(""))).size;
  return [
    ["マップ部品：16×16で外周は床、閉じた空間なし（全部品・全向き）", badParts.length === 0, badParts.join(" ")],
    ["マップ生成：最大流で経路数を数える（開けた部屋3本・狭い通路1本）", flowOk, ""],
    ["マップ生成：128×128で点対称、全体がつながり、拠点間に3本以上の経路、遮蔽物は適度（25シード）",
      bad.length === 0, bad.slice(0, 3).join(" ")],
    ["マップ生成：同じシードは同じマップ、シードが違えば別のマップ",
      again.tiles.join("") === maps[3].tiles.join("") && distinct === maps.length, `distinct=${distinct}/${maps.length}`],
    ["マップ生成：1枚あたりの生成時間 <200ms", ms < 200, `${ms.toFixed(0)}ms/枚`],
  ];
};

// English / Japanese text (public/i18n.js), checked without a browser
const i18nChecks = (() => {
  const JP = /[\u3040-\u30ff\u4e00-\u9fff]/;
  const [ja, en] = [STRINGS.ja, STRINGS.en];
  const holes = (v) => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  const onlyJa = Object.keys(ja).filter((k) => !(k in en));
  const onlyEn = Object.keys(en).filter((k) => !(k in ja));
  const holeDiff = Object.keys(ja).filter((k) => k in en && holes(ja[k]) !== holes(en[k]));
  const jpInEn = Object.entries(en).filter(([k, v]) => k !== "lang.switch" && JP.test(v)).map(([k]) => k);
  // Keys the client uses: literal t("...") calls, and the families built from values
  const game = readFileSync(new URL("../public/game.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const literal = [...game.matchAll(/\bt\(\s*"([\w.]+)"/g)].map((m) => m[1])
    .concat([...game.matchAll(/busyButton\([^,]+,\s*"([\w.]+)"/g)].map((m) => m[1]))
    .concat([...game.matchAll(/\bt\([^)]*\?\s*"([\w.]+)"\s*:\s*"([\w.]+)"/g)].flatMap((m) => [m[1], m[2]]));
  const families = [
    ...["light", "medium", "heavy"].flatMap((k) => [`tank.${k}.name`, `tank.${k}.role`]),
    "mode.elim", "mode.conquest", "team.A", "team.B", "close.4000", "close.4003", "close.4404", "close.4005",
  ];
  const fromHtml = [...html.matchAll(/data-i18n(?:-placeholder|-aria)?="([\w.]+)"/g)].map((m) => m[1]);
  const missing = [...new Set([...literal, ...families, ...fromHtml])].filter((k) => !(k in ja));
  // Japanese left in the page without a key (comments and styles excluded)
  const body = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<style>[\s\S]*?<\/style>/g, "");
  const untagged = [...body.matchAll(/<(\w+)([^>]*)>([^<]*)</g)]
    .filter(([, , attrs, text]) => JP.test(text) && !/data-i18n="/.test(attrs)).map(([, tag, , text]) => `<${tag}>${text.trim()}`)
    .concat([...body.matchAll(/<\w+([^>]*)>/g)].flatMap(([, attrs]) =>
      [["placeholder", "data-i18n-placeholder"], ["aria-label", "data-i18n-aria"]]
        .filter(([a, d]) => new RegExp(`${a}="[^"]*[\\u3040-\\u9fff]`).test(attrs) && !attrs.includes(d)).map(([a]) => a)));
  setLang("en");
  const filled = tr("lobby.players", { n: 2, cap: 6 });
  const fallback = tr("no.such.key");
  setLang("ja");
  return [
    ["多言語：日本語と英語で同じキー", !onlyJa.length && !onlyEn.length, `ja only=${onlyJa.join(",")} en only=${onlyEn.join(",")}`],
    ["多言語：差し込み値（{n} など）が両言語でそろう", !holeDiff.length, holeDiff.join(",")],
    ["多言語：英語の文に日本語が混じらない", !jpInEn.length, jpInEn.join(",")],
    ["多言語：game.js と index.html が使うキーはすべて辞書にある", !missing.length && literal.length > 40, `used=${literal.length} missing=${missing.join(",")}`],
    ["多言語：index.html にキーの付いていない日本語がない", !untagged.length, untagged.slice(0, 3).join(" ")],
    ["多言語：ブラウザの言語から判定（日本語以外は英語）", detectLang(["ja-JP", "en"]) === "ja" && detectLang(["en-US", "ja"]) === "en"
      && detectLang(["fr-FR"]) === "en" && detectLang(["fr", "ja"]) === "ja" && detectLang([]) === "en", ""],
    ["多言語：差し込み値の埋め込みと、キーがないときの扱い", filled === "2/6 players" && fallback === "no.such.key", filled],
  ];
})();

// ===== PWA: manifest, icons and service worker as served by the dev server =====
const pwaChecks = [];
const pwaDone = (async () => {
  const get = (path) => fetch(`${HTTP}${path}`);
  const manifest = await (await get("/manifest.json")).json();
  const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)]; // IHDR width/height
  const icons = await Promise.all(manifest.icons.map(async (i) => {
    const buf = Buffer.from(await (await get(i.src)).arrayBuffer());
    const sig = buf.subarray(1, 4).toString() === "PNG";
    return sig && pngSize(buf).join("x") === i.sizes;
  }));
  pwaChecks.push(["PWA：マニフェスト（全画面・横向き）とアイコン（PNGの大きさが宣言どおり）",
    manifest.display === "fullscreen" && manifest.orientation === "landscape" && manifest.start_url === "/"
      && icons.length >= 2 && icons.every(Boolean) && manifest.icons.some((i) => i.purpose === "maskable"), JSON.stringify(icons)]);
  const html = await (await get("/")).text();
  pwaChecks.push(["PWA：ページがマニフェスト・iOS 用アイコンを参照する",
    html.includes('rel="manifest"') && html.includes('rel="apple-touch-icon"') && (await get("/icons/apple-touch-icon.png")).ok, ""]);
  // The service worker source, run in a sandbox to call its request filter
  const src = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const sandbox = { self: { addEventListener() {}, location: { origin: HTTP } }, caches: {}, fetch() {}, URL };
  vm.runInNewContext(src, sandbox);
  const handles = (path, origin = HTTP) => sandbox.shouldHandle(new URL(path, origin), HTTP);
  pwaChecks.push(["PWA：Service Worker は画面のファイルだけ扱い、API・WebSocket・外部には触れない",
    handles("/game.js") && handles("/") && !handles("/api/guest") && !handles("/ws") && !handles("/lobby")
      && !handles("/turnstile/v0/api.js", "https://challenges.cloudflare.com"), ""]);
  const shell = [...src.matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]).filter((p) => !p.startsWith("/api") && p !== "/ws" && p !== "/lobby");
  const missing = [];
  for (const path of shell) if (!(await get(path)).ok) missing.push(path);
  // Every module game.js imports must be cached too, or the game can't start offline
  const game = readFileSync(new URL("../public/game.js", import.meta.url), "utf8");
  const imports = [...game.matchAll(/from "\.\/([\w.-]+)"/g)].map((m) => `/${m[1]}`);
  const uncached = imports.filter((f) => !shell.includes(f));
  // Registered once at the top level (a bad edit once put it inside frame(), adding a listener every frame)
  const registrations = (game.match(/serviceWorker\.register\(/g) ?? []).length;
  const frameBody = game.slice(game.indexOf("function frame()"), game.indexOf("\n}\n", game.indexOf("function frame()")));
  pwaChecks.push(["PWA：Service Worker の登録は1か所だけ（描画ループの中ではない）", registrations === 1 && !frameBody.includes("serviceWorker"),
    `count=${registrations}`]);
  pwaChecks.push(["PWA：game.js が読み込むファイルはすべて保存対象に入っている", imports.length >= 6 && uncached.length === 0,
    `imports=${imports.length} uncached=${uncached.join(",")}`]);
  pwaChecks.push(["PWA：保存対象のファイルがすべて取得できる（1つでも欠けるとインストールに失敗する）",
    shell.length >= 8 && missing.length === 0, `files=${shell.length} missing=${missing.join(",")}`]);
})();

// 確認項目の集計
const events = new Set();
let snaps = 0;
const st = {
  moveSame: 0, moveDiff: 0, // サーバーの移動と共有コードの一致
  allyShown: 0, allyMissing: 0, // 味方が常に送られるか
  earlyLeak: 0, // 開始直後（遠く離れている間）に敵が送られた回数
  enemyOk: 0, enemyNg: 0, // 送られた敵が本当に視界内か
  bulletOk: 0, bulletNg: 0, // Bに送られた（Aの）弾が視界内か
  fireOk: 0, fireNg: 0, // Bに送られた発射イベントが視界内か（自チーム分を除く）
  lastAck: 0, rtts: [], // サーバーが返した確認番号と、そこから測った往復時間
  hints: 0, hintBad: [], // unseen gunfire hints received by B, and any that break the rules
  hurts: 0, hurtBad: [], // hit directions received by B, and any not pointing at A
  hpOk: 0, hpNg: 0, // 各戦車の初期HPが車種どおりか
  turnMax: 0, // Aの砲塔が1ティックで回った最大角度
};
const ratioOk = (ok, ng, min) => ok > 0 && ok / (ok + ng) >= min;

// A・Bとも上部の通路へ移動 → Bは左へ接近 → Aは見えたら狙って撃つ
send(a, { mx: 0, my: -1 });
send(b, { mx: 0, my: -1 });
send(c, { mx: 0, my: 1 });
setTimeout(() => send(c, { mx: 0, my: 0 }), 1500);
setTimeout(() => send(a, { mx: 0, my: -1, aim: 3.14 }), 3500); // 180°振り向かせて旋回の上限を確かめる
// Pins: three in quick succession -> only one is accepted (rate limit)
setTimeout(() => { for (let i = 0; i < 3; i++) a.ws.send(JSON.stringify({ t: "pin", x: 100 + i * 10, y: 100 })); }, 1000);
const pinIds = new Set();
let bTurned = false, aPrev = null, cPrev = null;

// サーバーの移動結果が共有の stepTank と一致するか（入力が一定の間だけ比べる）
function checkMove(prevK, k, mx, my) {
  const p = { x: prevK.x, y: prevK.y, body: 0, type: prevK.k };
  stepTank(grid, p, mx, my, TICK_MS / 1000);
  Math.abs(p.x - k.x) < 0.15 && Math.abs(p.y - k.y) < 0.15 ? st.moveSame++ : st.moveDiff++;
}

a.onSnap = (m) => {
  const el = Date.now() - t0;
  if (m.q > st.lastAck) { st.rtts.push(Date.now() - a.sentAt[m.q]); st.lastAck = m.q; }
  const me = m.tanks.find((k) => k.id === a.id);
  const en = m.tanks.find((k) => k.team !== me.team);
  st.teamA = Math.max(st.teamA || 0, m.tanks.filter((k) => k.team === me.team).length);
  const ally = m.tanks.find((k) => k.id === c.id);
  ally ? st.allyShown++ : st.allyMissing++;
  for (const p of m.pins) if (p.by === a.id) pinIds.add(p.id);
  if (el < 400) for (const k of m.tanks) k.hp === tankSpec(k.k).hp ? st.hpOk++ : st.hpNg++;
  if (en) {
    if (el < 2000) st.earlyLeak++;
    canSeeTank(grid, view(me), en) ? st.enemyOk++ : st.enemyNg++;
  }

  if (aPrev && el > 500 && el < 3500) checkMove(aPrev, me, 0, -1);
  if (cPrev && ally && el > 300 && el < 1300) checkMove(cPrev, ally, 0, 1);
  if (aPrev) st.turnMax = Math.max(st.turnMax, Math.abs(angleDiff(me.a, aPrev.a)));
  aPrev = me; cPrev = ally;

  if (el < 4000) return;
  const target = m.tanks.find((k) => k.id === b.id);
  if (target) send(a, { mx: 0, my: 0, aim: Math.round(Math.atan2(target.y - me.y, target.x - me.x) * 100) / 100, fire: true });
  // After the turret test A faces west; look back east along the corridor where B comes from
  else if (!aLookedBack) { aLookedBack = true; send(a, { mx: 0, my: 0, aim: 0 }); }
};
let aLookedBack = false;

c.onSnap = (m) => { if (m.pins.some((p) => p.by === a.id)) st.allyGotPin = true; };
b.onSnap = (m) => {
  snaps++;
  if (m.pins.some((p) => !p.by.startsWith("B"))) st.pinLeak = true; // team B must never see team A's pins
  m.ev.forEach((x) => events.add(x.e));
  const me = m.tanks.find((k) => k.id === m.view); // 撃破後は味方の視点で絞り込まれる
  st.teamB = Math.max(st.teamB || 0, m.tanks.filter((k) => k.team === me.team).length);
  // Bの味方は止めた bot だけなので、届く弾はすべてAの弾。視界内のものだけのはず
  for (const [x, y] of m.bullets) canSeePoint(grid, view(me), x, y) ? st.bulletOk++ : st.bulletNg++;
  for (const e of m.ev) {
    if (e.e === "fire") canSeePoint(grid, view(me), e.x, e.y) ? st.fireOk++ : st.fireNg++;
    if (e.e === "fire" && e.k !== "medium") st.fireKindNg = (st.fireKindNg ?? 0) + 1; // only A (medium) shoots
  }
  // Only A shoots, so hints and hit directions should point roughly at A (a.last is from about the same tick)
  const shooter = a.last?.tanks.find((k) => k.id === a.id);
  const toShooter = shooter && Math.atan2(shooter.y - me.y, shooter.x - me.x);
  const sector = (Math.PI * 2) / 16;
  for (const e of m.ev.filter((e) => e.e === "shot")) {
    st.hints++;
    const quantized = Math.abs(e.dir / sector - Math.round(e.dir / sector)) < 0.01;
    const noCoords = !("x" in e) && !("y" in e);
    const aimed = toShooter !== undefined && Math.abs(angleDiff(e.dir, toShooter)) < 0.5;
    if (!quantized || !noCoords || ![0, 1, 2].includes(e.d) || !aimed) st.hintBad.push(JSON.stringify(e));
  }
  // Hit directions are about our own tank (the viewpoint switches to an ally on the tick we're destroyed)
  const own = m.tanks.find((k) => k.id === m.me);
  for (const dir of m.hurt) {
    st.hurts++;
    const toA = own && shooter && Math.atan2(shooter.y - own.y, shooter.x - own.x);
    if (toA === undefined || Math.abs(angleDiff(dir, toA)) > 0.6) st.hurtBad.push(dir);
  }
  // Turn toward A once B has reached the top corridor (by position, not by time: ticks may run slower under load)
  const bSelf = m.tanks.find((k) => k.id === b.id);
  if (!bTurned && bSelf && !bSelf.dead && bSelf.y < 2 * TILE && Date.now() - t0 > 4000) {
    bTurned = true;
    send(b, { mx: -1, my: 0 });
  }
};

(async () => {
  await sleep(MIN_MS);
  await until(() => events.has("kill"), MAX_MS - MIN_MS);
  await sleep(500); // let the last hit/kill snapshots arrive
  const elapsed = (Date.now() - t0) / 1000;
  await flowDone;
  await conquestDone;
  await botCaptureDone;
  await settingsDone;
  await guestDone;
  await lobbyDone;
  await mapRoomDone;
  await pwaDone;
  const checks = [
    ["スナップショット受信 >100", snaps > 100, `snapshots=${snaps}（${(snaps / elapsed).toFixed(1)}回/秒、${elapsed.toFixed(0)}秒）`],
    ["発射・被弾・撃破イベント", ["fire", "hit", "kill"].every((k) => events.has(k)),
      `events=${[...events].join(",")} start=${startedOk} ph=${a.last.g.ph} A=${JSON.stringify(a.last.tanks.find((k) => k.id === a.id))} B=${JSON.stringify(b.last.tanks.find((k) => k.id === b.id))}`],
    ["両チームとも3台（空き枠は bot）", st.teamA === 3 && st.teamB === 3, `A=${st.teamA} B=${st.teamB}`],
    ["bot が巡回で動く", bots.moved > 0, `moved=${bots.moved}`],
    ["bot が敵を見つけて撃つ（Lv5の部屋）", bots.fires > 0, `fire=${bots.fires}`],
    ...botChecks(),
    ...flow,
    ...conquest,
    ...setting,
    ...guestChecks,
    ...lobbyChecks,
    ...mapRoom,
    ...lobbyLogic,
    ["拠点制圧：bot が自分で拠点を取る", botCapture.owned !== null, `owned=${botCapture.owned}`],
    ["切断した戦車を bot が引き継ぐ", bots.takenOver && bots.alliesMax === 3, `takenOver=${bots.takenOver}`],
    ["初期HPが車種どおり", st.hpOk > 0 && st.hpNg === 0, `ok=${st.hpOk} ng=${st.hpNg}`],
    ["砲塔の旋回が上限どおり", Math.abs(st.turnMax - tankSpec("medium").turn * (TICK_MS / 1000)) < 0.02,
      `max=${st.turnMax.toFixed(3)}rad/tick`],
    ["移動が共有コードと一致 ≥95%", st.moveSame > 30 && ratioOk(st.moveSame, st.moveDiff, 0.95), `same=${st.moveSame} diff=${st.moveDiff}`],
    ["入力の確認番号が返る", st.lastAck === a.q && st.lastAck > 1, `ack=${st.lastAck} sent=${a.q}`],
    ["確認番号の往復 <500ms", st.rtts.length > 0 && Math.max(...st.rtts) < 500, `max=${Math.max(...st.rtts)}ms`],
    ["可視ポリゴンが見通し線と一致 ≥98%", ratioOk(poly.same, poly.diff, 0.98), `same=${poly.same} diff=${poly.diff}`],
    ["味方は常に送られる", st.allyShown > 100 && st.allyMissing === 0, `shown=${st.allyShown} missing=${st.allyMissing}`],
    ["離れている間は敵が送られない", st.earlyLeak === 0, `leak=${st.earlyLeak}`],
    ["送られた敵は視界内 ≥95%", ratioOk(st.enemyOk, st.enemyNg, 0.95), `ok=${st.enemyOk} ng=${st.enemyNg}`],
    ["送られた敵弾は視界内 ≥95%", ratioOk(st.bulletOk, st.bulletNg, 0.95), `ok=${st.bulletOk} ng=${st.bulletNg}`],
    ["ピンは味方に届き、敵には届かない", pinIds.size > 0 && st.allyGotPin && !st.pinLeak, `ally=${!!st.allyGotPin} leak=${!!st.pinLeak}`],
    ["ピンの連打は制限される（1秒に1本）", pinIds.size === 1, `accepted=${pinIds.size}`],
    ["Lv5 の bot がピンで味方に知らせる", bots.botPins > 0, `botPins=${bots.botPins}`],
    ["見えない敵の発砲は方向（16方向）と距離の段階だけ届く", st.hints > 0 && st.hintBad.length === 0,
      `hints=${st.hints} bad=${st.hintBad.slice(0, 2).join(" ")}`],
    ["被弾方向は撃った相手の方を向く", st.hurts > 0 && st.hurtBad.length === 0, `hurts=${st.hurts} bad=${st.hurtBad.length}`],
    ...ghostChecks,
    ...touchChecks,
    ...clientChecks,
    ...pwaChecks,
    ...sfxChecks,
    ...i18nChecks,
    ...mapChecks(),
    ["見えた発射には撃った車種が付く（発射音の切り替え用）", st.fireOk > 0 && !st.fireKindNg, `ng=${st.fireKindNg ?? 0}`],
    ["送られた敵の発射は視界内", st.fireNg === 0, `ok=${st.fireOk} ng=${st.fireNg}`],
  ];
  for (const [name, ok, detail] of checks) console.log(`${ok ? "ok  " : "NG  "} ${name}（${detail}）`);
  const ok = checks.every((x) => x[1]);
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
})();
