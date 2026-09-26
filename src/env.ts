// Bindings and variables shared by the Worker, Room and Lobby
export interface Env {
  ROOM: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  DEBUG_TOOLS?: string; // "1" のときだけデバッグ用コマンドを受け付ける（npm run dev で有効）
  TURNSTILE_SITEKEY?: string; // public site key for the browser widget. Dev: Cloudflare's always-pass test key
  TURNSTILE_SECRET?: string; // Dev: the matching test secret. Production: wrangler secret put TURNSTILE_SECRET
  GUEST_SECRET?: string; // signs guest tokens. Dev: set by npm run dev. Production: wrangler secret put GUEST_SECRET
}
