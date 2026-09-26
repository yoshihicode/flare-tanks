// Room settings chosen by the room creator (spec "ロビーと部屋": mode, map, rounds, friendly fire, bot level).
// Shared by the lobby (room creation) and the room (owner changes while waiting). No Workers APIs here,
// so Node can import it directly for tests.

export type Mode = "elim" | "conquest";

export interface RoomSettings {
  mode: Mode;
  map: string; // "random" = chunk-based generated 128x128 map, "basic" = the fixed 40x24 map
  mapSeed: number | null; // generated maps: seed (null = the room picks one when it loads the map)
  winRounds: number; // elimination: rounds needed to win the match (max rounds = 2 * winRounds - 1)
  ff: boolean; // friendly fire: bullets also damage teammates
  botLevel: number; // 1..5
  public: boolean; // listed in the lobby; private rooms are joined by invite code or URL
}

export const SETTING_LIMITS = {
  modes: ["elim", "conquest"] as Mode[],
  maps: ["random", "basic"],
  maxSeed: 2 ** 31 - 1,
  winRounds: [1, 2, 3],
  botLevels: [1, 2, 3, 4, 5],
};

export const DEFAULT_SETTINGS: RoomSettings = {
  mode: "elim",
  map: "random",
  mapSeed: null,
  winRounds: 2, // spec: first to 2 rounds (best of 3)
  ff: false,
  botLevel: 3,
  public: true,
};

// Merge untrusted input over base, keeping only valid values
export function parseSettings(input: unknown, base: RoomSettings = DEFAULT_SETTINGS): RoomSettings {
  const s = { ...base };
  if (!input || typeof input !== "object") return s;
  const m = input as Record<string, unknown>;
  if (SETTING_LIMITS.modes.includes(m.mode as Mode)) s.mode = m.mode as Mode;
  if (SETTING_LIMITS.maps.includes(m.map as string)) s.map = m.map as string;
  if (m.mapSeed === null) s.mapSeed = null;
  else if (m.mapSeed !== undefined && m.mapSeed !== "") {
    const seed = Number(m.mapSeed);
    if (Number.isInteger(seed) && seed >= 0 && seed <= SETTING_LIMITS.maxSeed) s.mapSeed = seed;
  }
  const rounds = Number(m.winRounds);
  if (SETTING_LIMITS.winRounds.includes(rounds)) s.winRounds = rounds;
  const level = Number(m.botLevel);
  if (SETTING_LIMITS.botLevels.includes(level)) s.botLevel = level;
  if (typeof m.ff === "boolean") s.ff = m.ff;
  if (typeof m.public === "boolean") s.public = m.public;
  return s;
}

// Settings from URL query parameters (dev ad-hoc rooms and tests): ?mode=&bot=&rounds=&ff=1&private=1&map=&seed=
// Ad-hoc rooms default to the basic map: the smoke test scenarios are laid out on it
export function settingsFromQuery(q: URLSearchParams): RoomSettings {
  const input: Record<string, unknown> = { map: "basic" };
  if (q.has("map")) input.map = q.get("map");
  if (q.has("seed")) input.mapSeed = q.get("seed");
  if (q.has("mode")) input.mode = q.get("mode");
  if (q.has("bot")) input.botLevel = q.get("bot");
  if (q.has("rounds")) input.winRounds = q.get("rounds");
  if (q.has("ff")) input.ff = q.get("ff") === "1";
  if (q.has("private")) input.public = q.get("private") !== "1";
  return parseSettings(input);
}
