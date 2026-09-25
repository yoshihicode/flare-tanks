// 動作確認用：2クライアントで接続し、撃ち合って被弾・撃破イベントが出るか確認する
// 使い方：別ターミナルで `npm run dev` を起動してから `npm run test:smoke`
import { makeGrid, stepTank, TICK_MS } from "../public/shared.js";

const BASE = process.env.WS_URL || "ws://localhost:8787/ws";
const room = "smoke-" + Date.now();
const a = new WebSocket(`${BASE}?room=${room}`);
const b = new WebSocket(`${BASE}?room=${room}`);
const events = new Set();
let snaps = 0;
const t0 = Date.now();
const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify({ t: "in", aim: 0, fire: false, ...m }));

// 確認項目の集計
const stats = { moveSame: 0, moveDiff: 0 };
let grid = null, aPrev = null;

// 両者とも上部の通路へ移動 → Bは左へ接近 → Aが狙って撃つ
a.onopen = () => send(a, { mx: 0, my: -1 });
b.onopen = () => send(b, { mx: 0, my: -1 });
let bTurned = false;
b.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.t !== "s") return;
  snaps++;
  m.ev.forEach((x) => events.add(x.e));
  if (!bTurned && Date.now() - t0 > 4000) { bTurned = true; send(b, { mx: -1, my: 0 }); }
};
a.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.t === "init") { grid = makeGrid(m.map); return; }
  if (m.t !== "s") return;
  const el = Date.now() - t0;
  const me = m.tanks.find((k) => k.team === "A");

  // サーバーの移動結果が共有の stepTank と一致するか（入力が上移動で一定の間だけ比べる）
  if (aPrev && me && el > 500 && el < 3500) {
    const pred = { x: aPrev.x, y: aPrev.y, body: 0 };
    stepTank(grid, pred, 0, -1, TICK_MS / 1000);
    const same = Math.abs(pred.x - me.x) < 0.15 && Math.abs(pred.y - me.y) < 0.15;
    same ? stats.moveSame++ : stats.moveDiff++;
  }
  aPrev = me;

  if (el < 4000) return;
  const en = m.tanks.find((k) => k.team === "B");
  if (me && en) send(a, { mx: 0, my: 0, aim: Math.round(Math.atan2(en.y - me.y, en.x - me.x) * 100) / 100, fire: true });
};

setTimeout(() => {
  const checks = [
    ["スナップショット受信 >100", snaps > 100, `snapshots=${snaps}`],
    ["発射・被弾・撃破イベント", ["fire", "hit", "kill"].every((k) => events.has(k)), `events=${[...events].join(",")}`],
    ["移動が共有コードと一致 ≥95%", stats.moveSame > 20 && stats.moveSame / (stats.moveSame + stats.moveDiff) >= 0.95,
      `same=${stats.moveSame} diff=${stats.moveDiff}`],
  ];
  for (const [name, ok, detail] of checks) console.log(`${ok ? "ok  " : "NG  "} ${name}（${detail}）`);
  const ok = checks.every((c) => c[1]);
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
}, 15000);
