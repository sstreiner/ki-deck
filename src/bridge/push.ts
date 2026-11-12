// Optional push notifications to the phone, for when you are away from the Mac. Off unless
// `notifications.push` in config.json names a provider you run or chose: ntfy (ntfy.sh or your own
// server) or Pushover. This is the plugin's only outbound network traffic. A push says which
// workspace needs you and why ("Wants to run shell", "Finished after 4m"), never a command, a
// file name or code, and the plugin never acts on anything that comes back.

import { inQuietHours } from "./config";
import type { Logger } from "./logger";
import type { Runner } from "./system";

export type PushEvent = "approval" | "finished" | "ungated";
const PUSH_EVENTS: readonly PushEvent[] = ["approval", "finished", "ungated"];

export interface PushTarget {
  provider: "ntfy" | "pushover";
  /** Where the request goes. */
  endpoint: string;
  /** For status lines: the server's host, never a token or the topic. */
  host: string;
  topic?: string; // ntfy
  token?: string; // ntfy access token, or the Pushover application token
  user?: string; // Pushover user key
  events: Set<PushEvent>;
  awayMinutes: number; // only when the Mac has been idle this long; 0: always
  /** An approval is pushed only if it still waits this long; 0: at once. */
  approvalDelaySeconds: number;
}

export interface PushMessage {
  event: PushEvent;
  title: string;
  message: string;
  /** Approvals: high priority, and sent during quiet hours (the agent waits until someone answers). */
  urgent: boolean;
}

export type ParsedPush = { target: PushTarget } | { error: string } | { off: true };

/** A waiting approval is pushed after this long, so a call answered at the Mac never reaches the phone. */
const DEFAULT_APPROVAL_DELAY_SECONDS = 300;
/** A native Kiro prompt waits on the deck at most 30 minutes (src/bridge/index.ts). */
const MAX_APPROVAL_DELAY_SECONDS = 1800;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const NTFY_TOPIC = /^[-_A-Za-z0-9]{1,64}$/;
const PUSHOVER_KEY = /^[A-Za-z0-9]{20,40}$/;
const PUSHOVER_ENDPOINT = "https://api.pushover.net/1/messages.json";

/**
 * Reads `notifications.push`. `null` or missing: off. Expected shapes:
 *   { "provider": "ntfy", "url": "https://ntfy.sh/<topic>", "token": "tk_..." (optional) }
 *   { "provider": "pushover", "token": "<application token>", "user": "<user key>" }
 * plus, for both, optional "events" (approval, finished, ungated), "awayMinutes" and
 * "approvalDelaySeconds" (default 300).
 */
export function parsePush(value: unknown): ParsedPush {
  if (value === null || value === undefined || value === false) return { off: true };
  if (typeof value !== "object" || Array.isArray(value)) return { error: "notifications.push must be an object or null" };
  const v = value as Record<string, unknown>;
  const events = parseEvents(v.events);
  if ("error" in events) return events;
  const away = v.awayMinutes ?? 0;
  if (typeof away !== "number" || !Number.isFinite(away) || away < 0) return { error: "awayMinutes must be a number of minutes (0 or more)" };
  const delay = v.approvalDelaySeconds ?? DEFAULT_APPROVAL_DELAY_SECONDS;
  if (typeof delay !== "number" || !Number.isFinite(delay) || delay < 0 || delay > MAX_APPROVAL_DELAY_SECONDS) {
    return { error: `approvalDelaySeconds must be a number of seconds from 0 to ${MAX_APPROVAL_DELAY_SECONDS}` };
  }
  const token = typeof v.token === "string" && v.token.trim() ? v.token.trim() : undefined;
  // Visible ASCII only: anything else cannot go into a header, and the error would quote it.
  if (token && !/^[\x21-\x7e]{1,256}$/.test(token)) return { error: '"token" may only contain visible ASCII characters (check for a line break or space)' };
  const common = { events: events.events, awayMinutes: away, approvalDelaySeconds: delay, ...(token ? { token } : {}) };

  if (v.provider === "ntfy") {
    let url: URL;
    try {
      url = new URL(String(v.url ?? ""));
    } catch {
      return { error: 'ntfy needs "url", for example https://ntfy.sh/your-topic' };
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
      return { error: "the ntfy url must use https (http only for a server on this Mac)" };
    }
    if (url.username || url.password || url.search || url.hash) return { error: 'put credentials in "token", not in the ntfy url' };
    const parts = url.pathname.split("/").filter(Boolean);
    const topic = parts.pop();
    if (!topic || !NTFY_TOPIC.test(topic)) return { error: "the ntfy url must end with a topic (letters, digits, - and _)" };
    // JSON messages go to the server's root, with the topic in the body (UTF-8 safe, unlike headers).
    const root = `${url.origin}/${parts.map((p) => `${p}/`).join("")}`;
    return { target: { provider: "ntfy", endpoint: root, host: url.host, topic, ...common } };
  }
  if (v.provider === "pushover") {
    const user = typeof v.user === "string" ? v.user.trim() : "";
    if (!token || !PUSHOVER_KEY.test(token)) return { error: 'Pushover needs "token": your application token' };
    if (!PUSHOVER_KEY.test(user)) return { error: 'Pushover needs "user": your user key' };
    return { target: { provider: "pushover", endpoint: PUSHOVER_ENDPOINT, host: "api.pushover.net", user, ...common } };
  }
  return { error: 'notifications.push.provider must be "ntfy" or "pushover"' };
}

