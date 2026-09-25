// 動作確認用：3クライアント（A・B・Aの順に参加）で接続し、撃ち合いと視界の絞り込みを確認する
// 使い方：別ターミナルで `npm run dev` を起動してから `npm run test:smoke`
import { makeGrid, stepTank, canSeePoint, canSeeTank, lineOfSight, visibilityPolygon, isWall, TICK_MS, TILE, VISION } from "../public/shared.js";

const BASE = process.env.WS_URL || "ws://localhost:8787/ws";
const room = "smoke-" + Date.now();
const DURATION = 20000;
let grid = null;

// 参加して init を受け取るまで待つ（順番に参加させてチームを A・B・A に固定する）
function join() {
  return new Promise((resolve, reject) => {
    const c = { ws: new WebSocket(`${BASE}?room=${room}`), id: null, onSnap: null };
    c.ws.onerror = () => reject(new Error("接続できません。npm run dev は起動していますか？"));
    c.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === "init") { c.id = m.id; grid ??= makeGrid(m.map); resolve(c); }
      else if (m.t === "s" && c.onSnap) c.onSnap(m);
    };
  });
}
// 入力には確認番号 q を付ける（クライアントの予測補正と同じ形式）
const send = (c, m) => {
  if (c.ws.readyState !== 1) return;
  c.q = (c.q || 0) + 1;
  c.sentAt = { ...c.sentAt, [c.q]: Date.now() };
  c.ws.send(JSON.stringify({ t: "in", q: c.q, aim: 0, fire: false, ...m }));
};
const view = (k) => ({ x: k.x, y: k.y, aim: k.a });

const a = await join(); // チームA：撃つ側
const b = await join(); // チームB：近づいて撃たれる側
const c = await join(); // チームA：その場で待機（味方表示の確認用）
const t0 = Date.now();

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
  const pts = visibilityPolygon(grid, vx, vy, VISION.range);
  for (let k = 0; k < 50; k++) {
    const r = Math.random() * VISION.range * 0.95, th = Math.random() * Math.PI * 2;
    const px = vx + Math.cos(th) * r, py = vy + Math.sin(th) * r;
    if (isWall(grid, px, py)) continue;
    inPolygon(pts, px, py) === lineOfSight(grid, vx, vy, px, py) ? poly.same++ : poly.diff++;
  }
}

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
};
const ratioOk = (ok, ng, min) => ok > 0 && ok / (ok + ng) >= min;

// A・Bとも上部の通路へ移動 → Bは左へ接近 → Aは見えたら狙って撃つ
send(a, { mx: 0, my: -1 });
send(b, { mx: 0, my: -1 });
let bTurned = false, aPrev = null;

a.onSnap = (m) => {
  const el = Date.now() - t0;
  if (m.q > st.lastAck) { st.rtts.push(Date.now() - a.sentAt[m.q]); st.lastAck = m.q; }
  const me = m.tanks.find((k) => k.id === a.id);
  const en = m.tanks.find((k) => k.team !== me.team);
  m.tanks.some((k) => k.id === c.id) ? st.allyShown++ : st.allyMissing++;
  if (en) {
    if (el < 2000) st.earlyLeak++;
    canSeeTank(grid, view(me), en) ? st.enemyOk++ : st.enemyNg++;
  }

  // サーバーの移動結果が共有の stepTank と一致するか（入力が上移動で一定の間だけ比べる）
  if (aPrev && el > 500 && el < 3500) {
    const pred = { x: aPrev.x, y: aPrev.y, body: 0 };
    stepTank(grid, pred, 0, -1, TICK_MS / 1000);
    Math.abs(pred.x - me.x) < 0.15 && Math.abs(pred.y - me.y) < 0.15 ? st.moveSame++ : st.moveDiff++;
  }
  aPrev = me;

  if (el < 4000) return;
  if (en) send(a, { mx: 0, my: 0, aim: Math.round(Math.atan2(en.y - me.y, en.x - me.x) * 100) / 100, fire: true });
};

b.onSnap = (m) => {
  snaps++;
  m.ev.forEach((x) => events.add(x.e));
  const me = m.tanks.find((k) => k.id === b.id);
  // Bに味方はいないので、届く弾はすべてAの弾。視界内のものだけのはず
  for (const [x, y] of m.bullets) canSeePoint(grid, view(me), x, y) ? st.bulletOk++ : st.bulletNg++;
  for (const e of m.ev) {
    if (e.e === "fire") canSeePoint(grid, view(me), e.x, e.y) ? st.fireOk++ : st.fireNg++;
  }
  if (!bTurned && Date.now() - t0 > 4000) { bTurned = true; send(b, { mx: -1, my: 0 }); }
};

setTimeout(() => {
  const checks = [
    ["スナップショット受信 >100", snaps > 100, `snapshots=${snaps}`],
    ["発射・被弾・撃破イベント", ["fire", "hit", "kill"].every((k) => events.has(k)), `events=${[...events].join(",")}`],
    ["移動が共有コードと一致 ≥95%", st.moveSame > 20 && ratioOk(st.moveSame, st.moveDiff, 0.95), `same=${st.moveSame} diff=${st.moveDiff}`],
    ["入力の確認番号が返る", st.lastAck === a.q && st.lastAck > 1, `ack=${st.lastAck} sent=${a.q}`],
    ["確認番号の往復 <500ms", st.rtts.length > 0 && Math.max(...st.rtts) < 500, `max=${Math.max(...st.rtts)}ms`],
    ["可視ポリゴンが見通し線と一致 ≥98%", ratioOk(poly.same, poly.diff, 0.98), `same=${poly.same} diff=${poly.diff}`],
    ["味方は常に送られる", st.allyShown > 100 && st.allyMissing === 0, `shown=${st.allyShown} missing=${st.allyMissing}`],
    ["離れている間は敵が送られない", st.earlyLeak === 0, `leak=${st.earlyLeak}`],
    ["送られた敵は視界内 ≥95%", ratioOk(st.enemyOk, st.enemyNg, 0.95), `ok=${st.enemyOk} ng=${st.enemyNg}`],
    ["送られた敵弾は視界内 ≥95%", ratioOk(st.bulletOk, st.bulletNg, 0.95), `ok=${st.bulletOk} ng=${st.bulletNg}`],
    ["送られた敵の発射は視界内", st.fireNg === 0, `ok=${st.fireOk} ng=${st.fireNg}`],
  ];
  for (const [name, ok, detail] of checks) console.log(`${ok ? "ok  " : "NG  "} ${name}（${detail}）`);
  const ok = checks.every((x) => x[1]);
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
}, DURATION);
