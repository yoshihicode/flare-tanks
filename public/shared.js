// サーバー（src/index.ts が import）とクライアント（game.js が import）で共有する判定処理。
// 同じコードを使うことで、自機の予測や視界の描画がサーバーの判定とずれないようにする。

// ===== 共有パラメータ =====
export const TILE = 16; // 1タイルのピクセル数
export const TICK_MS = 50; // サーバー更新間隔（20Hz）
const DEG = Math.PI / 180;
// 戦車3種の性能。試遊しながらここだけを調整する（仕様書「戦車3種」の初期値案）
// Display names and roles are UI text: see public/i18n.js (tank.<type>.name / .role)
export const TANK_TYPES = {
  light: {
    r: 5, // 当たり判定半径（px）
    speed: 90, // 移動速度（px/秒。中戦車の1.5倍）
    hp: 60,
    fireInterval: 0.25, // 連射間隔（秒）
    damage: 10,
    fov: 120 * DEG, // 扇形視界の視野角
    range: 208, // 扇形視界の距離（px、13タイル）
    turn: 360 * DEG, // 砲塔の旋回速度（ラジアン/秒）
    hullTurn: 200 * DEG, // hull rotation speed (rad/s) for A / D
    reverse: 0.6, // reverse speed as a fraction of forward speed
  },
  medium: {
    r: 6, speed: 60, hp: 100, fireInterval: 0.6, damage: 25,
    fov: 90 * DEG, range: 160, turn: 200 * DEG, hullTurn: 130 * DEG, reverse: 0.6,
  },
  heavy: {
    r: 7, speed: 36, hp: 160, fireInterval: 1.2, damage: 50,
    fov: 60 * DEG, range: 160, turn: 100 * DEG, hullTurn: 75 * DEG, reverse: 0.5,
  },
};
export const DEFAULT_TANK = "medium";
export const tankSpec = (type) => TANK_TYPES[type] || TANK_TYPES[DEFAULT_TANK];
export const NEAR_VIEW = 40; // 全周視界の半径（px、2.5タイル。全車種共通）

// ===== マップ =====
// map は "#"（壁）と "."（床）の文字列配列
export function makeGrid(map) {
  return { map, w: map[0].length, h: map.length };
}

export function isWallTile(g, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= g.w || ty >= g.h) return true;
  return g.map[ty][tx] === "#";
}

export function isWall(g, px, py) {
  return isWallTile(g, Math.floor(px / TILE), Math.floor(py / TILE));
}

export function hitsWall(g, x, y, r) {
  return isWall(g, x - r, y - r) || isWall(g, x + r, y - r) || isWall(g, x - r, y + r) || isWall(g, x + r, y + r);
}

// ===== 移動 =====
// Tank-style driving: drive = 1 forward / -1 reverse / 0, turn = 1 clockwise (D) / -1 counter-clockwise (A) / 0.
// The hull turns first, then moves along its new heading (so turning while driving curves the path).
// t is {x, y, body, type} and is modified in place. Walls stop each axis separately, so the tank slides along them
export function stepTank(g, t, drive, turn, dt) {
  const s = tankSpec(t.type);
  if (turn) t.body = wrapAngle(t.body + Math.sign(turn) * s.hullTurn * dt);
  if (!drive) return;
  const v = (drive > 0 ? s.speed : -s.speed * s.reverse) * dt;
  const dx = Math.cos(t.body) * v, dy = Math.sin(t.body) * v;
  if (!hitsWall(g, t.x + dx, t.y, s.r)) t.x += dx;
  if (!hitsWall(g, t.x, t.y + dy, s.r)) t.y += dy;
}

