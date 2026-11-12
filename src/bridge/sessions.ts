// Session registry: turns the stream of Kiro hook events into per-session state.
// Pure apart from the injected clock values and `isAlive`, so it is unit-tested directly.

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { categorize, summarize, type ToolCategory } from "./tools";

/** Where a session runs. `deck`: a session the plugin itself started over ACP (src/bridge/deck.ts). */
export type Surface = "ide" | "cli" | "deck";
export type SessionState = "idle" | "working" | "done" | "stale";
export type AttentionKind = "approval" | "ungated" | "may-need-you" | "done";

/** Lower is more urgent. A call that skipped its gate comes right after calls that wait. */
export const ATTENTION_PRIORITY: Record<AttentionKind, number> = { approval: 0, ungated: 1, "may-need-you": 2, done: 3 };

/** Lets the bridge put approvals (which the registry does not know) ahead of everything else. */
export type AttentionOverride = (s: Session) => Attention | undefined;

/** Where a session runs, from the `X-KD-*` headers kd-hook sends. */
export interface Origin {
  bundle: string; // __CFBundleIdentifier of the app the harness inherited
  term: string; // TERM_PROGRAM
  termSession: string; // ITERM_SESSION_ID or TERM_SESSION_ID
  tmuxPane: string;
  tty: string;
  pid?: number; // the agent harness process
}

export interface HookMeta extends Origin {
  surface: Surface;
}

/** Kiro hook payload (stdin JSON). Everything is untrusted input. */
export interface HookEvent {
  hook_event_name?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  spec_name?: unknown;
  task_name?: unknown;
  prompt?: unknown;
}

export interface ToolCall {
  key: string;
  name: string;
  category: ToolCategory;
  summary: string;
  since: number;
  /** Its gate was on (or lockdown) when it started, so a gate request had to come. Set by the bridge. */
  expectGate?: boolean;
  /** A gate request for this call reached the bridge. */
  gated?: boolean;
}

/** Tool calls in gated categories that ran without their gate hook asking the deck. */
export interface UngatedAlert {
  tool: string;
  category: ToolCategory;
  summary: string;
  at: number; // the last one
  count: number;
}

export interface Session {
  id: string;
  cwd: string;
  workspace: string;
  surface: Surface;
  origin: Origin;
  state: SessionState;
  firstSeen: number;
  lastEvent: number;
  /** When its last turn started (first seen until then). Orders the session keys. */
  activeAt: number;
  turnStartedAt?: number;
  doneAt?: number;
  lastTurnMs?: number;
  pending: ToolCall[]; // tool calls started but not finished (sub-agents can run several)
  lastTool?: ToolCall;
  compacting: boolean;
  task?: { spec: string; task: string; running: boolean };
  counts: { prompts: number; tools: number; turns: number };
  acknowledged: boolean; // a finished turn the user has seen
  ungated?: UngatedAlert; // until the user focuses the session or holds its key
  /** Known only from a native Kiro prompt the companion saw; no hook event yet. */
  promptOnly?: boolean;
  /** Share of the model's context window in use (0..100), from the companion for IDE chats. */
  contextPercent?: number;
}

export interface Attention {
  kind: AttentionKind;
  since: number;
  /** For approvals: "<category>: <summary>" of the waiting call. */
  detail?: string;
  category?: string;
}

export type RemovalReason = "session-end" | "process-exited" | "idle-expired" | "app-quit" | "dismissed" | "prompt-ended";

export interface RegistryOptions {
  mayNeedYouMs: () => number;
  staleMs: () => number;
  idleExpiryMs: () => number;
  isAlive: (pid: number) => boolean;
  onRemove?: (s: Session, reason: RemovalReason) => void;
  /** A tool call finished (PostToolUse). Denied calls never finish. */
  onToolDone?: (s: Session, call: ToolCall, now: number) => void;
}

/** Tool categories Kiro may stop to ask about. A long-pending call here "may need you". */
const PROMPTING: ReadonlySet<ToolCategory> = new Set(["shell", "write", "mcp"]);

export function toolKey(name: string, input: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(input ?? null)).digest("hex");
  return `${name}:${digest.slice(0, 16)}`;
}

