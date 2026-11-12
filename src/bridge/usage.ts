// Kiro account usage (credits) through `kiro-cli acp`: initialize, then the Kiro extension
// `_kiro/account/getUsage`. No session is created, so this costs no credits and fires no
// hooks. kiro-cli owns the login; the plugin never sees a token.

import { AcpConnection, AcpError } from "./acp";
import type { Logger } from "./logger";

export interface UsageSnapshot {
  plan: string; // "Pro Max"
  resetDate?: string; // YYYY-MM-DD, when credits reset
  credits?: {
    used: number;
    limit?: number;
    percent?: number; // 0 to 100+
    overageCharges: number;
    currency: string;
  };
  overagesEnabled: boolean;
  managedByAdmin: boolean;
}

export interface UsageState {
  snapshot?: UsageSnapshot;
  fetchedAt?: number;
  error?: string;
  errorAt?: number;
  fetching: boolean;
}

export interface ClientOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Stop kiro-cli after this long without a request (default 2 minutes). */
  idleCloseMs?: number;
}

const DEFAULT_ARGS = ["acp", "--agent-engine=v3"];
const DEFAULT_IDLE_CLOSE_MS = 2 * 60_000;

/** Turns the getUsage result into a snapshot. Throws when Kiro reports a failure. */
export function parseUsage(result: unknown): UsageSnapshot {
  const r = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;
  if (r.success !== true) throw new Error(typeof r.message === "string" ? r.message : "Kiro did not return usage");
  const data = r.data as Record<string, unknown> | undefined;
  if (!data) return { plan: "Managed by admin", overagesEnabled: false, managedByAdmin: true };

  const breakdowns = Array.isArray(data.usageBreakdowns) ? (data.usageBreakdowns as Array<Record<string, unknown>>) : [];
  const b = breakdowns.find((x) => x.resourceType === "CREDIT") ?? breakdowns[0];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  let credits: UsageSnapshot["credits"];
  if (b && num(b.used) !== undefined) {
    const used = num(b.used)!;
    const limit = b.hasLimit === false ? undefined : num(b.limit);
    const percent = num(b.percentage) ?? (limit ? (used / limit) * 100 : undefined);
    credits = {
      used,
      ...(limit !== undefined ? { limit } : {}),
      ...(percent !== undefined ? { percent } : {}),
      overageCharges: num(b.overageCharges) ?? 0,
      currency: typeof b.currency === "string" ? b.currency : "USD",
    };
  }
  return {
    plan: planLabel(typeof data.planName === "string" ? data.planName : "Kiro"),
    ...(typeof data.billingCycleReset === "string" ? { resetDate: data.billingCycleReset } : {}),
    ...(credits ? { credits } : {}),
    overagesEnabled: data.overagesEnabled === true,
    managedByAdmin: false,
  };
}

/** "KIRO PRO MAX" -> "Pro Max", "KIRO PRO+" -> "Pro+". */
export function planLabel(name: string): string {
  const words = name.replace(/^KIRO\s+/i, "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Kiro";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

/**
 * Asks kiro-cli for usage over one ACP connection that stays open between requests: starting
 * kiro-cli and initializing takes about 0.6 s and a second of CPU, a request on the open
 * connection about 60 ms and next to none. The idle kiro-cli holds about 300 MB, so it is
 * stopped after `idleCloseMs` without a request and started again on the next one.
 */
export class UsageClient {
  private acp?: AcpConnection;
  private ready?: Promise<AcpConnection>;
  private idleTimer?: NodeJS.Timeout;

  constructor(private readonly options: ClientOptions) {}

  /** True while kiro-cli is running for us. */
  get connected(): boolean {
    return this.acp !== undefined && !this.acp.isClosed;
  }

  async fetch(): Promise<UsageSnapshot> {
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const acp = await this.connection(timeoutMs);
    this.closeWhenIdle();
    let result: unknown;
    try {
      // Not listed in extensionMethods by kiro-cli 3.0.0, but answered; so call it directly.
      result = await acp.request("_kiro/account/getUsage", {}, timeoutMs);
    } catch (err) {
      this.close(); // a timeout or a dead agent: start over next time
      throw withStderr(err, acp);
    }
    return parseUsage(result); // Kiro's own errors (not logged in, ...) keep the connection
  }

  close(): void {
    clearTimeout(this.idleTimer);
    this.acp?.close();
    this.acp = undefined;
    this.ready = undefined;
  }

  private connection(timeoutMs: number): Promise<AcpConnection> {
    if (this.ready && this.connected) return this.ready;
    this.close();
    const acp = AcpConnection.spawn(this.options.command, this.options.args ?? DEFAULT_ARGS, this.options.env);
    this.acp = acp;
    const ready = acp
      .request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "ki-deck", version: "1" },
        },
        timeoutMs,
      )
      .then(
        () => acp,
        (err) => {
          if (this.acp === acp) this.close();
          throw withStderr(err, acp);
        },
      );
    this.ready = ready;
    return ready;
  }

  private closeWhenIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS);
    this.idleTimer.unref();
  }
}

