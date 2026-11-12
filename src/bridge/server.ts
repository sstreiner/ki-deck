// HTTP over a Unix domain socket. The socket file is mode 0600 inside a 0700 directory,
// so only the current user can connect; there is no TCP listener and no token.

import { chmod, mkdir, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { dirname } from "node:path";
import type { Logger } from "./logger";
import type { HookEvent, HookMeta } from "./sessions";

export interface HookRequest {
  mode: "observe" | "gate";
  category: string;
  meta: HookMeta;
  event: HookEvent;
  /** Aborted when kd-hook disconnects before the answer, e.g. because Kiro stopped waiting. */
  signal: AbortSignal;
}

export interface Reply {
  status: number;
  body?: string;
}

export interface Handlers {
  hook(request: HookRequest): Reply | Promise<Reply>;
  /** A native Kiro permission prompt the companion extension observed. Aborted like a hook. */
  companionAsk(ask: unknown, signal: AbortSignal): Reply | Promise<Reply>;
  /**
   * A companion opens its command stream. `write` sends one line to it. Returns what to call when
   * the stream closes, or undefined to refuse the hello (400).
   */
  companionConnect(hello: unknown, write: (line: string) => void): (() => void) | undefined;
  /** How full a chat's context window is, from the companion. */
  companionContext(body: unknown): Reply;
  /** Correlated result of a session setting command sent to one companion. */
  companionConfigResult(body: unknown): Reply;
  /** `ki-deck report`: writes (and opens) the activity report. */
  report(body: Record<string, unknown>): Promise<Reply>;
  /** `ki-deck push test`: sends one test push. */
  pushTest(): Promise<Reply>;
  health(): unknown;
  sessions(): unknown;
  /** Deck sessions: `GET /v1/deck` is `list`, `POST /v1/deck/<command>` the rest. */
  deck(command: string, body: Record<string, unknown>): Reply | Promise<Reply>;
}

export interface BridgeServer {
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024; // file writes carry the whole file in tool_input

export async function listen(socketPath: string, handlers: Handlers, log: Logger): Promise<BridgeServer> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await removeStaleSocket(socketPath);

  const server = createServer((req, res) => {
    route(req, res, handlers).catch((err: unknown) => {
      log.error(`bridge request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) send(res, 500, "internal error");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  log.info(`bridge listening on ${socketPath}`);

  return {
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => undefined);
    },
  };
}

/** A socket file left by a crashed plugin blocks listen(); remove it unless something answers. */
async function removeStaleSocket(socketPath: string): Promise<void> {
  const answered = await new Promise<boolean>((resolve) => {
    const probe = connect(socketPath);
    const done = (alive: boolean) => {
      probe.destroy();
      resolve(alive);
    };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
    probe.setTimeout(300, () => done(false));
  });
  if (answered) throw new Error(`another bridge is already listening on ${socketPath}`);
  await unlink(socketPath).catch(() => undefined);
}

async function route(req: IncomingMessage, res: ServerResponse, handlers: Handlers): Promise<void> {
  const path = (req.url ?? "/").split("?")[0];
  if (req.method === "GET" && path === "/v1/health") return json(res, handlers.health());
  if (req.method === "GET" && path === "/v1/sessions") return json(res, handlers.sessions());
  if (req.method === "POST" && path === "/v1/hook") return handleHook(req, res, handlers);
  if (req.method === "POST" && path === "/v1/companion/ask") return handleCompanionAsk(req, res, handlers);
  if (req.method === "POST" && path === "/v1/companion/connect") return handleCompanionConnect(req, res, handlers);
  if (req.method === "POST" && path === "/v1/companion/context") {
    const body = await readObject(req, res);
    if (body !== undefined) reply(res, handlers.companionContext(body));
    return;
  }
  if (req.method === "POST" && path === "/v1/companion/config-result") {
    const body = await readObject(req, res);
    if (body !== undefined) reply(res, handlers.companionConfigResult(body));
    return;
  }
  if (req.method === "POST" && path === "/v1/report") {
    const body = await readObject(req, res);
    if (body !== undefined) reply(res, await handlers.report(body));
    return;
  }
  if (req.method === "POST" && path === "/v1/push/test") return reply(res, await handlers.pushTest());
  if (req.method === "GET" && path === "/v1/deck") return reply(res, await handlers.deck("list", {}));
  const deck = /^\/v1\/deck\/([a-z]+)$/.exec(path ?? "");
  if (req.method === "POST" && deck) {
    const body = await readObject(req, res);
    if (body !== undefined) reply(res, await handlers.deck(deck[1]!, body));
    return;
  }
  return send(res, 404, "not found");
}

function reply(res: ServerResponse, r: Reply): void {
  if (r.body !== undefined && r.body.startsWith("{")) {
    res.writeHead(r.status, { "Content-Type": "application/json" });
    res.end(r.body);
  } else {
    send(res, r.status, r.body);
  }
}

async function handleHook(req: IncomingMessage, res: ServerResponse, handlers: Handlers): Promise<void> {
  const event = await readObject(req, res);
  if (event === undefined) return;
  const signal = closeSignal(res);
  const reply = await handlers.hook({
    mode: header(req, "x-kd-mode") === "gate" ? "gate" : "observe",
    category: header(req, "x-kd-category"),
    meta: metaFrom(req),
    event: event as HookEvent,
    signal,
  });
  if (!signal.aborted) send(res, reply.status, reply.body);
}

async function handleCompanionAsk(req: IncomingMessage, res: ServerResponse, handlers: Handlers): Promise<void> {
  const ask = await readObject(req, res);
  if (ask === undefined) return;
  const signal = closeSignal(res);
  const reply = await handlers.companionAsk(ask, signal);
  if (!signal.aborted) send(res, reply.status, reply.body);
}

/** A command stream: the response stays open, and every command is one JSON line on it. */
async function handleCompanionConnect(req: IncomingMessage, res: ServerResponse, handlers: Handlers): Promise<void> {
  const hello = await readObject(req, res);
  if (hello === undefined) return;
  const close = handlers.companionConnect(hello, (line) => {
    if (!res.writableEnded) res.write(line);
  });
  if (!close) return send(res, 400, "unusable hello");
  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
  res.flushHeaders();
  res.on("close", close);
}

/** Reads a JSON object body, answering the request with 4xx and returning undefined on failure. */
async function readObject(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
  const body = await readBody(req);
  if (body === undefined) {
    send(res, 413, "payload too large");
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    send(res, 400, "invalid JSON");
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    send(res, 400, "expected an object");
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** An AbortSignal that fires when the client disconnects before the answer is written. */
function closeSignal(res: ServerResponse): AbortSignal {
  const disconnected = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) disconnected.abort();
  });
  return disconnected.signal;
}

function metaFrom(req: IncomingMessage): HookMeta {
  const pid = header(req, "x-kd-pid");
  return {
    surface: header(req, "x-kd-surface") === "ide" ? "ide" : "cli",
    bundle: header(req, "x-kd-bundle"),
    term: header(req, "x-kd-term"),
    termSession: header(req, "x-kd-term-session"),
    tmuxPane: header(req, "x-kd-tmux-pane"),
    tty: header(req, "x-kd-tty"),
    ...(/^\d{1,9}$/.test(pid) && Number(pid) > 1 ? { pid: Number(pid) } : {}),
  };
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim().slice(0, 512) ?? "";
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(tooLarge ? undefined : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function send(res: ServerResponse, status: number, body?: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}
