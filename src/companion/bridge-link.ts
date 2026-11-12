// Hands each permission ask Kiro shows to the plugin's bridge over its private Unix socket, and
// waits for the deck's decision. One held-open POST per ask, mirroring the gate's kd-hook flow:
// the bridge merges the ask into the same approval model, and the reply says how the deck
// answered. The request is aborted when Kiro resolves the ask (answered in its own dialog or
// elsewhere), in which case the companion leaves the dialog to Kiro and answers nothing.

import { request } from "node:http";
import type { CompanionCommand, CompanionConfigResult, CompanionInfo, ConfigId } from "../bridge/companions";
import type { PermissionAsk } from "./ask";

export type { CompanionCommand };

export interface BridgeDecision {
  kind: "allow" | "deny" | "ask";
  /** For deny: the reason the agent sees. */
  reason?: string;
}

export class BridgeLink {
  private readonly inflight = new Map<string, AbortController>();

  constructor(private readonly socketPath: string) {}

  private static key(toolCallId: string, consentRound?: number): string {
    return `${toolCallId}:${consentRound ?? 0}`;
  }

  /**
   * Posts an ask and resolves with the deck's decision. Resolves undefined when the bridge is
   * unreachable or the ask was cancelled, so the caller leaves Kiro's own dialog to handle it.
   */
  ask(ask: PermissionAsk): Promise<BridgeDecision | undefined> {
    const key = BridgeLink.key(ask.toolCallId, ask.consentRound);
    this.inflight.get(key)?.abort(); // a new consent round for the same call supersedes the old
    const controller = new AbortController();
    this.inflight.set(key, controller);
    const body = JSON.stringify(ask);

    return new Promise<BridgeDecision | undefined>((resolve) => {
      let settled = false;
      const done = (value: BridgeDecision | undefined): void => {
        if (settled) return;
        settled = true;
        if (this.inflight.get(key) === controller) this.inflight.delete(key);
        resolve(value);
      };
      const req = request(
        {
          socketPath: this.socketPath,
          path: "/v1/companion/ask",
          method: "POST",
          headers: jsonHeaders(body),
          signal: controller.signal,
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => done(res.statusCode === 200 ? parseDecision(data) : undefined));
        },
      );
      req.on("error", () => done(undefined)); // unreachable bridge, or an abort
      req.end(body);
    });
  }

  /** Kiro resolved the ask: stop waiting on the bridge for it. */
  cancel(toolCallId: string, consentRound?: number): void {
    if (consentRound !== undefined) {
      this.inflight.get(BridgeLink.key(toolCallId, consentRound))?.abort();
      return;
    }
    for (const [key, controller] of this.inflight) {
      if (key.startsWith(`${toolCallId}:`)) controller.abort();
    }
  }

  /** Aborts every pending post, e.g. when the hub connection drops. */
  close(): void {
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
  }

  /**
   * How full a chat's context window is. Resolves true when the bridge took it, false when it
   * does not know the chat yet or is unreachable.
   */
  context(pid: number, sessionId: string, percent: number): Promise<boolean> {
    return this.post("/v1/companion/context", { pid, sessionId, percent });
  }

  /** Returns a session setting result to the bridge process that requested it. */
  configResult(pid: number, requestId: string, result: CompanionConfigResult): Promise<boolean> {
    return this.post("/v1/companion/config-result", { pid, requestId, ...result });
  }

  /**
   * Holds a stream open to the bridge, which writes a command per line for this window: show a
   * chat, show a terminal, or set one live session option. `onOpen` runs when the bridge accepted
   * it, `onClose` once when it ends. Returns a function that closes it.
   */
  commands(hello: CompanionHello, handlers: { onOpen(): void; onCommand(command: CompanionCommand): void; onClose(reason: string): void }): () => void {
    const body = JSON.stringify(hello);
    let closed = false;
    const close = (reason: string): void => {
      if (closed) return;
      closed = true;
      handlers.onClose(reason);
    };
    const req = request({ socketPath: this.socketPath, path: "/v1/companion/connect", method: "POST", headers: jsonHeaders(body) }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return close(`bridge answered ${res.statusCode}`);
      }
      handlers.onOpen();
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
          const command = parseCommand(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (command) handlers.onCommand(command);
        }
      });
      res.on("end", () => close("bridge closed the stream"));
      res.on("error", () => close("stream error"));
    });
    req.on("error", (error) => close(error.message));
    req.end(body);
    return () => {
      closed = true;
      req.destroy();
    };
  }

  private post(path: string, value: object): Promise<boolean> {
    return new Promise((resolve) => {
      const body = JSON.stringify(value);
      const req = request({ socketPath: this.socketPath, path, method: "POST", headers: jsonHeaders(body), timeout: 5000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 204);
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(false));
      req.end(body);
    });
  }
}

/** Who holds a command stream: one companion, in one Kiro window with these workspace folders. */
export type CompanionHello = CompanionInfo;

function jsonHeaders(body: string): Record<string, string | number> {
  return { "content-type": "application/json", "content-length": Buffer.byteLength(body) };
}

/** One line of the command stream. Unknown or malformed commands are skipped. */
export function parseCommand(line: string): CompanionCommand | undefined {
  try {
    const value = JSON.parse(line) as {
      kind?: unknown;
      requestId?: unknown;
      sessionId?: unknown;
      configId?: unknown;
      value?: unknown;
      tty?: unknown;
    };
    if (value.kind === "focus" && bounded(value.sessionId, 160)) return { kind: "focus", sessionId: value.sessionId };
    if (value.kind === "terminal" && typeof value.tty === "string" && /^ttys?\d{1,4}$/.test(value.tty)) return { kind: "terminal", tty: value.tty };
    if (
      value.kind === "set_config" &&
      bounded(value.requestId, 80) &&
      bounded(value.sessionId, 160) &&
      isConfigId(value.configId) &&
      bounded(value.value, 256)
    ) {
      return { kind: "set_config", requestId: value.requestId, sessionId: value.sessionId, configId: value.configId, value: value.value };
    }
  } catch {
    // a partial or foreign line
  }
  return undefined;
}

function isConfigId(value: unknown): value is ConfigId {
  return value === "model" || value === "effortLevel" || value === "autopilot";
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function parseDecision(body: string): BridgeDecision | undefined {
  try {
    const parsed = JSON.parse(body) as { kind?: unknown; reason?: unknown };
    if (parsed.kind !== "allow" && parsed.kind !== "deny" && parsed.kind !== "ask") return undefined;
    return { kind: parsed.kind, ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}) };
  } catch {
    return undefined;
  }
}