function parseEvents(value: unknown): { events: Set<PushEvent> } | { error: string } {
  if (value === undefined) return { events: new Set(PUSH_EVENTS) };
  if (!Array.isArray(value)) return { error: "notifications.push.events must be a list" };
  const events = new Set<PushEvent>();
  for (const e of value) {
    if (!PUSH_EVENTS.includes(e as PushEvent)) return { error: `unknown push event "${String(e)}" (use ${PUSH_EVENTS.join(", ")})` };
    events.add(e as PushEvent);
  }
  return { events };
}

export interface PushRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one push. */
export function pushRequest(target: PushTarget, msg: PushMessage): PushRequest {
  if (target.provider === "ntfy") {
    const tags = { approval: ["raised_hand"], finished: ["white_check_mark"], ungated: ["warning"] }[msg.event];
    return {
      url: target.endpoint,
      method: "POST",
      headers: { "Content-Type": "application/json", ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}) },
      body: JSON.stringify({ topic: target.topic, title: msg.title, message: msg.message, priority: msg.urgent ? 4 : 3, tags }),
    };
  }
  const form = new URLSearchParams({ token: target.token ?? "", user: target.user ?? "", title: msg.title, message: msg.message, priority: msg.urgent ? "1" : "0" });
  return { url: target.endpoint, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() };
}

/** An error message without the target's secrets, for logs and `push test`. */
function redact(err: unknown, t: PushTarget): string {
  let message = err instanceof Error ? (err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message) : String(err);
  for (const secret of [t.token, t.user, t.topic]) if (secret) message = message.split(secret).join("***");
  return message.slice(0, 300);
}

/** "5 min", "90 s". */
function formatSeconds(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

/** Seconds since the last keyboard or mouse input, from `ioreg -c IOHIDSystem` (HIDIdleTime is in ns). */
export function parseIdleSeconds(ioreg: string): number | undefined {
  const m = /"HIDIdleTime" = (\d+)/.exec(ioreg);
  return m ? Number(m[1]) / 1e9 : undefined;
}

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: "error" },
) => Promise<{ ok: boolean; status: number }>;

export interface PusherOptions {
  /** `notifications.push` and the quiet hours, read live from config.json. */
  config: () => { push: unknown; quietHours: string };
  run: Runner;
  log: Logger;
  now?: () => Date;
  fetch?: Fetch;
}

/** The same event for the same session is pushed at most once a minute. */
const REPEAT_MS = 60_000;
const TIMEOUT_MS = 10_000;

export class Pusher {
  private readonly sent = new Map<string, number>();
  /** Approval pushes waiting out `approvalDelaySeconds`, by key. */
  private readonly scheduled = new Map<string, NodeJS.Timeout>();
  private warnedConfig = "";

