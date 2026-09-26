// 動作確認用：3クライアント（A・B・Aの順に参加）で接続し、撃ち合いと視界の絞り込みを確認する。
// 空いた枠は bot が埋めるので、このシナリオではデバッグ用コマンドで bot を止めておく。
// 別の部屋で bot の巡回と、切断した戦車を bot が引き継ぐことも並行して確認する
// 使い方：別ターミナルで `npm run dev` を起動してから `npm run test:smoke`
import {
  makeGrid, stepTank, canSeePoint, canSeeTank, lineOfSight, visibilityPolygon, isWall, angleDiff, tankSpec, TICK_MS, TILE,
} from "../public/shared.js";
import { botChecks } from "./bot-checks.mjs";
import { updateGhosts, GHOST } from "../public/ghosts.js";
import { signToken, verifyToken, checkName, uniqueName, newGuestId } from "../src/guest.ts";

const BASE = process.env.WS_URL || "ws://localhost:8787/ws";
const HTTP = BASE.replace(/^ws/, "http").replace(/\/ws$/, "");
// Get a signed guest token (spec: guest identity). Returns {status, body}
async function guest(name, token) {
  const res = await fetch(`${HTTP}/api/guest`, { method: "POST", body: JSON.stringify({ name, token }) });
  return { status: res.status, body: await res.json() };
}
const room = "smoke-" + Date.now();
const DURATION = 20000;
let grid = null;

// 参加して最初のスナップショットを受け取るまで待つ（順番に参加させてチームを A・B・A に固定する）
// c.id は自分が操作している戦車のID（bot の枠を引き継ぐので、スナップショットの me で知る）
// who: {name, token} to join as a given guest (a fresh guest token is fetched otherwise)
async function join(tank, roomName = room, extra = "", who = {}) {
  const name = who.name ?? "tester";
  const token = who.token ?? (await guest(name)).body.token;
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({ room: roomName, tank, token, name });
    const c = { ws: new WebSocket(`${BASE}?${q}${extra}`), id: null, onSnap: null, token, name };
    c.ws.onerror = () => reject(new Error("接続できません。npm run dev は起動していますか？"));
    c.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === "init") { grid ??= makeGrid(m.map); c.init = m; c.settings = m.settings; }
      else if (m.t === "cfg") { c.settings = m.settings; c.points = m.points; }
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
  await until(() => owner.last.g.ph === "countdown", 2000);
  debug(owner, { phaseSec: 0 });
  await until(() => owner.last.g.ph === "play", 2000);
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
await startNow(a);
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
  const got = await until(() => x.last.g.pts.some((p) => p.o), 15000);
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
    const ws = new WebSocket(`${BASE}?room=${room}-guest&tank=medium&name=x`);
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
};

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
  if (!bTurned && Date.now() - t0 > 4000) { bTurned = true; send(b, { mx: -1, my: 0 }); }
};

setTimeout(async () => {
  await flowDone;
  await conquestDone;
  await botCaptureDone;
  await settingsDone;
  await guestDone;
  const checks = [
    ["スナップショット受信 >100", snaps > 100, `snapshots=${snaps}`],
    ["発射・被弾・撃破イベント", ["fire", "hit", "kill"].every((k) => events.has(k)), `events=${[...events].join(",")}`],
    ["両チームとも3台（空き枠は bot）", st.teamA === 3 && st.teamB === 3, `A=${st.teamA} B=${st.teamB}`],
    ["bot が巡回で動く", bots.moved > 0, `moved=${bots.moved}`],
    ["bot が敵を見つけて撃つ（Lv5の部屋）", bots.fires > 0, `fire=${bots.fires}`],
    ...botChecks(),
    ...flow,
    ...conquest,
    ...setting,
    ...guestChecks,
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
    ["送られた敵の発射は視界内", st.fireNg === 0, `ok=${st.fireOk} ng=${st.fireNg}`],
  ];
  for (const [name, ok, detail] of checks) console.log(`${ok ? "ok  " : "NG  "} ${name}（${detail}）`);
  const ok = checks.every((x) => x[1]);
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
}, DURATION);
