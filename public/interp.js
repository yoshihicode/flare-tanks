// Interpolation buffer for other tanks (spec: "回線の揺らぎ → 補間用バッファを長めに取る").
// Snapshots are drawn a little in the past, between the two that bracket that moment, so uneven
// arrival times don't make tanks stutter. Pure functions, so the smoke test can check them in Node.

export const INTERP = {
  delayMs: 100, // how far in the past other tanks are drawn (PC)
  touchDelayMs: 150, // phones: mobile networks jitter more
  keep: 40, // snapshots kept (2 s at 20 Hz)
};

const lerp = (a, b, t) => a + (b - a) * t;
const lerpAngle = (a, b, t) => a + ((((b - a) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI) * t;

// buffer: [{snap, at}] oldest first. Returns {snap, tanks} for renderAt: tanks interpolated between the
// bracketing snapshots, and snap = the later of the two (for bullets drawn at the same moment)
export function sample(buffer, renderAt) {
  if (!buffer.length) return null;
  let i = buffer.length - 1;
  while (i > 0 && buffer[i - 1].at > renderAt) i--;
  const next = buffer[i];
  const prev = i > 0 ? buffer[i - 1] : null;
  // Past the newest snapshot (or before the oldest): no extrapolation, just show what we have
  if (!prev || renderAt >= next.at) return { snap: next.snap, tanks: next.snap.tanks };
  const t = Math.max(0, Math.min(1, (renderAt - prev.at) / (next.at - prev.at || 1)));
  const before = new Map(prev.snap.tanks.map((k) => [k.id, k]));
  // Tanks come from the later snapshot: one that just left view is gone, one that just appeared is shown as is
  const tanks = next.snap.tanks.map((k) => {
    const p = before.get(k.id);
    if (!p || p.dead !== k.dead) return k;
    return { ...k, x: lerp(p.x, k.x, t), y: lerp(p.y, k.y, t), b: lerpAngle(p.b, k.b, t), a: lerpAngle(p.a, k.a, t) };
  });
  return { snap: next.snap, tanks };
}

export function pushSnapshot(buffer, snap, at) {
  buffer.push({ snap, at });
  if (buffer.length > INTERP.keep) buffer.shift();
  return buffer;
}
