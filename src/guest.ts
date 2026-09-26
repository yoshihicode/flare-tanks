// Guest identity (spec "プレイヤー識別（ゲスト方式）"): no login, a display name plus a guest ID in a token
// signed with a server secret, so nobody can pose as another guest. Uses only WebCrypto,
// so it runs in Workers and in Node (tests import this file directly).

export const GUEST = {
  nameMax: 12, // characters (code points) in a display name
  // Blocked words (case-insensitive substring match). A small starter list; extend as needed
  ngWords: ["admin", "運営", "公式", "fuck", "shit", "死ね", "殺す"],
  reserveSec: 30, // a disconnected player's tank is held for them this long (reconnect)
};

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

// Constant-time string comparison (avoid leaking how many signature characters matched)
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function newGuestId(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(9))); // 12 URL-safe characters
}

// Token format: v1.<guestId>.<issuedAt seconds>.<signature>
export async function signToken(secret: string, gid: string, now = Date.now()): Promise<string> {
  const body = `v1.${gid}.${Math.floor(now / 1000)}`;
  return `${body}.${await hmac(secret, body)}`;
}

// Returns the guest ID if the token is well-formed and signed with this secret, else null
export async function verifyToken(secret: string, token: unknown): Promise<string | null> {
  if (typeof token !== "string" || token.length > 200) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !/^[A-Za-z0-9_-]{12}$/.test(parts[1]) || !/^\d+$/.test(parts[2])) return null;
  const body = parts.slice(0, 3).join(".");
  return safeEqual(await hmac(secret, body), parts[3]) ? parts[1] : null;
}

// Normalize and check a display name. Returns {name} or {error} (error text is shown to the player)
export function checkName(input: unknown): { name: string } | { error: string } {
  if (typeof input !== "string") return { error: "名前を入力してください" };
  // Drop control characters, collapse whitespace, trim
  const name = input.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/g, "")
    .replace(/\s+/g, " ").trim();
  if (!name) return { error: "名前を入力してください" };
  if ([...name].length > GUEST.nameMax) return { error: `名前は${GUEST.nameMax}文字までです` };
  const lower = name.toLowerCase();
  if (GUEST.ngWords.some((w) => lower.includes(w.toLowerCase()))) return { error: "その名前は使えません" };
  return { name };
}

// "Yoshi" -> "Yoshi(2)" when the name is already taken in the room
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name}(${i})`)) return `${name}(${i})`;
}
