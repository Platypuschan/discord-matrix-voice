import { EventEmitter } from "node:events";
import { log } from "./log.js";

export interface MatrixEvent {
  type: string;
  sender: string;
  event_id: string;
  room_id?: string;
  state_key?: string;
  content: Record<string, any>;
  unsigned?: { age?: number };
}

export interface TurnServer {
  urls: string[];
  username?: string;
  credential?: string;
  ttlSeconds: number;
}

interface SyncRoom {
  state?: { events?: MatrixEvent[] };
  timeline?: { events?: MatrixEvent[] };
}

interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, SyncRoom>;
    invite?: Record<string, { invite_state?: { events?: MatrixEvent[] } }>;
    leave?: Record<string, unknown>;
  };
}

export class MatrixError extends Error {
  constructor(
    readonly status: number,
    readonly errcode: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** A joined room as seen by the sync loop. */
export interface RoomInfo {
  encrypted: boolean;
  members: Map<string, string>; // user id -> membership
}

/**
 * Minimal Matrix client-server API client: long-poll sync, sending events,
 * room creation and the homeserver's TURN credentials. No E2EE.
 *
 * Emits:
 * - `event` (roomId, event) for every new timeline event after the first sync
 * - `invite` (roomId, inviter) for pending room invites
 * - `ready` once the first sync has been processed
 */
export class MatrixClient extends EventEmitter {
  readonly rooms = new Map<string, RoomInfo>();
  userId = "";
  private since: string | undefined;
  private running = false;
  private abort: AbortController | undefined;
  private txn = 0;

  constructor(
    private readonly homeserver: string,
    private readonly accessToken: string,
  ) {
    super();
    this.homeserver = homeserver.replace(/\/+$/, "");
  }

  async request<T = any>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    for (;;) {
      const res = await fetch(this.homeserver + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
      const text = await res.text();
      let json: any = {};
      try {
        if (text) json = JSON.parse(text);
      } catch {
        if (res.ok) throw new MatrixError(res.status, undefined, `${method} ${path.split("?")[0]}: invalid JSON response`);
      }
      if (res.ok) return json as T;
      if (res.status === 429) {
        const wait = json.retry_after_ms ?? Number(res.headers.get("retry-after") ?? 1) * 1000;
        log.warn(`rate limited on ${method} ${path.split("?")[0]}, retrying in ${wait} ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw new MatrixError(res.status, json.errcode, `${method} ${path.split("?")[0]}: ${res.status} ${json.errcode ?? ""} ${json.error ?? text}`);
    }
  }

  async whoami(): Promise<string> {
    const res = await this.request<{ user_id: string }>("GET", "/_matrix/client/v3/account/whoami");
    this.userId = res.user_id;
    return this.userId;
  }

  async sendEvent(roomId: string, type: string, content: Record<string, unknown>): Promise<string> {
    const txnId = `dmv-${Date.now()}-${this.txn++}`;
    const res = await this.request<{ event_id: string }>(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(type)}/${txnId}`,
      content,
    );
    return res.event_id;
  }

  sendNotice(roomId: string, body: string): Promise<string> {
    return this.sendEvent(roomId, "m.room.message", { msgtype: "m.notice", body });
  }

  async joinRoom(roomId: string): Promise<void> {
    await this.request("POST", `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {});
  }

  /** Creates an unencrypted direct chat with `userId` and returns its room id. */
  async createDirectRoom(userId: string, name: string): Promise<string> {
    const res = await this.request<{ room_id: string }>("POST", "/_matrix/client/v3/createRoom", {
      preset: "trusted_private_chat",
      is_direct: true,
      invite: [userId],
      name,
      topic: "Call this room to join the bridged Discord voice channel.",
    });
    return res.room_id;
  }

  async turnServer(): Promise<TurnServer | undefined> {
    try {
      const res = await this.request<{ uris?: string[]; username?: string; password?: string; ttl?: number }>(
        "GET",
        "/_matrix/client/v3/voip/turnServer",
      );
      if (!res.uris?.length) return undefined;
      return { urls: res.uris, username: res.username, credential: res.password, ttlSeconds: res.ttl ?? 86400 };
    } catch (err) {
      log.warn(`no TURN server from homeserver: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Runs the sync loop until `stop()` is called. */
  async run(): Promise<void> {
    this.running = true;
    const filter = JSON.stringify({
      presence: { not_types: ["*"] },
      account_data: { not_types: ["*"] },
      room: {
        ephemeral: { not_types: ["*"] },
        account_data: { not_types: ["*"] },
        timeline: { limit: 50 },
      },
    });
    let backoff = 1000;
    while (this.running) {
      try {
        this.abort = new AbortController();
        const params = new URLSearchParams({ filter, timeout: this.since ? "30000" : "0" });
        if (this.since) params.set("since", this.since);
        const res = await this.request<SyncResponse>("GET", `/_matrix/client/v3/sync?${params}`, undefined, this.abort.signal);
        const initial = this.since === undefined;
        this.handleSync(res, initial);
        this.since = res.next_batch;
        backoff = 1000;
        if (initial) this.emit("ready");
      } catch (err) {
        if (!this.running) break;
        log.error(`sync failed: ${(err as Error).message}; retrying in ${backoff} ms`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
  }

  private handleSync(res: SyncResponse, initial: boolean): void {
    for (const [roomId, room] of Object.entries(res.rooms?.join ?? {})) {
      let info = this.rooms.get(roomId);
      if (!info) {
        info = { encrypted: false, members: new Map() };
        this.rooms.set(roomId, info);
      }
      const events = [...(room.state?.events ?? []), ...(room.timeline?.events ?? [])];
      for (const ev of events) {
        if (ev.type === "m.room.encryption") info.encrypted = true;
        if (ev.type === "m.room.member" && ev.state_key) info.members.set(ev.state_key, ev.content.membership);
      }
      // Old timeline events from the initial sync are history, not live calls.
      if (initial) continue;
      for (const ev of room.timeline?.events ?? []) {
        this.emit("event", roomId, { ...ev, room_id: roomId });
      }
    }
    for (const roomId of Object.keys(res.rooms?.leave ?? {})) this.rooms.delete(roomId);
    for (const [roomId, invite] of Object.entries(res.rooms?.invite ?? {})) {
      const own = invite.invite_state?.events?.find(
        (ev) => ev.type === "m.room.member" && ev.state_key === this.userId && ev.content.membership === "invite",
      );
      if (own) this.emit("invite", roomId, own.sender);
    }
  }
}
