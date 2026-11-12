import { beforeEach, describe, expect, it, vi } from "vitest";
import { contextFromShow, optionOf, parseAskResolved, parsePermissionAsk } from "../src/companion/ask";
import { parseCommand } from "../src/companion/bridge-link";
import { ContextPoller } from "../src/companion/context";
import { HubClient, pickEndpoint, type Endpoint, type HubEvents, type SocketLike } from "../src/companion/hub";

// The four options Kiro offers, as captured from Kiro IDE 1.4.121.
const OPTIONS = [
  { optionId: "accept", name: "Allow", kind: "allow_once" },
  { optionId: "always-accept", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "Deny", kind: "reject_once" },
  { optionId: "always-reject", name: "Always deny", kind: "reject_always" },
];

// A real "Write File" request (verified live).
const WRITE_ASK = {
  sessionId: "sess_5d47a7ae",
  toolCall: { toolCallId: "toolu_write_1", status: "pending", title: "Write File" },
  options: OPTIONS,
  _meta: { kiro: { toolId: "fs_write", consent: { capability: "fs_write", resource: "/tmp/gv/az5.sql", askType: "implicit" }, consentRound: 1 } },
};

// A real "run command" request.
const SHELL_ASK = {
  sessionId: "sess_5d47a7ae",
  toolCall: { toolCallId: "run_command_toolu_2", status: "pending", title: "python3 q.py az5.sql" },
  options: OPTIONS,
  _meta: {
    kiro: {
      toolId: "run_command",
      command: "python3 q.py az5.sql",
      consent: { capability: "shell", resource: "python3 q.py az5.sql", workspaceRoot: "/Users/me/ai-spend" },
      consentRound: 1,
    },
  },
};

describe("parsePermissionAsk", () => {
  it("reads a file write, taking the path from the consent resource", () => {
    expect(parsePermissionAsk(WRITE_ASK)).toEqual({
      sessionId: "sess_5d47a7ae",
      toolCallId: "toolu_write_1",
      consentRound: 1,
      title: "Write File",
      toolId: "fs_write",
      capability: "fs_write",
      resource: "/tmp/gv/az5.sql",
      paths: ["/tmp/gv/az5.sql"],
      options: OPTIONS,
    });
  });

  it("reads a shell command with its workspace root", () => {
    const ask = parsePermissionAsk(SHELL_ASK)!;
    expect(ask).toMatchObject({ toolId: "run_command", capability: "shell", command: "python3 q.py az5.sql", workspaceRoot: "/Users/me/ai-spend", paths: [] });
    expect(ask.title).toBe("python3 q.py az5.sql");
  });

  it("does not duplicate a path already listed in locations", () => {
    const ask = parsePermissionAsk({
      ...WRITE_ASK,
      toolCall: { ...WRITE_ASK.toolCall, locations: [{ path: "/tmp/gv/az5.sql" }] },
    })!;
    expect(ask.paths).toEqual(["/tmp/gv/az5.sql"]);
  });

  it("rejects params without a session or tool call id", () => {
    expect(parsePermissionAsk({ sessionId: "s" })).toBeUndefined();
    expect(parsePermissionAsk({ toolCall: { toolCallId: "t" } })).toBeUndefined();
    expect(parsePermissionAsk(null)).toBeUndefined();
  });

  it("finds an option by kind", () => {
    const ask = parsePermissionAsk(WRITE_ASK)!;
    expect(optionOf(ask, "reject_once")?.optionId).toBe("reject");
    expect(optionOf(ask, "allow_always")?.optionId).toBe("always-accept");
    expect(optionOf(ask, "nope")).toBeUndefined();
  });
});

describe("parseAskResolved", () => {
  it("reads interaction_resolved from the update meta", () => {
    const params = { sessionId: "s1", update: { sessionUpdate: "tool_call_update", _meta: { kiro: { kind: "interaction_resolved", toolCallId: "t1", consentRound: 2 } } } };
    expect(parseAskResolved(params)).toEqual({ sessionId: "s1", toolCallId: "t1", consentRound: 2 });
  });

  it("ignores ordinary updates", () => {
    expect(parseAskResolved({ sessionId: "s1", update: { sessionUpdate: "agent_message_chunk" } })).toBeUndefined();
    expect(parseAskResolved({ sessionId: "s1", update: { _meta: { kiro: { kind: "interaction_resolved" } } } })).toBeUndefined();
  });
});

