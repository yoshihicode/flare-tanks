// 動作確認用：3クライアント（A・B・Aの順に参加）で接続し、撃ち合いと視界の絞り込みを確認する。
// 空いた枠は bot が埋めるので、このシナリオではデバッグ用コマンドで bot を止めておく。
// 別の部屋で bot の巡回と、切断した戦車を bot が引き継ぐことも並行して確認する
// 使い方：別ターミナルで `npm run dev` を起動してから `npm run test:smoke`
import {
  makeGrid, stepTank, canSeePoint, canSeeTank, lineOfSight, visibilityPolygon, isWall, angleDiff, tankSpec, TICK_MS, TILE,
} from "../public/shared.js";

const BASE = process.env.WS_URL || "ws://localhost:8787/ws";
const room = "smoke-" + Date.now();
const DURATION = 20000;
let grid = null;

// 参加して最初のスナップショットを受け取るまで待つ（順番に参加させてチームを A・B・A に固定する）
// c.id は自分が操作している戦車のID（bot の枠を引き継ぐので、スナップショットの me で知る）
function join(tank, roomName = room) {
  return new Promise((resolve, reject) => {
    const c = { ws: new WebSocket(`${BASE}?room=${roomName}&tank=${tank}`), id: null, onSnap: null };
    c.ws.onerror = () => reject(new Error("接続できません。npm run dev は起動していますか？"));
    c.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === "init") grid ??= makeGrid(m.map);
      else if (m.t === "s") {
        if (!c.id) { c.id = m.me; resolve(c); }
        if (c.onSnap) c.onSnap(m);
      }
    };
  });
}
const debug = (c, m) => c.ws.send(JSON.stringify({ t: "dbg", ...m }));
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
const t0 = Date.now();

// ===== 別の部屋：bot の巡回と、切断した戦車の引き継ぎ =====
const bots = { moved: 0, takenOver: false, alliesMax: 0 };
(async () => {
  const room2 = room + "-bots";
  const x = await join("medium", room2); // A
  await join("medium", room2); // B
  const z = await join("heavy", room2); // A。1秒後に切断する
  const start = new Map();
  x.onSnap = (m) => {
    const team = m.tanks.filter((k) => k.team === "A");
    bots.alliesMax = Math.max(bots.alliesMax, team.length);
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
};

b.onSnap = (m) => {
  snaps++;
  m.ev.forEach((x) => events.add(x.e));
  const me = m.tanks.find((k) => k.id === b.id);
  st.teamB = Math.max(st.teamB || 0, m.tanks.filter((k) => k.team === me.team).length);
  // Bの味方は止めた bot だけなので、届く弾はすべてAの弾。視界内のものだけのはず
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
    ["両チームとも3台（空き枠は bot）", st.teamA === 3 && st.teamB === 3, `A=${st.teamA} B=${st.teamB}`],
    ["bot が巡回で動く", bots.moved > 0, `moved=${bots.moved}`],
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
    ["送られた敵の発射は視界内", st.fireNg === 0, `ok=${st.fireOk} ng=${st.fireNg}`],
  ];
  for (const [name, ok, detail] of checks) console.log(`${ok ? "ok  " : "NG  "} ${name}（${detail}）`);
  const ok = checks.every((x) => x[1]);
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
}, DURATION);