  constructor(private readonly options: PusherOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private parsed(): ParsedPush {
    const parsed = parsePush(this.options.config().push);
    if ("error" in parsed && parsed.error !== this.warnedConfig) {
      this.warnedConfig = parsed.error;
      this.options.log.warn(`push: off, ${parsed.error}`);
    }
    return parsed;
  }

  /** "off", "ntfy to ntfy.sh", "pushover to api.pushover.net", or "invalid: ...". Never a secret. */
  status(): string {
    const parsed = this.parsed();
    if ("off" in parsed) return "off";
    if ("error" in parsed) return `invalid: ${parsed.error}`;
    const t = parsed.target;
    const delay = t.events.has("approval") && t.approvalDelaySeconds > 0 ? `, approvals after ${formatSeconds(t.approvalDelaySeconds)}` : "";
    return `${t.provider} to ${t.host}${delay}${t.awayMinutes ? `, after ${t.awayMinutes} min away` : ""}`;
  }

  /**
   * Pushes an approval once it has waited `approvalDelaySeconds` (at once when 0), unless
   * `cancel(key)` comes first because someone answered. Other events go out at once.
   */
  schedule(msg: PushMessage, key: string): void {
    const parsed = this.parsed();
    if (!("target" in parsed) || !parsed.target.events.has(msg.event)) return;
    const delay = msg.event === "approval" ? parsed.target.approvalDelaySeconds : 0;
    if (delay <= 0) {
      void this.send(msg, key);
      return;
    }
    this.cancel(key);
    const timer = setTimeout(() => {
      this.scheduled.delete(key);
      void this.send(msg, key);
    }, delay * 1000);
    timer.unref();
    this.scheduled.set(key, timer);
  }

  /** The approval was answered (or handed to Kiro): its delayed push is dropped. */
  cancel(key: string): void {
    const timer = this.scheduled.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.scheduled.delete(key);
  }

  /** Plugin shutdown: nothing scheduled goes out afterwards. */
  stop(): void {
    for (const timer of this.scheduled.values()) clearTimeout(timer);
    this.scheduled.clear();
  }

  /**
   * Pushes `msg` unless push is off, the event is not wanted, it repeats within a minute (`key`),
   * quiet hours hold it back (except urgent ones), or you are at the Mac (`awayMinutes`).
   * Never throws.
   */
  async send(msg: PushMessage, key: string): Promise<void> {
    const parsed = this.parsed();
    if (!("target" in parsed)) return;
    const t = parsed.target;
    if (!t.events.has(msg.event)) return;
    const now = this.now();
    if (!msg.urgent && inQuietHours(this.options.config().quietHours, now)) return;
    const last = this.sent.get(key);
    if (last !== undefined && now.getTime() - last < REPEAT_MS) return;
    for (const [k, at] of this.sent) if (now.getTime() - at > REPEAT_MS) this.sent.delete(k);
    this.sent.set(key, now.getTime()); // before any await, so a second send with this key waits its minute
    if (t.awayMinutes > 0) {
      const idle = await this.idleSeconds();
      if (idle !== undefined && idle < t.awayMinutes * 60) {
        this.sent.delete(key); // you are at the Mac: a later one may still go out once you leave
        return;
      }
    }
    const result = await this.post(t, msg);
    if (!result.ok) this.options.log.warn(`push: ${t.provider} to ${t.host} failed: ${result.message}`);
  }

  /** `ki-deck push test`: one message now, ignoring events, quiet hours and away time. */
  async test(): Promise<{ ok: boolean; message: string }> {
    const parsed = this.parsed();
    if ("off" in parsed) return { ok: false, message: "push is off: set notifications.push in config.json (see the README, section 5.2)" };
    if ("error" in parsed) return { ok: false, message: `notifications.push is not valid: ${parsed.error}` };
    const t = parsed.target;
    const result = await this.post(t, { event: "finished", title: "Kiro", message: "Test from ki-deck. Push works.", urgent: false });
    return result.ok ? { ok: true, message: `Sent a test push with ${t.provider} to ${t.host}.` } : { ok: false, message: `${t.provider} to ${t.host} failed: ${result.message}` };
  }

  private async post(t: PushTarget, msg: PushMessage): Promise<{ ok: boolean; message: string }> {
    const req = pushRequest(t, msg);
    const doFetch: Fetch = this.options.fetch ?? ((url, init) => fetch(url, init));
    try {
      // No redirects: one to plain http would resend the message unencrypted.
      const res = await doFetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
      return res.ok ? { ok: true, message: "" } : { ok: false, message: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, message: redact(err, t) };
    }
  }

  private async idleSeconds(): Promise<number | undefined> {
    const result = await this.options.run("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"]);
    return result.ok ? parseIdleSeconds(result.stdout) : undefined;
  }
}