const wrapAngle = (a) => ((((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;

// Steering toward a direction (used by bots and the touch stick): turn the hull toward `heading`,
// drive forward once roughly facing it. With allowReverse, a heading behind the tank is reached by
// backing up instead of turning around
export const STEER = {
  dead: 0.15, // rad: close enough, stop turning (one tick of turning is ~0.06-0.17 rad)
  driveWithin: 0.7, // rad: drive only when the heading is within this of the hull direction
  reverseBeyond: 2.3, // rad: with allowReverse, a heading further behind than this is reached in reverse
};
export function steerToward(body, heading, allowReverse = false) {
  let diff = angleDiff(heading, body);
  let forward = 1;
  if (allowReverse && Math.abs(diff) > STEER.reverseBeyond) {
    diff = angleDiff(heading + Math.PI, body); // point the rear at it
    forward = -1;
  }
  return {
    turn: Math.abs(diff) > STEER.dead ? Math.sign(diff) : 0,
    drive: Math.abs(diff) < STEER.driveWithin ? forward : 0,
  };
}

// 砲塔を目標の向きへ、1ステップで最大 turn*dt だけ回した角度を返す
export function turnTurret(type, cur, target, dt) {
  const max = tankSpec(type).turn * dt;
  const d = angleDiff(target, cur);
  return Math.abs(d) <= max ? target : cur + Math.sign(d) * max;
}

// ===== 視界 =====
// 角度 a と b の差（-π〜π）
export function angleDiff(a, b) {
  return ((((a - b) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

// 見通し線：2点を結ぶ線分が壁タイルを通らなければ true（タイル単位のDDA）
export function lineOfSight(g, x0, y0, x1, y1) {
  let tx = Math.floor(x0 / TILE), ty = Math.floor(y0 / TILE);
  const ex = Math.floor(x1 / TILE), ey = Math.floor(y1 / TILE);
  const dx = x1 - x0, dy = y1 - y0;
  const sx = Math.sign(dx), sy = Math.sign(dy);
  // 次の縦線・横線に届くまでの線分上の割合（0〜1）と、1タイル進むごとの増分
  let nextX = sx === 0 ? Infinity : ((sx > 0 ? (tx + 1) * TILE - x0 : x0 - tx * TILE) / Math.abs(dx));
  let nextY = sy === 0 ? Infinity : ((sy > 0 ? (ty + 1) * TILE - y0 : y0 - ty * TILE) / Math.abs(dy));
  const stepX = sx === 0 ? Infinity : TILE / Math.abs(dx);
  const stepY = sy === 0 ? Infinity : TILE / Math.abs(dy);
  for (let n = Math.abs(ex - tx) + Math.abs(ey - ty); n > 0; n--) {
    if (nextX < nextY) { tx += sx; nextX += stepX; } else { ty += sy; nextY += stepY; }
    if (isWallTile(g, tx, ty)) return false;
  }
  return true;
}

// 視点 v {x, y, aim, type} から点 (x, y) が見えるか：
// 「全周視界の内側」または「扇形視界（視野角・距離は車種ごと）の内側」で、かつ見通し線が通ること
export function canSeePoint(g, v, x, y) {
  const s = tankSpec(v.type);
  const d = Math.hypot(x - v.x, y - v.y);
  if (d > NEAR_VIEW) {
    if (d > s.range) return false;
    if (Math.abs(angleDiff(Math.atan2(y - v.y, x - v.x), v.aim)) > s.fov / 2) return false;
  }
  return lineOfSight(g, v.x, v.y, x, y);
}

// 戦車 t {x, y, type} が見えるか。中心と、視線に垂直な左右の端のどれか1点でも見えれば見える
export function canSeeTank(g, v, t) {
  if (canSeePoint(g, v, t.x, t.y)) return true;
  const d = Math.hypot(t.x - v.x, t.y - v.y) || 1;
  const r = tankSpec(t.type).r;
  const px = (-(t.y - v.y) / d) * r, py = ((t.x - v.x) / d) * r;
  return canSeePoint(g, v, t.x + px, t.y + py) || canSeePoint(g, v, t.x - px, t.y - py);
}

// ===== 可視ポリゴン（クライアントの描画用。サーバーは作らない） =====
// 視点の周囲 range の正方形内にある「壁と床の境目」を、同じ直線上でつないだ線分にする
function wallEdges(g, x, y, range) {
  const tx0 = Math.floor((x - range) / TILE), tx1 = Math.floor((x + range) / TILE);
  const ty0 = Math.floor((y - range) / TILE), ty1 = Math.floor((y + range) / TILE);
  const segs = []; // [x1, y1, x2, y2]（水平か垂直のみ）
  const border = (a, b) => isWallTile(g, a[0], a[1]) !== isWallTile(g, b[0], b[1]);
  for (let ty = ty0; ty <= ty1 + 1; ty++) { // 水平な境目：y = ty*TILE の線
    let run = -1;
    for (let tx = tx0; tx <= tx1 + 1; tx++) {
      const on = tx <= tx1 && border([tx, ty - 1], [tx, ty]);
      if (on && run < 0) run = tx;
      if (!on && run >= 0) { segs.push([run * TILE, ty * TILE, tx * TILE, ty * TILE]); run = -1; }
    }
  }
  for (let tx = tx0; tx <= tx1 + 1; tx++) { // 垂直な境目：x = tx*TILE の線
    let run = -1;
    for (let ty = ty0; ty <= ty1 + 1; ty++) {
      const on = ty <= ty1 && border([tx - 1, ty], [tx, ty]);
      if (on && run < 0) run = ty;
      if (!on && run >= 0) { segs.push([tx * TILE, run * TILE, tx * TILE, ty * TILE]); run = -1; }
    }
  }
  // 視界の外枠（レイが必ずどこかで止まるように）
  const L = x - range, R = x + range, T = y - range, B = y + range;
  segs.push([L, T, R, T], [L, B, R, B], [L, T, L, B], [R, T, R, B]);
  return segs;
}

// 視点 (x, y) から見える範囲の多角形を返す（[[x, y], ...]、角度順）。
// 線分の端点（壁の角）へ、少し左右にずらしたレイも含めて飛ばし、最も近い交点をつなぐ
export function visibilityPolygon(g, x, y, range) {
  const segs = wallEdges(g, x, y, range);
  const angles = [];
  for (const [x1, y1, x2, y2] of segs) {
    for (const [px, py] of [[x1, y1], [x2, y2]]) {
      const a = Math.atan2(py - y, px - x);
      angles.push(a - 1e-4, a, a + 1e-4);
    }
  }
  angles.sort((p, q) => p - q);
  const pts = [];
  for (const a of angles) {
    const dx = Math.cos(a), dy = Math.sin(a);
    let best = Infinity;
    for (const [x1, y1, x2, y2] of segs) {
      let t;
      if (y1 === y2) { // 水平線
        if (dy === 0) continue;
        t = (y1 - y) / dy;
        const hx = x + dx * t;
        if (t <= 0 || hx < Math.min(x1, x2) || hx > Math.max(x1, x2)) continue;
      } else { // 垂直線
        if (dx === 0) continue;
        t = (x1 - x) / dx;
        const hy = y + dy * t;
        if (t <= 0 || hy < Math.min(y1, y2) || hy > Math.max(y1, y2)) continue;
      }
      if (t < best) best = t;
    }
    if (best < Infinity) pts.push([x + dx * best, y + dy * best]);
  }
  return pts;
}
