// Minimap (spec: "ミニマップ｜味方と既知の敵のみ表示", placed at the top on phones).
// Known enemies = the ones the server sent us (visible now) plus last-seen ghosts; nothing else.

export const MINIMAP = {
  maxW: 64, // size limit in 320x180 screen units
  maxH: 40,
  x: 4, // top-left corner, just under the HUD bar
  y: 14,
};

// Scale (screen units per tile) and size for a map of w x h tiles
export function minimapLayout(w, h) {
  const scale = Math.min(MINIMAP.maxW / w, MINIMAP.maxH / h);
  return { scale, w: w * scale, h: h * scale };
}

// Dots to draw: our team (always known), visible enemies, and ghosts of enemies seen a moment ago
export function minimapDots(snap, ghosts) {
  const dots = [];
  for (const k of snap.tanks) {
    if (k.dead) continue;
    dots.push({ x: k.x, y: k.y, team: k.team, kind: k.team === snap.team ? "ally" : "enemy", me: k.id === snap.me });
  }
  for (const g of ghosts.values()) dots.push({ x: g.tank.x, y: g.tank.y, team: g.tank.team, kind: "ghost", me: false });
  return dots;
}
