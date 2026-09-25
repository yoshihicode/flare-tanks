// 動作確認用：2クライアントで接続し、撃ち合って被弾・撃破イベントが出るか確認する
// 使い方：別ターミナルで `npm run dev` を起動してから `npm run test:smoke`
const BASE = process.env.WS_URL || "ws://localhost:8787/ws";
const room = "smoke-" + Date.now();
const a = new WebSocket(`${BASE}?room=${room}`);
const b = new WebSocket(`${BASE}?room=${room}`);
const events = new Set();
let snaps = 0;
const t0 = Date.now();
const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify({ t: "in", aim: 0, fire: false, ...m }));

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
  if (m.t !== "s" || Date.now() - t0 < 4000) return;
  const me = m.tanks.find((k) => k.team === "A"), en = m.tanks.find((k) => k.team === "B");
  if (me && en) send(a, { mx: 0, my: 0, aim: Math.round(Math.atan2(en.y - me.y, en.x - me.x) * 100) / 100, fire: true });
};

setTimeout(() => {
  const ok = snaps > 100 && ["fire", "hit", "kill"].every((k) => events.has(k));
  console.log(`snapshots=${snaps} events=${[...events].join(",")}`);
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
}, 15000);
