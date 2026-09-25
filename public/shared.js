// サーバー（src/index.ts が import）とクライアント（game.js が import）で共有する判定処理。
// 同じコードを使うことで、自機の予測や視界の描画がサーバーの判定とずれないようにする。

// ===== 共有パラメータ =====
export const TILE = 16; // 1タイルのピクセル数
export const TICK_MS = 50; // サーバー更新間隔（20Hz）
export const TANK = {
  r: 6, // 当たり判定半径（px）
  speed: 60, // 移動速度（px/秒）
};
// 視界（ステップ3で戦車ごとの値に分ける。いまは中戦車相当）
export const VISION = {
  fov: Math.PI / 2, // 扇形視界の視野角（約90°）
  range: 160, // 扇形視界の距離（px、10タイル）
  near: 40, // 全周視界の半径（px、2.5タイル）
};

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
// 戦車を1ステップ動かす（t は {x, y, body} を持つオブジェクトで、直接書き換える）。
// 壁に当たったら軸ごとに止めて、壁沿いに滑らせる
export function stepTank(g, t, mx, my, dt) {
  const len = Math.hypot(mx, my);
  if (len === 0) return;
  const dx = (mx / len) * TANK.speed * dt, dy = (my / len) * TANK.speed * dt;
  if (!hitsWall(g, t.x + dx, t.y, TANK.r)) t.x += dx;
  if (!hitsWall(g, t.x, t.y + dy, TANK.r)) t.y += dy;
  t.body = Math.atan2(my, mx);
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

// 視点 v {x, y, aim} から点 (x, y) が見えるか：
// 「全周視界の内側」または「扇形視界の内側」で、かつ見通し線が通ること
export function canSeePoint(g, v, x, y) {
  const d = Math.hypot(x - v.x, y - v.y);
  if (d > VISION.near) {
    if (d > VISION.range) return false;
    if (Math.abs(angleDiff(Math.atan2(y - v.y, x - v.x), v.aim)) > VISION.fov / 2) return false;
  }
  return lineOfSight(g, v.x, v.y, x, y);
}

// 戦車 t {x, y} が見えるか。中心と、視線に垂直な左右の端のどれか1点でも見えれば見える
export function canSeeTank(g, v, t) {
  if (canSeePoint(g, v, t.x, t.y)) return true;
  const d = Math.hypot(t.x - v.x, t.y - v.y) || 1;
  const px = (-(t.y - v.y) / d) * TANK.r, py = ((t.x - v.x) / d) * TANK.r;
  return canSeePoint(g, v, t.x + px, t.y + py) || canSeePoint(g, v, t.x - px, t.y - py);
}
