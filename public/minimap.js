// Minimap (spec: "ミニマップ｜味方と既知の敵のみ表示", placed at the top on phones).
// Known enemies = the ones the server sent us (visible now) plus last-seen ghosts; nothing else.

export const MINIMAP = {
  maxW: 64, // size limit in 320x180 screen units (the 40x24 basic map is width-limited: 64x38)
  maxH: 48, // square 128x128 generated maps: 48x48
  x: 4, // top-left corner, just under the HUD bar
  y: 14,
};

// Scale (screen units per tile) and size for a map of w x h tiles
export function minimapLayout(w, h) {
  const scale = Math.min(MINIMAP.maxW / w, MINIMAP.maxH / h);
  return { scale, w: w * scale, h: h * scale };
}

// Wall coverage for each minimap pixel (0..1), averaging the tiles it covers. Small maps get about
// one tile per pixel; on 128x128 a pixel covers ~2.7 tiles, so drawing tiles 1:1 would smear into white
export function minimapWalls(tiles, layout) {
  const w = Math.ceil(layout.w), h = Math.ceil(layout.h);
  const out = new Float32Array(w * h);
  const per = 1 / layout.scale; // tiles per minimap pixel
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let walls = 0, total = 0;
      for (let ty = Math.floor(py * per); ty < Math.min(tiles.length, Math.ceil((py + 1) * per)); ty++) {
        for (let tx = Math.floor(px * per); tx < Math.min(tiles[0].length, Math.ceil((px + 1) * per)); tx++) {
          total++;
          if (tiles[ty][tx] === "#") walls++;
        }
      }
      out[py * w + px] = total ? walls / total : 0;
    }
  }
  return out;
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
