// The lobby Durable Object (one instance): room list, room creation, quick join, invite codes.
// Browsers watching the list use the WebSocket Hibernation API, so the lobby is evicted from memory
// between changes and doesn't burn the free duration budget. The list lives in storage for that reason.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { DEFAULT_SETTINGS, parseSettings } from "./settings.ts";
import { LOBBY, expired, newCode, newRoomId, pickQuick, publicList, type RoomEntry } from "./lobby.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

export class Lobby extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.headers.get("Upgrade") === "websocket") {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ t: "rooms", rooms: publicList(await this.rooms()) }));
      return new Response(null, { status: 101, webSocket: client });
    }
    const body = req.method === "POST" ? await req.json().catch(() => ({})) as any : {};
    switch (url.pathname) {
      case "/create": return json(await this.create(parseSettings(body.settings)));
      case "/quick": {
        const room = pickQuick(await this.rooms());
        return json(room ? { id: room.id, code: room.code } : await this.create({ ...DEFAULT_SETTINGS, public: true }));
      }
      case "/code": {
        const code = url.searchParams.get("code") ?? "";
        const room = (await this.rooms()).find((r) => r.code === code);
        return room ? json({ id: room.id, code: room.code }) : json({ error: "招待コードの部屋が見つかりません" }, 404);
      }
      case "/update": await this.update(body); return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  }

  async rooms(): Promise<RoomEntry[]> {
    return [...(await this.ctx.storage.list<RoomEntry>({ prefix: "room:" })).values()];
  }

  // New room: register it, then hand the settings to the room's own Durable Object
  async create(settings: typeof DEFAULT_SETTINGS) {
    const now = Date.now() / 1000;
    const entry: RoomEntry = {
      id: newRoomId(), code: newCode(await this.rooms()), settings,
      humans: 0, phase: "wait", createdAt: now, updatedAt: now,
    };
    await this.ctx.storage.put(`room:${entry.id}`, entry);
    const room = this.env.ROOM.get(this.env.ROOM.idFromName(entry.id));
    await room.fetch("https://room/setup", { method: "POST", body: JSON.stringify({ id: entry.id, code: entry.code, settings }) });
    await this.ensureAlarm();
    this.broadcast(await this.rooms());
    return { id: entry.id, code: entry.code };
  }

  // Report from a room (join/leave/phase/settings change, or closed)
  async update(m: any) {
    if (typeof m?.id !== "string" || typeof m?.code !== "string") return;
    const key = `room:${m.id}`;
    if (m.closed) {
      await this.ctx.storage.delete(key);
    } else {
      const old = await this.ctx.storage.get<RoomEntry>(key);
      const now = Date.now() / 1000;
      await this.ctx.storage.put(key, {
        id: m.id, code: m.code, settings: parseSettings(m.settings),
        humans: Math.max(0, Math.min(LOBBY.capacity, Number(m.humans) || 0)),
        phase: String(m.phase), createdAt: old?.createdAt ?? now, updatedAt: now,
      } satisfies RoomEntry);
      await this.ensureAlarm();
    }
    this.broadcast(await this.rooms());
  }

  // Periodic cleanup of rooms nobody joined or that stopped reporting
  async alarm() {
    const rooms = await this.rooms();
    const gone = expired(rooms, Date.now() / 1000);
    for (const r of gone) await this.ctx.storage.delete(`room:${r.id}`);
    if (gone.length) this.broadcast(await this.rooms());
    if (rooms.length > gone.length) await this.ctx.storage.setAlarm(Date.now() + LOBBY.idleSec * 1000);
  }

  async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + LOBBY.idleSec * 1000);
  }

  broadcast(rooms: RoomEntry[]) {
    const msg = JSON.stringify({ t: "rooms", rooms: publicList(rooms) });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch { /* closed; the runtime drops it */ }
    }
  }

  // Watchers never need to send anything; ignore messages, and close our side when they leave
  async webSocketMessage() {}
  async webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code === 1005 ? 1000 : code); } catch { /* already closed */ }
  }
}
