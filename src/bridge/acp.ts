// Minimal Agent Client Protocol client: newline-delimited JSON-RPC 2.0 over a child
// process's stdin and stdout, as `kiro-cli acp --agent-engine=v3` speaks it.
// Requests from the agent go to `handlers.request`; without a handler, or when it declines,
// they are answered with "method not found", so the agent never waits on us.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "AcpError";
  }
}

export interface AcpHandlers {
  /** A notification from the agent (`session/update`, ...). */
  notification?(method: string, params: unknown): void;
  /**
   * A request from the agent. Return a promise for the result, or undefined to answer
   * "method not found". A rejected promise is answered with an internal error.
   */
  request?(method: string, params: unknown): Promise<unknown> | undefined;
  /** The connection closed: the agent exited or `close()` was called. Called once. */
  closed?(err: Error): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

export class AcpConnection {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private stderrTail = "";

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly handlers: AcpHandlers,
  ) {
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000);
    });
    child.stdin.on("error", () => undefined); // EPIPE once the agent has exited
    child.on("error", (err) => this.failAll(new AcpError(`could not start ${err.message}`)));
    // "close" comes once stdout and stderr are drained, so the error can quote stderr. A helper
    // process may keep the pipes open after the agent exits; don't wait for it longer than 500 ms.
    const exited = (code: number | null, signal: NodeJS.Signals | null) =>
      this.failAll(new AcpError(`agent exited (${signal ?? `code ${code}`})`));
    child.on("close", exited);
    child.on("exit", (code, signal) => setTimeout(() => exited(code, signal), 500).unref());
  }

  static spawn(command: string, args: string[], env: NodeJS.ProcessEnv = process.env, handlers: AcpHandlers = {}): AcpConnection {
    return new AcpConnection(spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] }), handlers);
  }

  /**
   * Sends a request and resolves with its `result`, or rejects with the error, exit or timeout.
   * `timeoutMs` 0 waits as long as the agent runs (a prompt turn can take hours).
   */
  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.closed) return Promise.reject(new AcpError("connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new AcpError(`${method} timed out after ${Math.round(timeoutMs / 1000)} s`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Sends a notification (no answer), such as `session/cancel`. */
  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** The last lines the agent wrote to stderr, for error messages. */
  get stderr(): string {
    return this.stderrTail;
  }

  /** True once the connection was closed or the agent exited; requests then fail at once. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** The agent's process ID, while it runs. */
  get pid(): number | undefined {
    return this.child.pid;
  }

  close(): void {
    if (this.closed) return;
    this.failAll(new AcpError("connection closed"));
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }

  private send(message: object): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not a protocol message
    }
    if (typeof msg !== "object" || msg === null) return;
    if (msg.method !== undefined) {
      if (msg.id === undefined) this.handlers.notification?.(msg.method, msg.params);
      else this.answer(msg.id, msg.method, msg.params);
      return;
    }
    const entry = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
    if (!entry || typeof msg.id !== "number") return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new AcpError(msg.error.message ?? "request failed", msg.error.code));
    else entry.resolve(msg.result);
  }

  /** Every request from the agent gets exactly one answer, so it never hangs. */
  private answer(id: number | string, method: string, params: unknown): void {
    const pending = this.handlers.request?.(method, params);
    if (!pending) {
      this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    pending.then(
      (result) => this.send({ jsonrpc: "2.0", id, result: result ?? null }),
      (err: unknown) => this.send({ jsonrpc: "2.0", id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } }),
    );
  }

  private failAll(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    this.handlers.closed?.(err);
  }
}