export function attentionOf(s: Session, now: number, mayNeedYouMs: number): Attention | undefined {
  if (s.ungated) {
    const u = s.ungated;
    return { kind: "ungated", since: u.at, detail: `${u.category}: ${u.summary}`, category: u.category };
  }
  if (s.state === "working" || s.state === "stale") {
    const waiting = s.pending.find((t) => PROMPTING.has(t.category) && now - t.since >= mayNeedYouMs);
    if (waiting) return { kind: "may-need-you", since: waiting.since };
  }
  if (s.state === "done" && !s.acknowledged && s.doneAt !== undefined) return { kind: "done", since: s.doneAt };
  return undefined;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly options: RegistryOptions) {}

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }

  /** Applies one hook event. Returns the session it touched, or undefined for unusable events. */
  ingest(event: HookEvent, meta: HookMeta, now: number): Session | undefined {
    const id = str(event.session_id);
    const name = str(event.hook_event_name);
    if (!id || !name) return undefined;
    if (name === "SessionEnd") {
      const ended = this.sessions.get(id);
      if (ended) this.remove(ended, "session-end");
      return undefined;
    }

    const s = this.sessions.get(id) ?? this.create(id, meta, now);
    this.updateOrigin(s, meta, str(event.cwd));
    s.lastEvent = now;
    s.promptOnly = undefined;

    switch (name) {
      case "UserPromptSubmit":
        s.state = "working";
        s.turnStartedAt = now;
        s.activeAt = now;
        s.doneAt = undefined;
        s.pending = [];
        s.acknowledged = false;
        s.counts.prompts++;
        break;
      case "PreToolUse": {
        const toolName = str(event.tool_name) || "tool";
        const call: ToolCall = {
          key: toolKey(toolName, event.tool_input),
          name: toolName,
          category: categorize(toolName),
          summary: summarize(toolName, event.tool_input),
          since: now,
        };
        this.resume(s, now);
        s.pending.push(call);
        s.lastTool = call;
        s.counts.tools++;
        break;
      }
      case "PostToolUse": {
        const done = this.removePending(s, str(event.tool_name), event.tool_input);
        this.resume(s, now);
        if (done) this.options.onToolDone?.(s, done, now);
        break;
      }
      case "Stop":
        s.state = "done";
        s.doneAt = now;
        s.lastTurnMs = s.turnStartedAt !== undefined ? now - s.turnStartedAt : undefined;
        s.turnStartedAt = undefined;
        s.pending = [];
        s.acknowledged = false;
        s.counts.turns++;
        break;
      case "PreCompact":
        s.compacting = true;
        break;
      case "PostCompact":
        s.compacting = false;
        break;
      case "PreTaskExec":
        s.task = { spec: str(event.spec_name), task: str(event.task_name), running: true };
        break;
      case "PostTaskExec":
        if (s.task) s.task.running = false;
        break;
      default: // SessionStart and anything new: presence only
        break;
    }
    return s;
  }

  /**
   * A native Kiro prompt the companion saw for this session. Creates the session when its hooks
   * never reported it (opened before the hooks were installed), so the prompt shows on a Session
   * key and in the Inbox. Such a session is `promptOnly` until a hook event arrives.
   */
  touch(id: string, meta: HookMeta, cwd: string, now: number): Session {
    let s = this.sessions.get(id);
    if (!s) {
      s = this.create(id, meta, now);
      this.updateOrigin(s, meta, cwd);
      s.promptOnly = true;
    }
    s.lastEvent = now;
    return s;
  }

  /**
   * How full the session's context window is, in percent (clamped, one decimal). Ignored for
   * sessions the registry does not know: context alone never puts a session on a key.
   * True when the value changed.
   */
  setContext(id: string, percent: number): boolean {
    const s = this.sessions.get(id);
    if (!s || !Number.isFinite(percent)) return false;
    const value = Math.round(Math.max(0, Math.min(100, percent)) * 10) / 10;
    if (s.contextPercent === value) return false;
    s.contextPercent = value;
    return true;
  }

  /** The user cleared the session's key. Any later hook event brings it back. */
  dismiss(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.remove(s, "dismissed");
    return true;
  }

  /** A gated call that was denied never runs, so no PostToolUse will clear it. */
  toolDenied(id: string, toolName: string, input: unknown): void {
    const s = this.sessions.get(id);
    if (s) this.removePending(s, toolName, input);
  }

  /** A gate request arrived for this call. False when the call is not pending (its PreToolUse was lost). */
  markGated(id: string, toolName: string, input: unknown): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    const key = toolKey(toolName, input);
    const call = s.pending.find((t) => t.key === key && !t.gated) ?? s.pending.find((t) => t.name === toolName && !t.gated);
    if (call) call.gated = true;
    return call !== undefined;
  }

  /** Records a call that ran without its gate. True when the session had no such alert yet. */
  flagUngated(s: Session, call: ToolCall, now: number): boolean {
    const first = s.ungated === undefined;
    s.ungated = { tool: call.name, category: call.category, summary: call.summary, at: now, count: (s.ungated?.count ?? 0) + 1 };
    return first;
  }

  /** The user has seen the session: clears a finished turn and an ungated alert. */
  acknowledge(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    let changed = false;
    if (s.ungated) {
      s.ungated = undefined;
      changed = true;
    }
    if (s.state === "done" && !s.acknowledged) {
      s.acknowledged = true;
      changed = true;
    }
    return changed;
  }

  removeWhere(predicate: (s: Session) => boolean, reason: RemovalReason): boolean {
    let removed = false;
    for (const s of this.all()) {
      if (predicate(s)) {
        this.remove(s, reason);
        removed = true;
      }
    }
    return removed;
  }

  /** True while the session's agent process runs, or when its process is unknown. */
  harnessAlive(s: Session): boolean {
    return s.origin.pid === undefined || this.options.isAlive(s.origin.pid);
  }

  /** Time-based transitions: stale turns, ended processes, long-idle sessions. True if anything changed. */
  tick(now: number): boolean {
    let changed = false;
    for (const s of this.all()) {
      const quietFor = now - s.lastEvent;
      if (!this.harnessAlive(s)) {
        this.remove(s, "process-exited");
        changed = true;
      } else if (s.state === "working" && quietFor > this.options.staleMs()) {
        s.state = "stale";
        changed = true;
      } else if (s.state !== "working" && quietFor > this.options.idleExpiryMs()) {
        this.remove(s, "idle-expired");
        changed = true;
      }
    }
    return changed;
  }

  private remove(s: Session, reason: RemovalReason): void {
    this.sessions.delete(s.id);
    this.options.onRemove?.(s, reason);
  }

  /**
   * Display order for session keys: sessions that need you, then working ones, then the rest
   * (idle, seen, stale). Within each group the most recently started turn comes first, so closed
   * chats drift to the back. Keys move when a turn starts or ends or attention changes, never
   * on a tool call.
   */
  ordered(now: number, override?: AttentionOverride): Session[] {
    const attention = this.attentionFn(now, override);
    const rank = (s: Session) => (attention(s) ? 0 : s.state === "working" ? 1 : 2);
    return this.all()
      .map((s) => ({ s, rank: rank(s) }))
      .sort((a, b) => a.rank - b.rank || b.s.activeAt - a.s.activeAt || a.s.firstSeen - b.s.firstSeen)
      .map(({ s }) => s);
  }

  /** Sessions waiting on the user: approvals first, then by how long they have waited. */
  inbox(now: number, override?: AttentionOverride): Array<{ session: Session; attention: Attention }> {
    const attention = this.attentionFn(now, override);
    return this.all()
      .map((session) => ({ session, attention: attention(session) }))
      .filter((x): x is { session: Session; attention: Attention } => x.attention !== undefined)
      .sort(
        (a, b) =>
          ATTENTION_PRIORITY[a.attention.kind] - ATTENTION_PRIORITY[b.attention.kind] || a.attention.since - b.attention.since,
      );
  }

  private attentionFn(now: number, override?: AttentionOverride): (s: Session) => Attention | undefined {
    const mayNeedYouMs = this.options.mayNeedYouMs();
    return (s) => override?.(s) ?? attentionOf(s, now, mayNeedYouMs);
  }

  private create(id: string, meta: HookMeta, now: number): Session {
    const s: Session = {
      id,
      cwd: "",
      workspace: "",
      surface: meta.surface,
      origin: { bundle: "", term: "", termSession: "", tmuxPane: "", tty: "" },
      state: "idle",
      firstSeen: now,
      lastEvent: now,
      activeAt: now,
      pending: [],
      compacting: false,
      counts: { prompts: 0, tools: 0, turns: 0 },
      acknowledged: false,
    };
    this.sessions.set(id, s);
    return s;
  }

  private updateOrigin(s: Session, meta: HookMeta, cwd: string): void {
    if (cwd) {
      s.cwd = cwd;
      s.workspace = basename(cwd) || cwd;
    }
    s.surface = meta.surface;
    const o = s.origin;
    o.bundle = meta.bundle || o.bundle;
    o.term = meta.term || o.term;
    o.termSession = meta.termSession || o.termSession;
    o.tmuxPane = meta.tmuxPane || o.tmuxPane;
    o.tty = meta.tty || o.tty;
    o.pid = meta.pid ?? o.pid;
  }

  private removePending(s: Session, toolName: string, input: unknown): ToolCall | undefined {
    const key = toolKey(toolName, input);
    let i = s.pending.findIndex((t) => t.key === key);
    if (i < 0) i = s.pending.findIndex((t) => t.name === toolName);
    return i >= 0 ? s.pending.splice(i, 1)[0] : undefined;
  }

  /** Tool events mean the turn is running, even if we missed its start. */
  private resume(s: Session, now: number): void {
    if (s.state !== "working") {
      s.state = "working";
      s.turnStartedAt ??= now;
      s.activeAt = s.turnStartedAt; // a stale turn resuming keeps its place
      s.acknowledged = false;
    }
  }
}
