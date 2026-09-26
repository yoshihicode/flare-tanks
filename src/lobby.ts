// Lobby rules (spec "ロビーと部屋") as plain functions, so Node can test them without Workers.
// The Durable Object that stores the list and talks to browsers is in lobby-do.ts.
import type { RoomSettings } from "./settings.ts";

export const LOBBY = {
  capacity: 6, // humans per room (3 vs 3)
  idleSec: 60, // a created room nobody has joined is dropped after this
  staleSec: 15 * 60, // a room that hasn't reported for this long is assumed gone
};

export interface RoomEntry {
  id: string; // room Durable Object name (random, unguessable)
  code: string; // 6-digit invite code
  settings: RoomSettings;
  humans: number;
  phase: string; // room phase: wait / countdown / play / roundEnd / matchEnd
  createdAt: number; // seconds
  updatedAt: number; // seconds, last report from the room
}

// What the public list shows (private rooms and invite codes are never listed)
export function publicList(rooms: RoomEntry[]) {
  return rooms
    .filter((r) => r.settings.public)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((r) => ({
      id: r.id, humans: r.humans, capacity: LOBBY.capacity,
      playing: !(r.phase === "wait" || r.phase === "countdown"),
      mode: r.settings.mode, winRounds: r.settings.winRounds, botLevel: r.settings.botLevel, ff: r.settings.ff,
    }));
}

// Quick join: a public room with space. Waiting rooms first (the match hasn't started), then
// conquest rooms in play (late joiners play right away), then the rest; fuller rooms first within each
export function pickQuick(rooms: RoomEntry[]): RoomEntry | null {
  const open = rooms.filter((r) => r.settings.public && r.humans < LOBBY.capacity);
  const rank = (r: RoomEntry) =>
    r.phase === "wait" || r.phase === "countdown" ? 0 : r.settings.mode === "conquest" ? 1 : 2;
  open.sort((a, b) => rank(a) - rank(b) || b.humans - a.humans);
  return open[0] ?? null;
}

// Rooms to forget: created but never joined for idleSec, or silent for staleSec
export function expired(rooms: RoomEntry[], now: number): RoomEntry[] {
  return rooms.filter((r) =>
    (r.humans === 0 && now - r.updatedAt > LOBBY.idleSec) || now - r.updatedAt > LOBBY.staleSec);
}

// A 6-digit code not used by any active room
export function newCode(rooms: RoomEntry[], rand: () => number = Math.random): string {
  const used = new Set(rooms.map((r) => r.code));
  for (;;) {
    const code = String(Math.floor(rand() * 1_000_000)).padStart(6, "0");
    if (!used.has(code)) return code;
  }
}

export function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
}