function withStderr(err: unknown, acp: AcpConnection): unknown {
  const tail = acp.stderr.trim().split("\n").filter(Boolean).at(-1);
  return err instanceof AcpError && tail ? new Error(`${err.message}: ${tail.slice(0, 200)}`) : err;
}

export interface UsageTiming {
  /** Refresh interval while an agent is working. */
  activeMs: number;
  /** Refresh interval otherwise; catches usage from other machines. */
  idleMs: number;
}

/** How often the monitor checks whether a refresh is due. */
export const USAGE_TICK_MS = 2000;
/** The earliest automatic retry after a failed fetch. */
export const USAGE_RETRY_MS = 60_000;

/**
 * Keeps a fresh usage snapshot while at least one key shows it. Refreshes when the snapshot is
 * older than the active or idle interval (or a minute after a failure), when nudged (a turn
 * ended), and on demand. Never runs two fetches at once.
 */
export class UsageMonitor {
  private current: UsageState = { fetching: false };
  private inFlight?: Promise<boolean>;
  private watchers = 0;
  private timer?: NodeJS.Timeout;
  private nudgeAt?: number;

  constructor(
    private readonly fetcher: () => Promise<UsageSnapshot>,
    private readonly timing: () => UsageTiming,
    private readonly active: () => boolean,
    private readonly now: () => number,
    private readonly onChange: () => void,
    private readonly log: Logger,
  ) {}

  get state(): UsageState {
    return this.current;
  }

  /** A key that shows usage appeared. */
  watch(): void {
    this.watchers++;
    if (this.watchers === 1) {
      this.timer = setInterval(() => this.tick(), USAGE_TICK_MS);
      this.timer.unref();
      this.tick();
    }
  }

  get watched(): boolean {
    return this.watchers > 0;
  }

  /** A key that shows usage went away. */
  unwatch(): void {
    this.watchers = Math.max(0, this.watchers - 1);
    if (this.watchers === 0) this.stop();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.nudgeAt = undefined;
  }

  /** Refresh about `delayMs` from now, if a key shows usage (a turn just ended, say). */
  nudge(delayMs: number): void {
    if (!this.watched) return;
    const at = this.now() + delayMs;
    this.nudgeAt = Math.min(this.nudgeAt ?? at, at);
  }

  /** Fetches now (or joins the fetch already running). True on success. */
  refresh(): Promise<boolean> {
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private tick(): void {
    const now = this.now();
    if (this.nudgeAt !== undefined && now >= this.nudgeAt) {
      this.nudgeAt = undefined;
      void this.refresh();
      return;
    }
    const { fetchedAt = 0, errorAt = 0 } = this.current;
    const { activeMs, idleMs } = this.timing();
    let interval = this.active() ? activeMs : idleMs;
    if (errorAt > fetchedAt) interval = Math.max(interval, USAGE_RETRY_MS);
    if (now - Math.max(fetchedAt, errorAt) >= interval) void this.refresh();
  }

  private async run(): Promise<boolean> {
    this.current = { ...this.current, fetching: true };
    this.onChange();
    try {
      const snapshot = await this.fetcher();
      this.current = { snapshot, fetchedAt: this.now(), fetching: false };
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`usage: ${message}`);
      this.current = { ...this.current, error: message, errorAt: this.now(), fetching: false };
      return false;
    } finally {
      this.onChange();
    }
  }
}
