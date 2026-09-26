// bot 単体の確認（通信なし）。スモークテストから呼ばれ、[名前, 合否, 詳細] の配列を返す
import { Bot, BOT_LEVELS } from "../src/bot.ts";
import { makeGrid, stepTank, turnTurret, angleDiff, TICK_MS } from "../public/shared.js";

const DT = TICK_MS / 1000;
// 30×20 の何もない部屋
const W = 30, H = 20;
const grid = makeGrid(Array.from({ length: H }, (_, y) =>
  Array.from({ length: W }, (_, x) => (x === 0 || y === 0 || x === W - 1 || y === H - 1 ? "#" : ".")).join("")));
const at = (tx, ty) => ({ x: tx * 16 + 8, y: ty * 16 + 8 });

function makeBot(level) {
  return new Bot(level, grid, { home: at(2, 10), enemyHome: at(27, 10), bulletSpeed: 180 });
}
function tank(id, team, pos, extra = {}) {
  return { id, team, type: "medium", ...pos, body: 0, aim: 0, hp: 100, dead: false, ...extra };
}

// サーバーと同じ手順で bot を動かす。see(now) は、その時点で bot の視界に入っている敵
function run(bot, self, { sec, see = () => [], hit = null, onTick = () => {}, allies = [], objectives, pins }) {
  let firstFire = null;
  for (let i = 0; i < sec / DT; i++) {
    const now = i * DT;
    const input = bot.think({ self, allies, enemies: see(now), hit, now, objectives, pins });
    stepTank(grid, self, input.mx, input.my, DT);
    self.aim = turnTurret(self.type, self.aim, input.aim, DT);
    if (input.fire && firstFire === null) firstFire = now;
    onTick(now, input);
  }
  return { firstFire };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function botChecks() {
  const checks = [];

  // 反応時間：真正面の敵に撃ち始めるまで。レベル1は遅く、レベル5は速い
  const fireTime = (level) => {
    const self = tank("b", "A", at(10, 10));
    const enemy = tank("e", "B", at(16, 10));
    return run(makeBot(level), self, { sec: 3, see: () => [enemy] }).firstFire;
  };
  const f1 = fireTime(1), f5 = fireTime(5);
  checks.push(["bot の反応時間（Lv1 は遅く Lv5 は速い）",
    f1 !== null && f5 !== null && f1 >= BOT_LEVELS[1].reaction && f5 < f1 && f5 <= 0.6, `Lv1=${f1?.toFixed(2)}s Lv5=${f5?.toFixed(2)}s`]);

  // 狙いのぶれ：レベルが高いほど小さい
  const aimError = (level) => {
    const bot = makeBot(level);
    const self = tank("b", "A", at(10, 10)), enemy = tank("e", "B", at(16, 12));
    const truth = Math.atan2(enemy.y - self.y, enemy.x - self.x);
    let sum = 0;
    for (let i = 0; i < 400; i++) sum += Math.abs(angleDiff(bot.aimAt(self, enemy, i), truth));
    return sum / 400;
  };
  const e1 = aimError(1), e3 = aimError(3), e5 = aimError(5);
  checks.push(["bot の狙いのぶれ（Lv1 > Lv3 > Lv5）", e1 > e3 && e3 > e5, `Lv1=${e1.toFixed(3)} Lv3=${e3.toFixed(3)} Lv5=${e5.toFixed(3)}`]);

  // 見えない敵には撃たない（視界の敵を渡さなければ、どのレベルでも撃たない）
  let blindFire = 0;
  for (const level of [1, 2, 3, 4, 5]) {
    run(makeBot(level), tank("b", "A", at(10, 10)), { sec: 5, onTick: (_, inp) => { if (inp.fire) blindFire++; } });
  }
  checks.push(["bot は見えない敵を撃たない", blindFire === 0, `fire=${blindFire}`]);

  // 退避：HPが減ると自陣へ下がる（Lv3）。Lv1 は退避しない
  const retreat = (level) => {
    const self = tank("b", "A", at(14, 10), { hp: 20 });
    const enemy = tank("e", "B", at(20, 10));
    const home = at(2, 10);
    const before = dist(self, home);
    run(makeBot(level), self, { sec: 3, see: () => [enemy] });
    return before - dist(self, home); // 自陣へ近づいた距離
  };
  const r3 = retreat(3), r1 = retreat(1);
  checks.push(["bot の退避（Lv3 は自陣へ下がり Lv1 は下がらない）", r3 > 48 && r1 <= 0, `Lv3=${r3.toFixed(0)}px Lv1=${r1.toFixed(0)}px`]);

  // 追跡：一度見た敵が見えなくなったら、最後に見た場所へ向かう
  {
    const self = tank("b", "A", at(5, 5));
    const seenAt = at(20, 14);
    const enemy = tank("e", "B", seenAt);
    const before = dist(self, seenAt);
    run(makeBot(3), self, { sec: 4, see: (now) => (now < 0.1 ? [enemy] : []) });
    const closer = before - dist(self, seenAt);
    checks.push(["bot は見失った敵を追う", closer > 100, `近づいた距離=${closer.toFixed(0)}px`]);
  }

  // 連携：Lv5 は敵を見つけるとピンを立て、味方のピンの近く（回り込み先を含む）を目的地にして追う。Lv3 はどちらもしない
  const shared = (level) => {
    const enemy = tank("e", "B", at(4, 17));
    const input = makeBot(level).think({ self: tank("s", "A", at(8, 17)), allies: [], enemies: [enemy], hit: null, now: 0 });
    const pins = input.pin ? [{ id: 1, ...input.pin, at: 0, by: "s" }] : [];
    const bot = makeBot(level);
    run(bot, tank("b", "A", at(14, 3)), { sec: 1, pins });
    const goalDist = bot.goal ? Math.hypot(bot.goal[0] - 4, bot.goal[1] - 17) : Infinity;
    return { pinned: !!input.pin, state: bot.state, goalDist };
  };
  const s5 = shared(5), s3 = shared(3);
  checks.push(["Lv5 は敵発見でピンを立て、味方のピンで追う（Lv3 はしない）",
    s5.pinned && s5.state === "chase" && s5.goalDist <= 5 && !s3.pinned && s3.state !== "chase",
    `Lv5=pin:${s5.pinned} ${s5.state}(目的地まで${s5.goalDist.toFixed(1)}タイル) Lv3=pin:${s3.pinned} ${s3.state}`]);
  // A Lv5 bot also follows a pin placed by a human teammate
  {
    const bot = makeBot(5);
    run(bot, tank("b", "A", at(14, 3)), { sec: 1, pins: [{ id: 7, ...at(4, 17), at: 0, by: "human" }] });
    checks.push(["Lv5 は人間の味方が立てたピンも追う", bot.state === "chase", `state=${bot.state}`]);
  }

  // 撃たれた方向を向く（見えない相手からの被弾）
  {
    const self = tank("b", "A", at(10, 10));
    run(makeBot(3), self, { sec: 1.5, hit: { dir: Math.PI / 2, at: 0 } });
    const off = Math.abs(angleDiff(self.aim, Math.PI / 2));
    checks.push(["bot は撃たれた方向を向く", off < 0.1, `ずれ=${off.toFixed(2)}rad`]);
  }
  // ===== Conquest: capture point behavior =====
  const zone = (id, tx, ty, owner = null, contested = false) => ({ id, ...at(tx, ty), r: 40, owner, contested });
  const inZone = (t, o) => dist(t, o) <= o.r;

  // Heads for a point that isn't ours (skips the nearer point we already own), then stays in the zone
  {
    const objectives = [zone("A", 8, 10, "A"), zone("C", 20, 10)];
    const self = tank("b", "A", at(4, 10));
    let insideTicks = 0;
    run(makeBot(3), self, { sec: 8, objectives, onTick: () => { if (inZone(self, objectives[1])) insideTicks++; } });
    checks.push(["拠点制圧：自チームのものでない拠点へ向かい、範囲内にとどまる",
      inZone(self, objectives[1]) && insideTicks > 40, `inside=${(insideTicks * DT).toFixed(1)}s`]);
  }
  // A contested point pulls the bot in, even if it's farther than a neutral one
  {
    const objectives = [zone("A", 9, 10), zone("B", 20, 16, "A", true)];
    const self = tank("b", "A", at(4, 10));
    run(makeBot(3), self, { sec: 8, objectives });
    checks.push(["拠点制圧：競合中の拠点へ加勢する", inZone(self, objectives[1]), `pos=(${self.x | 0},${self.y | 0})`]);
  }
  // With an ally already holding the nearest neutral point, the bot takes the other one
  {
    const objectives = [zone("A", 9, 10), zone("C", 20, 10)];
    const ally = tank("x", "A", at(9, 10));
    const self = tank("b", "A", at(4, 10));
    run(makeBot(3), self, { sec: 8, objectives, allies: [ally] });
    checks.push(["拠点制圧：味方がいる拠点は避けて分散する", inZone(self, objectives[1]), `pos=(${self.x | 0},${self.y | 0})`]);
  }
  // Seeing an enemy still takes priority over walking to a point
  {
    const objectives = [zone("C", 20, 10)];
    const self = tank("b", "A", at(10, 10));
    const enemy = tank("e", "B", at(10, 15));
    const { firstFire } = run(makeBot(3), self, { sec: 3, objectives, see: () => [enemy] });
    checks.push(["拠点制圧：敵が見えたら拠点より交戦を優先", firstFire !== null, `firstFire=${firstFire?.toFixed(2)}s`]);
  }
  // Friendly fire on: an ally in the line of fire holds the shot; with it off the bot fires through
  const throughAlly = (ff) => {
    const self = tank("b", "A", at(10, 10));
    const ally = tank("x", "A", at(13, 10));
    const enemy = tank("e", "B", at(17, 10));
    const bot = makeBot(5);
    let fired = false;
    for (let i = 0; i < 40; i++) {
      const input = bot.think({ self, allies: [ally], enemies: [enemy], hit: null, now: i * DT, ff });
      self.aim = turnTurret(self.type, self.aim, input.aim, DT);
      if (input.fire) fired = true;
    }
    return fired;
  };
  const ffOn = throughAlly(true), ffOff = throughAlly(false);
  checks.push(["フレンドリーファイアありなら味方越しに撃たない", !ffOn && ffOff, `ff on fired=${ffOn} / off fired=${ffOff}`]);
  return checks;
}