describe("pickEndpoint", () => {
  const ep = (windowId: number, path: string): Endpoint => ({ windowId, port: 5000 + windowId, token: "t", folders: [{ path }] });
  it("picks the endpoint whose folder matches a workspace folder", () => {
    const endpoints = [ep(1, "/Users/me/ai-spend"), ep(2, "/Users/me/shop")];
    expect(pickEndpoint(endpoints, ["/Users/me/shop"])?.windowId).toBe(2);
    expect(pickEndpoint(endpoints, ["/Users/me/other"])).toBeUndefined();
  });
});

// A fake of the parts of WebSocket the hub uses.
class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(ev: { data?: unknown; code?: number; reason?: string }) => void>>();
  closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.fire("close", { code: 1000 });
  }
  addEventListener(type: string, listener: (ev: { data?: unknown; code?: number; reason?: string }) => void): void {
    (this.listeners.get(type) ?? this.listeners.set(type, []).get(type)!).push(listener);
  }
  fire(type: string, ev: { data?: unknown; code?: number; reason?: string } = {}): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
  receive(message: object): void {
    this.fire("message", { data: JSON.stringify(message) });
  }
  lastSent(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1]!);
  }
}

function recorder(): { events: HubEvents; log: string[] } {
  const log: string[] = [];
  return {
    log,
    events: {
      ask: (a) => log.push(`ask:${a.toolCallId}`),
      resolved: (r) => log.push(`resolved:${r.toolCallId}`),
      sessions: (c) => log.push(`sessions:${c.map((s) => `${s.sessionId}=${s.status}`).join(",")}`),
      message: () => undefined,
      closed: (reason) => log.push(`closed:${reason}`),
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("HubClient", () => {
  const endpoint: Endpoint = { windowId: 1, port: 51234, token: "secret token", folders: [{ path: "/Users/me/shop" }] };
  let socket: FakeSocket;

  beforeEach(() => {
    socket = new FakeSocket();
  });

  async function connect(): Promise<HubClient> {
    const { events } = recorder();
    const client = new HubClient(endpoint, { name: "test", version: "1" }, events, () => socket);
    const connected = client.connect();
    socket.fire("open");
    await flush(); // let connect() send the initialize frame
    socket.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
    await connected;
    return client;
  }

  it("passes the token in the url and initializes", async () => {
    const { events } = recorder();
    let url = "";
    const client = new HubClient(endpoint, { name: "test", version: "1" }, events, (u) => {
      url = u;
      return socket;
    });
    const connected = client.connect();
    socket.fire("open");
    await flush();
    expect(url).toBe("ws://127.0.0.1:51234?token=secret%20token");
    expect(socket.lastSent()).toMatchObject({ method: "initialize", params: { protocolVersion: 1 } });
    socket.receive({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(await connected).toEqual({ ok: true });
  });

  it("surfaces asks, resolutions and session changes", async () => {
    const { events, log } = recorder();
    const client = new HubClient(endpoint, { name: "test", version: "1" }, events, () => socket);
    const connected = client.connect();
    socket.fire("open");
    await flush();
    socket.receive({ jsonrpc: "2.0", id: 1, result: {} });
    await connected;

    socket.receive({ jsonrpc: "2.0", id: 182, method: "session/request_permission", params: WRITE_ASK });
    socket.receive({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { _meta: { kiro: { kind: "interaction_resolved", toolCallId: "toolu_write_1" } } } } });
    socket.receive({ jsonrpc: "2.0", method: "_kiro/sessions/changed", params: { upserted: [{ sessionId: "s", status: "waiting_on_user" }], deleted: [] } });
    socket.receive({ jsonrpc: "2.0", method: "_kiro/sessions/changed", params: { upserted: [{ sessionId: "s", title: "renamed" }], deleted: ["old", { sessionId: "older" }, 7] } });
    expect(log).toEqual(["ask:toolu_write_1", "resolved:toolu_write_1", "sessions:s=waiting_on_user", "sessions:old=deleted,older=deleted"]);
  });

  it("answers a permission with the chosen option and a rejection reason", async () => {
    const client = await connect();
    const done = client.respond("toolu_write_1", "reject", "Use pnpm, not npm");
    expect(socket.lastSent()).toMatchObject({
      method: "_kiro/permission/respond",
      params: { toolCallId: "toolu_write_1", optionId: "reject", _meta: { kiro: { rejectionReason: "Use pnpm, not npm" } } },
    });
    const id = socket.lastSent().id as number;
    socket.receive({ jsonrpc: "2.0", id, result: { success: true } });
    expect(await done).toEqual({ success: true });
  });

  it("rejects an answer Kiro no longer waits for", async () => {
    const client = await connect();
    const done = client.respond("gone", "accept");
    const id = socket.lastSent().id as number;
    socket.receive({ jsonrpc: "2.0", id, error: { code: -32001, message: "No pending permission for toolCallId: gone" } });
    await expect(done).rejects.toThrow("No pending permission");
  });

  it("fails in-flight requests when the socket closes", async () => {
    const client = await connect();
    const done = client.respond("t", "accept");
    socket.fire("close", { code: 1006 });
    await expect(done).rejects.toThrow("closed");
  });

  it("forwards a setting to one live session and returns Kiro's config options", async () => {
    const client = await connect();
    const done = client.setConfigOption("sess_1", "effortLevel", "high");
    expect(socket.lastSent()).toMatchObject({
      method: "session/set_config_option",
      params: { sessionId: "sess_1", configId: "effortLevel", value: "high" },
    });
    const configOptions = [{ type: "select", id: "effortLevel", currentValue: "high", options: [{ value: "high", name: "High" }] }];
    socket.receive({ jsonrpc: "2.0", id: socket.lastSent().id, result: { configOptions } });
    expect(await done).toEqual({ configOptions });
  });

  it("reads a chat's context use with the read-only show request", async () => {
    const client = await connect();
    const done = client.contextOf("sess_1");
    expect(socket.lastSent()).toMatchObject({ method: "_kiro/session/context", params: { sessionId: "sess_1", subcommand: "show" } });
    socket.receive({ jsonrpc: "2.0", id: socket.lastSent().id, result: { success: true, entries: [], breakdown: BREAKDOWN } });
    expect(await done).toBe(41.3);
  });
});

/** The shape of Kiro 1.4's `_kiro/session/context` breakdown (file names left out). */
const BREAKDOWN = {
  contextFiles: { tokens: 9000, percent: 4.5, items: [] },
  tools: { tokens: 20000, percent: 10, mcp: { tokens: 4000, percent: 2 }, builtin: { tokens: 16000, percent: 8 } },
  memory: { tokens: 0, percent: 0 },
  kiroResponses: { tokens: 40000, percent: 20.3 },
  yourPrompts: { tokens: 13000, percent: 6.5 },
  sessionFiles: { tokens: 0, percent: 0, items: [] },
};

describe("context use", () => {
  it("adds the breakdown's parts, counting MCP and built-in tools once", () => {
    expect(contextFromShow({ breakdown: BREAKDOWN })).toBe(41.3);
    expect(contextFromShow({ breakdown: { kiroResponses: { percent: 80 }, yourPrompts: { percent: 40 } } })).toBe(100);
    expect(contextFromShow({ success: false, message: "Session x not found", entries: [] })).toBeUndefined();
    expect(contextFromShow({ breakdown: { tools: { percent: "lots" } } })).toBeUndefined();
    expect(contextFromShow(null)).toBeUndefined();
  });

  it("asks over a short-lived connection when a chat changes, and only reports new values", async () => {
    vi.useFakeTimers();
    try {
      const values: Record<string, number> = { a: 12, b: 30 };
      const opened: string[][] = [];
      const reports: string[] = [];
      let closes = 0;
      const poller = new ContextPoller({
        open: async () => {
          const asked: string[] = [];
          opened.push(asked);
          return {
            contextOf: async (id) => (asked.push(id), values[id]),
            close: () => void closes++,
          };
        },
        report: async (id, percent) => (reports.push(`${id}=${percent}`), id !== "b"), // the bridge does not know b yet
        settleMs: 100,
        workingMs: 1000,
      });

      poller.changed("a", "in_progress");
      poller.changed("b", "idle");
      await vi.advanceTimersByTimeAsync(150);
      expect(opened).toEqual([["a", "b"]]);
      expect(closes).toBe(1); // each poll closes its connection, which ends the hub's subscriptions
      expect(reports).toEqual(["a=12", "b=30"]);

      await vi.advanceTimersByTimeAsync(1000); // a works: asked again; unchanged, so not reported
      expect(opened.at(-1)).toEqual(["a"]);
      expect(reports).toHaveLength(2);

      values.a = 14;
      poller.changed("a", "idle");
      await vi.advanceTimersByTimeAsync(150);
      expect(reports.at(-1)).toBe("a=14");
      const polls = opened.length;
      await vi.advanceTimersByTimeAsync(5000); // nothing works any more: no polling
      expect(opened).toHaveLength(polls);

      poller.resend(); // the bridge restarted
      await vi.advanceTimersByTimeAsync(150);
      expect(reports.slice(-2)).toEqual(["a=14", "b=30"]);
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives each chat its own settle time, skips chats waiting on you, and retries an unreachable hub", async () => {
    vi.useFakeTimers();
    try {
      const asked: Array<{ at: number; ids: string[] }> = [];
      let hubUp = true;
      let bridgeUp = true;
      const start = Date.now();
      const poller = new ContextPoller({
        open: async () => {
          if (!hubUp) return undefined;
          const entry = { at: Date.now() - start, ids: [] as string[] };
          asked.push(entry);
          return { contextOf: async (id) => (entry.ids.push(id), 50), close: () => undefined };
        },
        report: async () => true,
        active: () => bridgeUp,
        settleMs: 300,
        workingMs: 10_000,
      });

      poller.changed("a", "idle");
      await vi.advanceTimersByTimeAsync(280);
      poller.changed("b", "idle"); // inside a's settle window: b still waits its own 300 ms
      await vi.advanceTimersByTimeAsync(40);
      expect(asked).toEqual([{ at: 300, ids: ["a"] }]);
      await vi.advanceTimersByTimeAsync(300);
      expect(asked.at(-1)).toEqual({ at: 580, ids: ["b"] });

      poller.changed("c", "waiting_on_user"); // no model call while it waits: nothing to ask
      poller.changed("a", "deleted");
      poller.resend();
      await vi.advanceTimersByTimeAsync(400);
      expect(asked.at(-1)?.ids).toEqual(["b"]); // a is forgotten, c waits on you

      hubUp = false;
      poller.changed("b", "idle");
      const before = asked.length;
      await vi.advanceTimersByTimeAsync(400);
      expect(asked).toHaveLength(before); // no connection: b is due again later
      hubUp = true;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(asked.at(-1)?.ids).toEqual(["b"]);

      bridgeUp = false;
      poller.changed("b", "idle");
      const quiet = asked.length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(asked).toHaveLength(quiet); // nobody to tell, so the hub is left alone
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("bridge commands", () => {
  it("accepts only the commands the companion knows", () => {
    expect(parseCommand('{"kind":"focus","sessionId":"sess_1"}')).toEqual({ kind: "focus", sessionId: "sess_1" });
    expect(parseCommand('{"kind":"terminal","tty":"ttys012"}')).toEqual({ kind: "terminal", tty: "ttys012" });
    expect(parseCommand('{"kind":"set_config","requestId":"config-1","sessionId":"sess_1","configId":"model","value":"auto"}')).toEqual({
      kind: "set_config",
      requestId: "config-1",
      sessionId: "sess_1",
      configId: "model",
      value: "auto",
    });
    expect(parseCommand('{"kind":"set_config","requestId":"config-1","sessionId":"sess_1","configId":"secret","value":"x"}')).toBeUndefined();
    expect(parseCommand('{"kind":"terminal","tty":"../../etc"}')).toBeUndefined();
    expect(parseCommand('{"kind":"run","command":"rm -rf /"}')).toBeUndefined();
    expect(parseCommand("not json")).toBeUndefined();
  });
});
