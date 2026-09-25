// サーバー（src/index.ts が import）とクライアント（game.js が import）で共有する判定処理。
// 同じコードを使うことで、自機の予測や視界の描画がサーバーの判定とずれないようにする。

// ===== 共有パラメータ =====
export const TILE = 16; // 1タイルのピクセル数
export const TICK_MS = 50; // サーバー更新間隔（20Hz）
export const TANK = {
  r: 6, // 当たり判定半径（px）
  speed: 60, // 移動速度（px/秒）
};

// ===== マップ =====
// map は "#"（壁）と "."（床）の文字列配列
export function makeGrid(map) {
  return { map, w: map[0].length, h: map.length };
}

export function isWall(g, px, py) {
  const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
  if (tx < 0 || ty < 0 || tx >= g.w || ty >= g.h) return true;
  return g.map[ty][tx] === "#";
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
