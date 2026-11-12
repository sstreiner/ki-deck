// A client of the agent hub one Kiro IDE window runs (`AgentMuxServer` in kiro.kiro-agent):
// JSON-RPC 2.0 (ACP) over a WebSocket on 127.0.0.1, one message per frame, authenticated by
// the window's random token. We connect as an "observer": the hub sends observers every
// permission request with the full question (and resends the waiting ones on connect), and an
// observer answers exactly one of them with `_kiro/permission/respond`, as Kiro's dialog does.

import { contextFromShow, parseAskResolved, parsePermissionAsk, type AskResolved, type PermissionAsk } from "./ask";

export interface Endpoint {
  windowId: number;
  port: number;
  token: string;
  folders: Array<{ path: string; label?: string }>;
}

/**
 * One entry of `_kiro/sessions/changed`: "idle", "in_progress", "waiting_on_user" while Kiro
 * waits for an answer, or "deleted" for an entry of its `deleted` list.
 */
export interface SessionStatus {
  sessionId: string;
  status: string;
}

export interface HubEvents {
  ask(ask: PermissionAsk): void;
  /** An ask ended: answered in Kiro's dialog, by another client or by us, or the turn was cancelled. */
  resolved(resolved: AskResolved): void;
  sessions(changed: SessionStatus[]): void;
  /** Every message, for the trace log. Never includes the token. */
  message(direction: "in" | "out", message: Record<string, unknown>): void;
  closed(reason: string): void;
}

/** The parts of the WebSocket API this client uses, so tests can pass a fake. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (ev: { data?: unknown; code?: number; reason?: string }) => void, options?: { once?: boolean }): void;
}
export type SocketFactory = (url: string) => SocketLike;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const TIMEOUT_MS = 10_000;

export class HubClient {
  private ws?: SocketLike;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    private readonly endpoint: Endpoint,
    private readonly clientInfo: { name: string; version: string },
    private readonly events: HubEvents,
    private readonly socket: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike,
  ) {}

  get port(): number {
    return this.endpoint.port;
  }

  /** Opens the connection and initializes. Resolves with the hub's initialize result. */
  async connect(): Promise<unknown> {
    const ws = this.socket(`ws://127.0.0.1:${this.endpoint.port}?token=${encodeURIComponent(this.endpoint.token)}`);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the agent hub on port ${this.endpoint.port} did not answer`)), TIMEOUT_MS);
      ws.addEventListener("open", () => (clearTimeout(timer), resolve()), { once: true });
      ws.addEventListener("error", () => (clearTimeout(timer), reject(new Error(`cannot connect to the agent hub on port ${this.endpoint.port}`))), { once: true });
    });
    ws.addEventListener("message", (ev) => this.onFrame(ev.data));
    ws.addEventListener("close", (ev) => this.onClose(`closed (${ev.code ?? "?"}${ev.reason ? ` ${ev.reason}` : ""})`));
    ws.addEventListener("error", () => this.onClose("socket error"));
    return this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: this.clientInfo,
    });
  }

  /**
   * Answers one permission request. A rejection reason reaches the agent with "reject once".
   * Rejects when Kiro no longer waits for it (answered elsewhere, or the turn ended).
   */
  respond(toolCallId: string, optionId: string, rejectionReason?: string): Promise<unknown> {
    return this.request("_kiro/permission/respond", {
      toolCallId,
      optionId,
      ...(rejectionReason ? { _meta: { kiro: { rejectionReason } } } : {}),
    });
  }

  /** Changes one option of a specific live IDE session through its owning agent hub. */
  setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown> {
    return this.request("session/set_config_option", { sessionId, configId, value });
  }

  /**
   * How full a chat's context window is (`_kiro/session/context`, "show"; read-only). The hub
   * subscribes any client that sends a request naming a session to all of that session's
   * updates, so ask over a short-lived connection, never the observer one (see context.ts).
   */
  async contextOf(sessionId: string): Promise<number | undefined> {
    return contextFromShow(await this.request("_kiro/session/context", { sessionId, subcommand: "show" }));
  }

  close(): void {
    this.ws?.close();
    this.onClose("closed by us");
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed || !this.ws) return Promise.reject(new Error("not connected"));
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.events.message("out", message);
      this.ws!.send(JSON.stringify(message));
    });
  }

  private onFrame(data: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    this.events.message("in", msg);
    if (typeof msg.method === "string") {
      if (msg.method === "session/request_permission") {
        const ask = parsePermissionAsk(msg.params);
        if (ask) this.events.ask(ask);
      } else if (msg.method === "session/update") {
        const resolved = parseAskResolved(msg.params);
        if (resolved) this.events.resolved(resolved);
      } else if (msg.method === "_kiro/sessions/changed") {
        const params = msg.params as { upserted?: unknown; deleted?: unknown } | undefined;
        const changed = (Array.isArray(params?.upserted) ? params.upserted : [])
          .filter((u): u is SessionStatus => typeof u?.sessionId === "string" && typeof u?.status === "string")
          .map((u) => ({ sessionId: u.sessionId, status: u.status }));
        // Deleted entries are session IDs (or objects with one); they are reported as "deleted".
        for (const d of Array.isArray(params?.deleted) ? params.deleted : []) {
          const sessionId = typeof d === "string" ? d : typeof d?.sessionId === "string" ? d.sessionId : undefined;
          if (sessionId) changed.push({ sessionId, status: "deleted" });
        }
        if (changed.length) this.events.sessions(changed);
      }
      // Requests to observers are answered through _kiro/permission/respond, never directly.
      return;
    }
    const entry = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
    if (!entry) return;
    this.pending.delete(msg.id as number);
    clearTimeout(entry.timer);
    const error = msg.error as { message?: string; code?: number } | undefined;
    if (error) entry.reject(new Error(`${error.message ?? "request failed"} (${error.code ?? "?"})`));
    else entry.resolve(msg.result);
  }

  private onClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
    this.events.closed(reason);
  }
}

/** The endpoint of this window's agent: the one whose folders match the workspace folders. */
export function pickEndpoint(endpoints: Endpoint[], workspaceFolders: string[]): Endpoint | undefined {
  const mine = new Set(workspaceFolders);
  return endpoints.find((e) => e.folders.some((f) => mine.has(f.path)));
}
