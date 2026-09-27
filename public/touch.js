import { steerToward } from "./shared.js";

// Twin-stick touch controls (spec "操作（PC／スマホ）"): left stick moves, right stick aims and
// fires when pushed far enough. Pure functions, so the smoke test can check them in Node.

export const STICK = {
  radius: 56, // CSS px: how far the thumb can go from where it touched down
  deadZone: 0.25, // fraction of radius ignored (thumb jitter)
  fireAt: 0.8, // right stick pushed this far fires automatically
  assistAngle: (12 * Math.PI) / 180, // aim assist: only for enemies within this angle of the stick
  assistPull: 0.5, // ...and turns the aim this fraction of the way toward them
};

// Stick offset from its origin, clamped to the radius. mag is 0..1
export function stickVector(origin, point, radius = STICK.radius) {
  const dx = point.x - origin.x, dy = point.y - origin.y;
  const len = Math.hypot(dx, dy);
  const mag = Math.min(1, len / radius);
  return { dx: len ? (dx / len) * mag : 0, dy: len ? (dy / len) * mag : 0, mag, angle: Math.atan2(dy, dx) };
}

// Left stick -> the same {drive, turn} input as W / S / A / D: the hull turns toward the stick direction
// and drives once it roughly faces it (steerToward in shared.js, also used by bots)
export function moveFromStick(v, body) {
  if (v.mag < STICK.deadZone) return { drive: 0, turn: 0 };
  return steerToward(body, v.angle);
}

// Right stick -> aim angle (only when pushed past the dead zone) and auto-fire
export function aimFromStick(v) {
  return { active: v.mag >= STICK.deadZone, aim: v.angle, fire: v.mag >= STICK.fireAt };
}

// Weak aim assist for touch: nudge the aim toward the visible enemy closest to the stick direction.
// Uses only enemies the server sent us (already visible), so it gives no extra information
export function assistAim(aim, me, enemies, range) {
  let best = null, bestDiff = STICK.assistAngle;
  for (const e of enemies) {
    if (e.dead || Math.hypot(e.x - me.x, e.y - me.y) > range) continue;
    const to = Math.atan2(e.y - me.y, e.x - me.x);
    const diff = Math.abs(wrap(to - aim));
    if (diff <= bestDiff) { best = to; bestDiff = diff; }
  }
  return best === null ? aim : aim + wrap(best - aim) * STICK.assistPull;
}

const wrap = (a) => ((((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
