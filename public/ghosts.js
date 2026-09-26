// "Last seen" afterimages of enemies (client only; spec "最後に見た位置の残像").
// When an enemy that was in the previous snapshot is missing from the next one, keep a ghost at its
// last position for a while. The server never sends hidden positions, so this only uses what we saw.

export const GHOST = {
  lifeSec: 4, // how long a ghost stays
  killRadius: 12, // a kill event this close to a ghost removes it (that enemy is gone)
};

// ghosts: Map of tank id -> {tank, at}. prev/next: consecutive snapshots. now: seconds.
// Mutates and returns the map.
export function updateGhosts(ghosts, prev, next, now) {
  const enemy = (k) => k.team !== next.team;
  const seen = new Set(next.tanks.filter(enemy).map((k) => k.id));
  // Seen again: drop the ghost
  for (const id of seen) ghosts.delete(id);
  // Just disappeared (and not because it died): leave a ghost where we last saw it
  if (prev && prev.team === next.team) {
    for (const k of prev.tanks) {
      if (enemy(k) && !k.dead && !seen.has(k.id)) ghosts.set(k.id, { tank: k, at: now });
    }
  }
  // Expire old ghosts, and ones where a kill happened
  const kills = next.ev.filter((e) => e.e === "kill");
  for (const [id, g] of ghosts) {
    const killed = kills.some((e) => Math.hypot(e.x - g.tank.x, e.y - g.tank.y) < GHOST.killRadius);
    if (killed || now - g.at > GHOST.lifeSec) ghosts.delete(id);
  }
  return ghosts;
}
