// The bridge: receives hook events from kd-hook, keeps session state, holds gated tool calls
// until a key decides, and offers the queries and commands the Stream Deck actions need.
// No Stream Deck dependency.

import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { ApprovalQueue, type Approval, type Decision } from "./approvals";
import { askInput, companionCategory, parsePostedAsk } from "./companion";
import { Companions, parseCompanionInfo, type CompanionConfigResult, type ConfigId } from "./companions";
import { ConfigStore, type Config } from "./config";
import { DeckHost, shortModelName, type Choice, type DeckAnswer, type DeckAsk, type DeckInit, type DeckView, type SessionSettingsView } from "./deck";
import { planFocus } from "./focus";
import { IdeSettings } from "./ide-settings";
import { Ledger } from "./ledger";
import type { Logger } from "./logger";
import { Notifier } from "./notify";
import { Pusher, type Fetch } from "./push";
import { renderReport, ReportBuilder } from "./report";
import { listen, type BridgeServer, type HookRequest, type Reply } from "./server";
import { attentionOf, SessionRegistry, type Attention, type HookEvent, type HookMeta, type Session, type ToolCall } from "./sessions";
import { findExecutables, isAlive, runCommand, toolEnv, type Executables, type Runner } from "./system";
import { ledgerFile, localDate, Today } from "./today";
import { describe, GATE_CATEGORIES, gateCategory, isGateCategory, summarize, type GateCategory } from "./tools";
import { parseUsage, UsageClient, UsageMonitor, type UsageSnapshot, type UsageTiming } from "./usage";

export interface BridgePaths {
  base: string;
  socket: string;
  config: string;
  data: string;
  lockdown: string;
  gated: string;
}

export function bridgePaths(base = process.env.KI_DECK_HOME || join(homedir(), ".ki-deck")): BridgePaths {
  return {
    base,
    socket: join(base, "run", "bridge.sock"),
    config: join(base, "config.json"),
    data: join(base, "data"),
    lockdown: join(base, "lockdown"),
    gated: join(base, "gated"),
  };
}

export interface BridgeOptions {
  logger: Logger;
  version: string;
  paths?: BridgePaths;
  now?: () => number;
  run?: Runner;
  bins?: Executables;
  isAlive?: (pid: number) => boolean;
  tickMs?: number;
  /** Replaces the kiro-cli call, for tests. */
  fetchUsage?: () => Promise<UsageSnapshot>;
  /** Replaces `kiro-cli acp --agent-engine=v3` for deck sessions, for tests. */
  deckAgent?: { command: string; args: string[] };
  /** Replaces ~/.kiro/sessions, for tests of IDE session metadata. */
  kiroSessionsDir?: string;
  /** Replaces the network call of push notifications, for tests. */
  fetch?: Fetch;
}

/** The activity report covers this many days unless asked otherwise (1 to 366). */
const REPORT_DAYS = 30;

const KIRO_BUNDLE = "dev.kiro.desktop";
/** kd-hook waits 590 s for an answer; answer a little earlier so the reply always arrives. */
const MAX_GATE_WAIT_MS = 585_000;
/**
 * A native Kiro prompt has no agent-side timeout: Kiro's own dialog waits for the user. This
 * is only a backstop so a forgotten prompt eventually leaves the deck; the companion aborts the
 * request as soon as Kiro reports the ask resolved, which is the normal way it ends.
 */
const COMPANION_ASK_TIMEOUT_MS = 30 * 60_000;
/** Time-based state (may need you, stale, lockdown set from the CLI) is checked this often. */
const TICK_MS = 1000;
/** Credits for a turn's last request are billed right after it; read them this much later. */
const TURN_END_USAGE_DELAY_MS = 3000;
/** An unavailable/old companion is retried slowly; pressing the Session key retries at once. */
const IDE_PROBE_RETRY_MS = 30_000;

export const LOCKDOWN_REASON =
  "Blocked by Stream Deck lockdown. Stop, tell the user, and do not retry until they lift it.";
const DENY_REASON = "The user denied this on Stream Deck. Do not retry the same call; ask the user or try another approach.";
const DECIDE_IN_KIRO_REASON = "The user chose to decide in Kiro.";
const GATE_OFF_REASON = "The Stream Deck gate for this was turned off. Decide in Kiro.";
/** Longest prompt a deck session accepts from the CLI or a key. */
const MAX_PROMPT_CHARS = 100_000;

export interface DecideOptions {
  /** Index into config denyReasons, for deny keys with a preset reason. */
  reasonIndex?: number;
  by: string;
}

/** What a hold on a Session key did. `busy` and `gone` changed nothing. */
export type ClearResult = "acknowledged" | "dismissed" | "busy" | "gone";

/** Origin of a session first seen through the companion: an IDE window, process unknown. */
const COMPANION_ORIGIN: HookMeta = { surface: "ide", bundle: KIRO_BUNDLE, term: "", termSession: "", tmuxPane: "", tty: "" };

export class Bridge extends EventEmitter<{ changed: [] }> {
  readonly registry: SessionRegistry;
  readonly approvals: ApprovalQueue;
  readonly usage: UsageMonitor;
  readonly today: Today;
  readonly deck: DeckHost;
  readonly ideSettings: IdeSettings;
  /** Companion extensions with their command stream open, one per Kiro window. */
  readonly companions = new Companions();
  /**
   * The plugin's connection to Stream Deck is up. The socket opens earlier, and a deep link sent
   * before this is dropped by Stream Deck, so `ki-deck profiles` waits for it.
   */
  streamDeckConnected = false;
  private usageClient?: UsageClient;
  readonly paths: BridgePaths;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly run: Runner;
  private readonly bins: Executables;
  private readonly config: ConfigStore;
  private readonly ledger: Ledger;
  private readonly notifier: Notifier;
  readonly pusher: Pusher;
  private server?: BridgeServer;
  private timer?: NodeJS.Timeout;
  private emitQueued = false;
  private attentionKey = "";
  private lockdownCached = false;
  private gatedCached = new Set<GateCategory>();
  private readonly mayNeedYouNotified = new Set<string>();
  private selectedSettingsSession?: string;
  private ideRefresh?: Promise<void>;
  private readonly ideProbes = new Set<string>();
  private readonly ideProbePending = new Set<string>();
  private readonly ideProbeRetryAt = new Map<string, number>();
  private readonly settingWrites = new Map<string, Promise<SessionSettingsView>>();

  constructor(private readonly options: BridgeOptions) {
    super();
    this.log = options.logger;
    this.paths = options.paths ?? bridgePaths();
    this.now = options.now ?? Date.now;
    this.run = options.run ?? runCommand;
    this.bins = options.bins ?? findExecutables();
    this.config = new ConfigStore(this.paths.config, this.log);
    this.today = new Today(this.paths.data, this.now);
    this.ledger = new Ledger(this.paths.data, this.log, (entry, at) => this.today.add(entry, at));
    this.pusher = new Pusher({
      config: () => ({ push: this.settings.notifications.push, quietHours: this.settings.notifications.quietHours }),
      run: this.run,
      log: this.log,
      now: () => new Date(this.now()),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.notifier = new Notifier(() => this.settings, this.bins, this.run, () => new Date(this.now()), this.pusher);
    this.ideSettings = new IdeSettings(options.kiroSessionsDir ?? join(homedir(), ".kiro", "sessions"));
    this.registry = new SessionRegistry({
      mayNeedYouMs: () => this.settings.attention.mayNeedYouSeconds * 1000,
      staleMs: () => this.settings.staleAfterMinutes * 60_000,
      idleExpiryMs: () => this.settings.idleExpiryHours * 3_600_000,
      isAlive: options.isAlive ?? isAlive,
      onRemove: (s, reason) => {
        this.mayNeedYouNotified.delete(s.id);
        this.ideProbes.delete(s.id);
        this.ideProbePending.delete(s.id);
        this.ideProbeRetryAt.delete(s.id);
        this.companions.forgetSession(s.id);
        if (this.selectedSettingsSession === s.id) this.selectedSettingsSession = undefined;
        this.log.info(`session ${s.id} (${s.surface}, ${s.workspace || "no workspace"}) removed: ${reason}`);
        // A deck session that leaves the deck (held, idle too long) is closed in kiro-cli too.
        if (reason !== "session-end" && this.deck.owns(s.id)) {
          this.deck.close(s.id).catch((err: Error) => this.log.warn(`deck: closing ${s.id} failed: ${err.message}`));
        }
      },
      onToolDone: (s, call, now) => this.onToolDone(s, call, now),
    });
    this.approvals = new ApprovalQueue((approval, decision) => this.onApprovalChange(approval, decision));
    this.usage = new UsageMonitor(
      options.fetchUsage ?? (() => this.fetchAccountUsage()),
      () => this.usageTiming(),
      () => this.registry.all().some((s) => s.state === "working"),
      this.now,
      () => this.changed(),
      this.log,
    );
    this.deck = new DeckHost({
      command: () => options.deckAgent?.command ?? this.bins.kiroCli,
      ...(options.deckAgent ? { args: options.deckAgent.args } : {}),
      env: toolEnv(),
      dir: join(this.paths.base, "deck"),
      now: this.now,
      log: this.log,
      events: {
        event: (event, meta, extra) => this.observe(event, meta, extra?.credits),
        permission: (ask, signal) => this.onDeckAsk(ask, signal),
        changed: () => this.changed(),
      },
    });
  }

  /** Credits refresh intervals from config.json, with floors so a typo cannot hammer kiro-cli. */
  usageTiming(): UsageTiming {
    const { activeSeconds, refreshMinutes } = this.settings.usage;
    return { activeMs: Math.max(activeSeconds, 5) * 1000, idleMs: Math.max(refreshMinutes, 1) * 60_000 };
  }

  private fetchAccountUsage(): Promise<UsageSnapshot> {
    // While deck sessions run, their kiro-cli answers too: no second 300 MB process.
    const viaDeck = this.deck.request("_kiro/account/getUsage", {}, 30_000);
    if (viaDeck) return viaDeck.then(parseUsage);
    if (!this.bins.kiroCli) return Promise.reject(new Error("kiro-cli not found; usage needs it"));
    this.usageClient ??= new UsageClient({ command: this.bins.kiroCli, env: toolEnv() });
    return this.usageClient.fetch();
  }

  get settings(): Config {
    return this.config.value;
  }

  async start(): Promise<void> {
    this.config.load();
    this.config.watch();
    this.lockdownCached = existsSync(this.paths.lockdown);
    this.gatedCached = this.readGated();
    this.log.info(`executables: ${JSON.stringify(this.bins)}`);
    // Before the socket opens, so no event is counted both from the file and live.
    await this.today.load().catch((err: Error) => this.log.warn(`today: cannot read the ledger: ${err.message}`));
    this.server = await listen(
      this.paths.socket,
      {
        hook: (r) => this.onHook(r),
        companionAsk: (ask, signal) => this.onCompanionAsk(ask, signal),
        companionConnect: (hello, write) => this.onCompanionConnect(hello, write),
        companionContext: (body) => this.onCompanionContext(body),
        companionConfigResult: (body) => this.onCompanionConfigResult(body),
        report: async (body) => {
          try {
            const days = typeof body.days === "number" ? body.days : undefined;
            const file = await this.openReport({ ...(days !== undefined ? { days } : {}), open: body.open !== false });
            return { status: 200, body: JSON.stringify({ ok: true, message: file, path: file }) };
          } catch (err) {
            return { status: 500, body: JSON.stringify({ ok: false, message: err instanceof Error ? err.message : String(err) }) };
          }
        },
        pushTest: async () => {
          const result = await this.pusher.test();
          return { status: result.ok ? 200 : 409, body: JSON.stringify(result) };
        },
        health: () => this.health(),
        sessions: () => this.snapshot(),
        deck: (command, body) => this.onDeckCommand(command, body),
      },
      this.log,
    );
    this.timer = setInterval(() => this.tick(), this.options.tickMs ?? TICK_MS);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.usage.stop();
    this.usageClient?.close();
    this.deck.stop();
    this.config.unwatch();
    // Kiro shows its own prompt for anything still waiting.
    this.approvals.settleAll({ kind: "ask", reason: "Stream Deck closed. Decide in Kiro.", by: "shutdown" });
    this.pusher.stop();
    await this.server?.close();
  }

  // ---- Queries -------------------------------------------------------------------------

  /** The session shown on the n-th session key. */
  sessionAt(slot: number): Session | undefined {
    return this.registry.ordered(this.now(), (s) => this.approvalAttention(s))[slot];
  }

  attention(s: Session): Attention | undefined {
    return this.approvalAttention(s) ?? attentionOf(s, this.now(), this.settings.attention.mayNeedYouSeconds * 1000);
  }

  inbox(): Array<{ session: Session; attention: Attention }> {
    return this.registry.inbox(this.now(), (s) => this.approvalAttention(s));
  }

  /** The approval the Allow and Deny keys act on: the oldest one waiting. */
  targetApproval(): Approval | undefined {
    return this.approvals.pending()[0];
  }

  get lockdown(): boolean {
    return this.lockdownCached;
  }

  /** Whether approvals in this category wait for the deck (the `gated` file kd-hook reads). */
  isGated(category: GateCategory): boolean {
    return this.gatedCached.has(category);
  }

  // ---- Commands ------------------------------------------------------------------------

  /** Answers a pending approval. False when it was already answered or has gone. */
  decide(id: string, kind: Decision["kind"], options: DecideOptions): boolean {
    const approval = this.approvals.get(id);
    if (!approval) return false;
    if (kind === "deny") {
      const preset = options.reasonIndex !== undefined ? this.settings.denyReasons[options.reasonIndex] : undefined;
      const reason = preset ? `The user denied this on Stream Deck: ${preset}` : DENY_REASON;
      return this.approvals.settle(id, { kind, reason, by: options.by });
    }
    if (kind === "ask") {
      if (approval.source === "deck") return false; // a deck session has no Kiro prompt to hand it to
      const settled = this.approvals.settle(id, { kind, reason: DECIDE_IN_KIRO_REASON, by: options.by });
      if (settled) void this.focus(approval.sessionId);
      return settled;
    }
    return this.approvals.settle(id, { kind, by: options.by });
  }

  /** Turns lockdown on or off. Turning it on also denies everything waiting. */
  async setLockdown(on: boolean): Promise<void> {
    if (on) {
      await writeFile(this.paths.lockdown, "");
      await chmod(this.paths.lockdown, 0o600);
      const denied = this.approvals.settleAll({ kind: "deny", reason: LOCKDOWN_REASON, by: "lockdown" });
      const stopped = this.deck.cancelAll();
      this.log.info(`lockdown on${denied ? `, denied ${denied} waiting call(s)` : ""}${stopped ? `, stopped ${stopped} deck turn(s)` : ""}`);
    } else {
      await rm(this.paths.lockdown, { force: true });
      this.log.info("lockdown off");
    }
    this.lockdownCached = on;
    this.changed();
  }

  /**
   * Turns a gate on or off by rewriting the `gated` file, as `ki-deck gate` does.
   * Calls of that category still waiting when it goes off are handed to Kiro's own prompt.
   */
  async setGate(category: GateCategory, on: boolean): Promise<void> {
    const next = new Set(this.gatedCached);
    if (on) next.add(category);
    else next.delete(category);
    const tmp = `${this.paths.gated}.${process.pid}.tmp`;
    await writeFile(tmp, GATE_CATEGORIES.filter((c) => next.has(c)).map((c) => `${c}\n`).join(""), { mode: 0o600 });
    await rename(tmp, this.paths.gated);
    this.applyGated(next);
  }

  /**
   * Brings the session's window forward and marks a finished turn as seen. In Kiro, the
   * companion of that window then shows the chat itself, or the integrated terminal kiro-cli
   * runs in. A deck session has no window: it becomes the target of the deck keys, and its
   * transcript opens.
   */
  async focus(id: string): Promise<boolean> {
    const s = this.registry.get(id);
    if (!s) return false;
    if (s.surface !== "cli") this.selectedSettingsSession = id;
    const deck = s.surface === "deck" ? this.deck.get(id) : undefined;
    if (deck) this.deck.select(id);
    if (s.surface === "ide") {
      this.ideProbeRetryAt.delete(s.id);
      void this.refreshIdeSettings().then(() => this.probeIdeSettings(s));
    }
    this.changed();
    const raised = await this.raiseWindow(s, deck?.transcript);
    const shown = this.showInWindow(s);
    if (!raised && !shown) return false;
    this.acknowledge(id);
    return true;
  }

  /** Runs the focus plan (src/bridge/focus.ts): each way is tried until one fully succeeds. */
  private async raiseWindow(s: Session, transcript: string | undefined): Promise<boolean> {
    const ideRoots = [...this.registry.all().filter((x) => x.surface === "ide" && x.cwd).map((x) => x.cwd), ...this.companions.list().flatMap((c) => c.folders)];
    for (const attempt of planFocus(s, ideRoots, this.bins, transcript)) {
      let ok = true;
      for (const step of attempt) {
        const result = await this.run(step.cmd, step.args);
        if (!result.ok) {
          this.log.debug(`focus step failed: ${step.cmd} ${result.stderr.trim()}`);
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }

  /** Asks the companion of the session's Kiro window to show the chat, or the terminal kiro-cli runs in. */
  private showInWindow(s: Session): boolean {
    if (s.surface === "ide") return this.companions.send(s.id, s.cwd, { kind: "focus", sessionId: s.id });
    const tty = s.origin.tty;
    if (s.surface === "cli" && s.origin.bundle === KIRO_BUNDLE && /^ttys?\d{1,4}$/.test(tty)) {
      return this.companions.send(s.id, s.cwd, { kind: "terminal", tty });
    }
    return false;
  }

  acknowledge(id: string): void {
    if (this.registry.acknowledge(id)) this.changed();
  }

  /**
   * Writes the activity report of the last `days` days (src/bridge/report.ts) to
   * ~/.ki-deck/reports/kiro-report-<date>.html and opens it in the default browser.
   * Returns the file. Rejects when the file cannot be written or opened.
   */
  async openReport(options: { days?: number; open?: boolean } = {}): Promise<string> {
    const span = Math.max(1, Math.min(366, Math.floor(options.days ?? REPORT_DAYS)));
    const now = new Date(this.now());
    // One day's file at a time: memory stays flat, and hook events are handled between files.
    const builder = new ReportBuilder();
    for (let i = span - 1; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const text = await readFile(ledgerFile(this.paths.data, date), "utf8").catch(() => "");
      builder.add({ date: localDate(date), text });
    }
    const credits = this.usage.state.snapshot;
    const html = renderReport({
      stats: builder.result(),
      now,
      presentation: this.settings.presentationMode,
      version: this.options.version,
      ...(credits
        ? { credits: { plan: credits.plan, used: credits.credits?.used, limit: credits.credits?.limit, percent: credits.credits?.percent, resetDate: credits.resetDate } }
        : {}),
    });
    const dir = join(this.paths.base, "reports");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `kiro-report-${localDate(now)}.html`);
    await writeFile(file, html, { mode: 0o600 });
    if (options.open !== false) {
      const opened = await this.run("/usr/bin/open", [file]);
      if (!opened.ok) throw new Error(`could not open ${file}: ${opened.stderr.trim()}`);
    }
    this.log.info(`report: ${span} days written to ${file}`);
    return file;
  }

  /**
   * Hold on a Session key. Marks a finished turn or an ungated alert as seen; with nothing left
   * to mark, removes the session from the deck (its next hook event brings it back). A working
   * session, or one with a call waiting on the deck, stays: it would come straight back, or its
   * approval would lose its key.
   */
  clear(id: string): ClearResult {
    const s = this.registry.get(id);
    if (!s) return "gone";
    if (this.registry.acknowledge(id)) {
      this.changed();
      return "acknowledged";
    }
    if (s.state === "working" || this.approvals.forSession(id).length > 0) return "busy";
    this.registry.dismiss(id);
    this.changed();
    return "dismissed";
  }

  acknowledgeAll(): void {
    let any = false;
    for (const { session } of this.inbox()) any = this.registry.acknowledge(session.id) || any;
    if (any) this.changed();
  }

  /**
   * Stream Deck reports that Kiro quit. Only sessions whose agent process is gone are dropped,
   * so a report that arrives while Kiro still runs cannot clear live sessions.
   */
  applicationTerminated(application: string): void {
    if (application !== KIRO_BUNDLE && !/\bKiro(\.app)?$/.test(application)) return;
    this.log.info(`Stream Deck reports that ${application} quit`);
    const fromKiro = (s: Session) => s.surface === "ide" || s.origin.bundle === KIRO_BUNDLE;
    if (this.registry.removeWhere((s) => fromKiro(s) && !this.registry.harnessAlive(s), "app-quit")) this.changed();
  }

  // ---- Hook handling -------------------------------------------------------------------

  private onHook(request: HookRequest): Reply | Promise<Reply> {
    if (request.mode === "gate") return this.onGate(request);
    this.observe(request.event, request.meta);
    return { status: 204 };
  }

  /** One lifecycle event, from a hook or from a deck session (`credits`: what its turn used). */
  private observe(hookEvent: HookEvent, meta: HookMeta, credits?: number): void {
    const now = this.now();
    const event = typeof hookEvent.hook_event_name === "string" ? hookEvent.hook_event_name : "";
    const s = this.registry.ingest(hookEvent, meta, now);
    if (s) {
      // A covered tool with its gate on (or lockdown on) must send a gate request before it runs.
      // Deck sessions run no hooks; the deck answers their permission requests itself.
      if (event === "PreToolUse" && s.lastTool && s.surface !== "deck") {
        const gate = gateCategory(s.lastTool.name);
        s.lastTool.expectGate = gate !== undefined && (this.lockdown || this.gatedCached.has(gate));
      }
      void this.ledger.record(event, s, this.settings.ledger.storeRaw, new Date(now), credits);
      // A finished turn spent credits: read them right after (the monitor never overlaps fetches).
      if (event === "Stop") this.usage.nudge(TURN_END_USAGE_DELAY_MS);
      if (event === "UserPromptSubmit") this.mayNeedYouNotified.delete(s.id);
      const minTurnMs = this.settings.notifications.minTurnSeconds * 1000;
      if (event === "Stop" && s.lastTurnMs !== undefined && s.lastTurnMs >= minTurnMs) {
        void this.notifier.turnFinished(s, s.lastTurnMs);
      }
    }
    this.changed();
  }

  /** Holds a gated tool call until a key, a timeout or a disconnect decides it. */
  private async onGate(request: HookRequest): Promise<Reply> {
    const now = this.now();
    const sessionId = typeof request.event.session_id === "string" ? request.event.session_id : "";
    // kd-hook's observer normally reported this PreToolUse a moment ago; if it was lost, use this one.
    const s = (sessionId && this.registry.get(sessionId)) || this.registry.ingest(request.event, request.meta, now);
    if (!s) return askReply("Stream Deck could not identify the session. Decide in Kiro.");
    const toolName = typeof request.event.tool_name === "string" ? request.event.tool_name : "tool";
    this.registry.markGated(s.id, toolName, request.event.tool_input);
    if (this.lockdown) return { status: 403, body: LOCKDOWN_REASON };

    const gate = this.settings.gate;
    const { decision } = this.approvals.request(
      {
        sessionId: s.id,
        workspace: s.workspace,
        category: request.category || "tool",
        toolName,
        summary: summarize(toolName, request.event.tool_input),
        detail: describe(toolName, request.event.tool_input),
        createdAt: now,
      },
      {
        timeoutMs: Math.min(Math.max(gate.timeoutSeconds, 1) * 1000, MAX_GATE_WAIT_MS),
        onTimeout: () =>
          gate.onTimeout === "deny"
            ? { kind: "deny", reason: "Nobody answered on Stream Deck in time, so this was denied.", by: "timeout" }
            : { kind: "ask", reason: "Nobody answered on Stream Deck in time. Decide in Kiro.", by: "timeout" },
        signal: request.signal,
      },
    );
    const outcome = await decision;
    if (outcome.kind === "allow") return { status: 200 };
    if (outcome.kind === "deny") {
      this.registry.toolDenied(s.id, toolName, request.event.tool_input);
      this.changed();
      return { status: 403, body: outcome.reason ?? DENY_REASON };
    }
    return askReply(outcome.reason ?? DECIDE_IN_KIRO_REASON);
  }

  /** A companion opened its command stream (one per Kiro window). */
  private onCompanionConnect(hello: unknown, write: (line: string) => void): (() => void) | undefined {
    const info = parseCompanionInfo(hello);
    if (!info) return undefined;
    this.log.info(`companion ${info.version || "?"} connected (pid ${info.pid}, ${info.folders.length} folder(s))`);
    const remove = this.companions.add(info, write);
    this.changed();
    return () => {
      const lostSessions = this.companions.sessionsFor(info.pid);
      remove();
      for (const sessionId of lostSessions) {
        this.ideSettings.clearConfigOptions(sessionId);
        this.ideProbes.delete(sessionId);
        this.ideProbeRetryAt.delete(sessionId);
      }
      this.changed();
      this.log.info(`companion pid ${info.pid} disconnected`);
    };
  }

  /** How full an IDE chat's context window is: 204 when taken, 404 for a session not on the deck. */
  private onCompanionContext(body: unknown): Reply {
    const b = body as { pid?: unknown; sessionId?: unknown; percent?: unknown };
    if (typeof b.sessionId !== "string" || typeof b.percent !== "number") return { status: 400, body: "expected sessionId and percent" };
    if (!this.registry.get(b.sessionId)) return { status: 404, body: "unknown session" };
    if (typeof b.pid === "number") {
      const ownerChanged = this.companions.claim(b.pid, b.sessionId);
      if (ownerChanged) {
        this.ideSettings.clearConfigOptions(b.sessionId);
        this.ideProbes.delete(b.sessionId);
        this.ideProbeRetryAt.delete(b.sessionId);
        this.changed();
      }
      if (this.selectedSettingsSession === b.sessionId) {
        this.ideProbeRetryAt.delete(b.sessionId);
        void this.probeIdeSettings(this.registry.get(b.sessionId)!);
      }
    }
    if (this.registry.setContext(b.sessionId, b.percent)) this.changed();
    return { status: 204 };
  }

  /** Completes a live IDE setting request sent through one companion window. */
  private onCompanionConfigResult(body: unknown): Reply {
    const value = body as { pid?: unknown; requestId?: unknown; ok?: unknown; configOptions?: unknown; error?: unknown };
    if (
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      typeof value.requestId !== "string" ||
      !/^config-[0-9a-f-]{36}$/.test(value.requestId) ||
      typeof value.ok !== "boolean"
    ) {
      return { status: 400, body: "expected pid, requestId and ok" };
    }
    const result: CompanionConfigResult = {
      ok: value.ok,
      ...(Array.isArray(value.configOptions) ? { configOptions: value.configOptions } : {}),
      ...(typeof value.error === "string" ? { error: value.error.slice(0, 500) } : {}),
    };
    return this.companions.settleConfig(value.pid, value.requestId, result) ? { status: 204 } : { status: 404, body: "unknown setting request" };
  }

  /**
   * A native Kiro prompt the companion extension observed in an IDE window. It joins the same
   * approval queue the gate uses, so Allow, Deny and Decide in Kiro act on it. The reply tells
   * the companion how to answer Kiro's hub (`allow` / `deny` + reason), or `ask` to leave the
   * call to Kiro's own dialog. The request is held open until a key decides, the backstop
   * timeout passes, or the companion disconnects because Kiro resolved the ask.
   */
  private async onCompanionAsk(raw: unknown, signal: AbortSignal): Promise<Reply> {
    const ask = parsePostedAsk(raw);
    if (!ask) return { status: 400, body: "unusable ask" };
    if (this.lockdown) {
      this.log.info(`companion ask ${ask.toolCallId} (${ask.sessionId}) denied by lockdown`);
      return companionReply({ kind: "deny", reason: LOCKDOWN_REASON, by: "lockdown" });
    }
    const now = this.now();
    const toolName = ask.toolId ?? "tool";
    const input = askInput(ask);
    // Kiro's hub uses the same session IDs as the hooks. A session the hooks never reported
    // still gets a Session key and an Inbox entry while its prompt waits.
    const session = this.registry.touch(ask.sessionId, COMPANION_ORIGIN, ask.workspaceRoot ?? "", now);
    const { decision } = this.approvals.request(
      {
        sessionId: ask.sessionId,
        workspace: session.workspace || (ask.workspaceRoot ? basename(ask.workspaceRoot) : ""),
        category: companionCategory(ask),
        toolName,
        summary: summarize(toolName, input),
        detail: describe(toolName, input),
        createdAt: now,
        source: "companion",
      },
      {
        timeoutMs: COMPANION_ASK_TIMEOUT_MS,
        onTimeout: () => ({ kind: "ask", reason: "Nobody answered on Stream Deck. Decide in Kiro.", by: "timeout" }),
        signal,
      },
    );
    return companionReply(await decision);
  }

  /**
   * A deck session asks permission (Supervised, or a call Kiro's rules ask about). It joins the
   * same queue; Allow and Deny answer it. With no Kiro dialog behind it, anything else (timeout,
   * the turn ending) answers "cancelled", which runs nothing.
   */
  private async onDeckAsk(ask: DeckAsk, signal: AbortSignal): Promise<DeckAnswer> {
    if (this.lockdown) return { kind: "deny", reason: LOCKDOWN_REASON };
    const toolName = ask.toolId ?? (ask.review ? "review" : "tool");
    const input = askInput(ask);
    const session = this.registry.get(ask.sessionId);
    const { decision } = this.approvals.request(
      {
        sessionId: ask.sessionId,
        workspace: session?.workspace ?? (ask.cwd ? basename(ask.cwd) : ""),
        category: ask.review ? "review" : companionCategory(ask),
        toolName,
        summary: ask.review ? "keep the changes" : summarize(toolName, input),
        detail: ask.review ? "Keep (Allow) or undo (Deny) the file changes of this turn" : describe(toolName, input),
        createdAt: this.now(),
        source: "deck",
      },
      {
        timeoutMs: COMPANION_ASK_TIMEOUT_MS,
        onTimeout: () => ({ kind: "ask", reason: "Nobody answered on Stream Deck.", by: "timeout" }),
        signal,
      },
    );
    const outcome = await decision;
    if (outcome.kind === "allow") return { kind: "allow" };
    if (outcome.kind === "deny") return { kind: "deny", ...(outcome.reason ? { reason: outcome.reason } : {}) };
    return { kind: "cancel" };
  }

  // ---- Session settings ----------------------------------------------------------------

  /** Settings shown by Model, Effort and Autonomy for the last pressed Session key. */
  settingsTarget(): SessionSettingsView | undefined {
    if (!this.selectedSettingsSession) return this.deck.target();
    return this.settingsView(this.selectedSettingsSession);
  }

  /** Models for setting keys: configured order when present, otherwise Kiro's advertised order. */
  settingsModels(): Choice[] {
    return this.settingModelsFor(this.settingsTarget());
  }

  settingsSet(setting: ConfigId, value: string, id?: string): Promise<SessionSettingsView> {
    const target = id ? this.settingsView(id) : this.settingsTarget();
    if (!target) return Promise.reject(new DeckRefusal("no selected session"));
    return this.enqueueSettingWrite(target.id, () => this.applySetting(target.id, setting, value));
  }

  settingsCycle(setting: "model" | "effortLevel", id?: string): Promise<SessionSettingsView> {
    const target = id ? this.settingsView(id) : this.settingsTarget();
    if (!target) return Promise.reject(new DeckRefusal("no selected session"));
    return this.enqueueSettingWrite(target.id, async () => {
      const currentTarget = this.settingsView(target.id);
      if (!currentTarget) throw new DeckRefusal("the selected session ended");
      const choices = setting === "model" ? this.settingModelsFor(currentTarget).map((choice) => choice.value) : currentTarget.effortLevels;
      const current = setting === "model" ? currentTarget.model?.value : currentTarget.effort;
      if (!current || choices.length === 0) throw new DeckRefusal(`this session has no ${setting} to change`);
      const next = choices[(choices.indexOf(current) + 1) % choices.length]!;
      return this.applySetting(currentTarget.id, setting, next);
    });
  }

  private async applySetting(id: string, setting: ConfigId, value: string): Promise<SessionSettingsView> {
    const target = this.settingsView(id);
    if (!target) throw new DeckRefusal("the selected session ended");
    if (this.deck.owns(target.id)) return this.deck.set(target.id, setting, value);
    const session = this.registry.get(target.id);
    if (!session || session.surface !== "ide") throw new DeckRefusal("this session's settings are read only");
    if (!target.writableSettings.includes(setting) || !this.companions.claims(session.id)) throw new DeckRefusal("this IDE setting is read only");
    const offered =
      setting === "model" ? target.models.map((choice) => choice.value) : setting === "effortLevel" ? target.effortLevels : target.autopilotValues;
    if (!offered.includes(value)) throw new DeckRefusal(`${value} is not a ${setting} Kiro offers (${offered.join(", ")})`);

    const result = await this.companions.requestConfig(session.id, setting, value);
    if (this.registry.get(session.id) !== session || !this.companions.claims(session.id)) throw new DeckRefusal("the selected session ended");
    if (!this.ideSettings.applyConfigOptions(session.id, result.configOptions)) this.ideSettings.setCurrent(session.id, setting, value);
    this.changed();
    return this.ideSettings.view(session);
  }

  private enqueueSettingWrite(id: string, write: () => Promise<SessionSettingsView>): Promise<SessionSettingsView> {
    const ownerGeneration = this.companions.generation(id);
    const previous = this.settingWrites.get(id);
    const next = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => {
      const session = this.registry.get(id);
      if (session?.surface === "ide" && this.companions.generation(id) !== ownerGeneration) {
        throw new DeckRefusal("the selected session changed windows");
      }
      return write();
    });
    const tracked = next.finally(() => {
      if (this.settingWrites.get(id) === tracked) this.settingWrites.delete(id);
    });
    this.settingWrites.set(id, tracked);
    return tracked;
  }

  private settingModelsFor(target: SessionSettingsView | undefined): Choice[] {
    if (target?.metadataAvailable === false) return [];
    const offered = target?.models ?? [];
    const pinned = this.settings.deck.models.filter((model) => typeof model === "string" && model);
    if (pinned.length === 0) return offered;
    if (offered.length === 0) return pinned.map((value) => ({ value, name: value }));
    return pinned.flatMap((value) => offered.filter((choice) => choice.value === value));
  }

  private settingsView(id: string): SessionSettingsView | undefined {
    const deck = this.deck.get(id);
    if (deck) return deck;
    const session = this.registry.get(id);
    if (!session) return undefined;
    if (session.surface === "ide") {
      const view = this.ideSettings.view(session);
      return this.companions.claims(session.id) ? view : { ...view, writableSettings: [] };
    }
    return {
      id: session.id,
      cwd: session.cwd,
      workspace: session.workspace,
      working: session.state === "working",
      metadataAvailable: false,
      writableSettings: [],
      models: [],
      effortLevels: [],
      autopilotValues: [],
    };
  }

  /** A no-op model set proves this IDE hub supports live config and returns its choices. */
  private async probeIdeSettings(session: Session): Promise<void> {
    if (session.surface !== "ide" || this.selectedSettingsSession !== session.id || this.ideProbePending.has(session.id)) return;
    if ((this.ideProbeRetryAt.get(session.id) ?? 0) > this.now()) return;
    if (this.ideProbes.has(session.id) && this.ideSettings.view(session).writableSettings.length > 0) return;
    const model = this.ideSettings.metadata(session.id)?.modelId;
    if (!model || this.selectedSettingsSession !== session.id || !this.companions.claims(session.id)) return;
    this.ideProbes.delete(session.id);
    this.ideProbePending.add(session.id);
    try {
      const result = await this.companions.requestConfig(session.id, "model", model);
      if (this.registry.get(session.id) !== session || this.selectedSettingsSession !== session.id || !this.companions.claims(session.id)) return;
      if (!this.ideSettings.applyConfigOptions(session.id, result.configOptions)) {
        this.ideProbeRetryAt.set(session.id, this.now() + IDE_PROBE_RETRY_MS);
        return;
      }
      this.ideProbeRetryAt.delete(session.id);
      this.ideProbes.add(session.id);
      this.log.info(`IDE session ${session.id} settings are controllable through its companion`);
      this.changed();
    } catch (error) {
      if (this.registry.get(session.id) === session && this.selectedSettingsSession === session.id && this.companions.claims(session.id)) {
        this.ideProbeRetryAt.set(session.id, this.now() + IDE_PROBE_RETRY_MS);
        this.log.debug(`IDE session ${session.id} settings remain read only: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      this.ideProbePending.delete(session.id);
    }
  }

  private refreshIdeSettings(): Promise<void> {
    if (this.ideRefresh) return this.ideRefresh;
    this.ideRefresh = this.ideSettings
      .refresh(this.registry.all(), (session) => this.companions.rootFor(session.id, session.cwd))
      .then((changed) => {
        if (changed) this.changed();
        const selected = this.selectedSettingsSession ? this.registry.get(this.selectedSettingsSession) : undefined;
        if (selected) void this.probeIdeSettings(selected);
      })
      .finally(() => void (this.ideRefresh = undefined));
    return this.ideRefresh;
  }

  // ---- Deck sessions -------------------------------------------------------------------

  /** The deck session the Stop and Prompt keys, and `ki-deck deck`, act on. */
  deckTarget(): DeckView | undefined {
    return this.deck.target();
  }

  /** Models for the model keys: `deck.models` from config.json in that order, else Kiro's own list. */
  deckModels(): Choice[] {
    const offered = this.deck.models;
    const pinned = this.settings.deck.models.filter((m) => typeof m === "string" && m);
    if (pinned.length === 0) return offered;
    if (offered.length === 0) return pinned.map((value) => ({ value, name: value }));
    return pinned.flatMap((value) => offered.filter((c) => c.value === value));
  }

  /**
   * Budget guard: true once the credits used this cycle reach `budget.warnPercent`, so model
   * keys mark models that cost more than Auto. Needs a credits reading (a Usage key, a usage
   * dial or the Neo infobar keeps it fresh).
   */
  budgetLow(): boolean {
    const percent = this.usage.state.snapshot?.credits?.percent;
    const warn = this.settings.budget.warnPercent;
    return percent !== undefined && warn > 0 && percent >= warn;
  }

  /** Model name for keys and tiles: "Opus 5.5 · 2x". */
  deckModelLabel(choice: Choice | undefined): string {
    if (!choice) return "";
    const rate = choice.rate !== undefined ? ` · ${Number(choice.rate.toFixed(2))}x` : "";
    return `${shortModelName(choice.name)}${rate}`;
  }

  async deckStart(cwd: string, init: DeckInit = {}, prompt?: string): Promise<DeckView> {
    if (this.lockdown) throw new DeckRefusal("lockdown is on: no deck session starts until it is lifted");
    if (!isAbsolute(cwd) || !isDirectory(cwd)) throw new DeckRefusal(`not a folder: ${cwd || "(none)"}`);
    if (prompt !== undefined) checkPrompt(prompt);
    const view = await this.deck.start(cwd, { ...init, autopilot: init.autopilot ?? this.settings.deck.autopilot });
    if (prompt) await this.deck.prompt(view.id, prompt);
    return this.deck.get(view.id) ?? view;
  }

  /** A new turn when the session is idle, steering for its running turn otherwise. */
  async deckPrompt(text: string, id?: string): Promise<"started" | "steered"> {
    if (this.lockdown) throw new DeckRefusal("lockdown is on: deck sessions take no prompts until it is lifted");
    checkPrompt(text);
    return this.deck.prompt(this.deckId(id), text);
  }

  /** Stops the turn of the target (or given) deck session. False when none runs. */
  deckStop(id?: string): boolean {
    const target = this.deck.find(id);
    return target !== undefined && this.deck.cancel(target.id);
  }

  deckSet(setting: string, value: string, id?: string): Promise<DeckView> {
    return this.deck.set(this.deckId(id), setting, value);
  }

  /** Next value of a setting; models follow the model keys' order. */
  deckCycle(setting: string, id?: string): Promise<DeckView> {
    const values = setting === "model" ? this.deckModels().map((c) => c.value) : undefined;
    return this.deck.cycle(this.deckId(id), setting, values);
  }

  private deckId(id?: string): string {
    const target = this.deck.find(id);
    if (!target) throw new DeckRefusal(id ? `no deck session ${id}` : "no deck session; start one with: ki-deck deck start");
    return target.id;
  }

  /** `ki-deck deck ...` over the socket. Replies `{ ok, message, ... }` as JSON. */
  private async onDeckCommand(command: string, body: Record<string, unknown>): Promise<Reply> {
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    const session = text(body.session) || undefined;
    const done = (message: string, extra: object = {}): Reply => ({ status: 200, body: JSON.stringify({ ok: true, message, ...extra }) });
    const describeView = (v: DeckView) =>
      [
        `${v.id}  ${v.workspace}  ${v.working ? "working" : "idle"}`,
        `  model ${this.deckModelLabel(v.model) || "?"}${v.effort ? `, effort ${v.effort}` : ""}, ${v.autopilot === false ? "Supervised" : "Autopilot"}`,
        `  credits ${v.totalCredits.toFixed(2)}${v.contextPercent !== undefined ? `, context ${Math.round(v.contextPercent)}%` : ""}`,
        `  transcript ${v.transcript}`,
      ].join("\n");
    try {
      switch (command) {
        case "list": {
          const views = this.deck.list();
          const target = this.deck.target()?.id;
          const lines = views.map((v) => `${v.id === target ? "* " : "  "}${describeView(v).replace(/\n/g, "\n  ")}`);
          return done(views.length ? lines.join("\n") : "No deck sessions.", { sessions: views, target });
        }
        case "models": {
          const models = this.deckModels();
          const current = this.deck.find(session)?.model?.value;
          const lines = models.map((m) => `${m.value === current ? "* " : "  "}${m.value.padEnd(22)} ${this.deckModelLabel(m)}`);
          return done(models.length ? lines.join("\n") : "Kiro lists its models once a deck session has started.", { models });
        }
        case "start": {
          const autopilot = typeof body.autopilot === "boolean" ? body.autopilot : undefined;
          const init: DeckInit = {
            ...(text(body.model) ? { model: text(body.model) } : {}),
            ...(text(body.effort) ? { effort: text(body.effort) } : {}),
            ...(autopilot !== undefined ? { autopilot } : {}),
          };
          const view = await this.deckStart(text(body.cwd), init, text(body.prompt) || undefined);
          return done(`Started ${describeView(view)}`, { session: view });
        }
        case "say": {
          const result = await this.deckPrompt(text(body.text), session);
          return done(result === "started" ? "Sent." : "Sent as steering for the running turn.", { result });
        }
        case "stop":
          return done(this.deckStop(session) ? "Stopping the turn." : "Nothing is running.");
        case "set": {
          const view = await this.deckSet(text(body.setting), text(body.value), session);
          return done(describeView(view), { session: view });
        }
        case "close": {
          const id = this.deckId(session);
          await this.deck.close(id);
          return done(`Closed ${id}.`);
        }
        case "open": {
          const id = this.deckId(session);
          return (await this.focus(id)) ? done(`Opened the transcript of ${id}.`) : { status: 500, body: JSON.stringify({ ok: false, message: "could not open the transcript" }) };
        }
        default:
          return { status: 404, body: JSON.stringify({ ok: false, message: `unknown deck command: ${command}` }) };
      }
    } catch (err) {
      const status = err instanceof DeckRefusal ? 409 : 500;
      return { status, body: JSON.stringify({ ok: false, message: err instanceof Error ? err.message : String(err) }) };
    }
  }

  private onApprovalChange(approval: Approval, decision?: Decision): void {
    const s = this.registry.get(approval.sessionId);
    if (decision) {
      this.notifier.approvalSettled(approval);
      this.log.info(`approval ${approval.category} for ${approval.workspace}: ${decision.kind} (${decision.by})`);
      void this.ledger.decision(approval, decision, this.settings.ledger.storeRaw, new Date(this.now()));
    } else if (s) {
      void this.notifier.approvalWaiting(s, approval);
    }
    this.changed();
  }

  /**
   * UNGATED: a call whose gate was on finished without its gate request. Kiro ran it without
   * asking the deck, so the gate hook is not loaded (or does not cover the tool), and allow
   * rules written for gate mode would let such calls run with no prompt at all.
   */
  private onToolDone(s: Session, call: ToolCall, now: number): void {
    if (!call.expectGate || call.gated) return;
    this.log.warn(`UNGATED: ${call.name} (${call.category}) ran in session ${s.id} (${s.workspace}) without a gate request`);
    void this.ledger.ungated(s, call, this.settings.ledger.storeRaw, new Date(now));
    if (this.registry.flagUngated(s, call, now)) void this.notifier.ungated(s, call);
    this.changed();
  }

  private readGated(): Set<GateCategory> {
    try {
      return new Set(readFileSync(this.paths.gated, "utf8").split("\n").map((l) => l.trim()).filter(isGateCategory));
    } catch {
      return new Set(); // no file: nothing is gated
    }
  }

  private applyGated(next: Set<GateCategory>): void {
    const off = [...this.gatedCached].filter((c) => !next.has(c));
    const on = [...next].filter((c) => !this.gatedCached.has(c));
    if (off.length === 0 && on.length === 0) return;
    this.gatedCached = next;
    for (const category of off) {
      // Gates never front deck sessions, so their requests stay.
      for (const a of this.approvals.pending().filter((x) => x.category === category && x.source !== "deck")) {
        this.approvals.settle(a.id, { kind: "ask", reason: GATE_OFF_REASON, by: "gate-off" });
      }
    }
    this.log.info(`gates: ${[...next].join(", ") || "none"}`);
    this.changed();
  }

  private approvalAttention(s: Session): Attention | undefined {
    const waiting = this.approvals.forSession(s.id)[0];
    if (!waiting) return undefined;
    return { kind: "approval", since: waiting.createdAt, detail: `${waiting.category}: ${waiting.summary}`, category: waiting.category };
  }

  private tick(): void {
    void this.refreshIdeSettings();
    let changed = this.registry.tick(this.now());
    // A session known only from a native prompt leaves the deck with its last prompt.
    const promptEnded = (s: Session) => s.promptOnly === true && this.approvals.forSession(s.id).length === 0;
    if (this.registry.removeWhere(promptEnded, "prompt-ended")) changed = true;
    const lockdown = existsSync(this.paths.lockdown); // also follows `ki-deck lockdown`
    if (lockdown !== this.lockdownCached) {
      this.lockdownCached = lockdown;
      if (lockdown) {
        this.approvals.settleAll({ kind: "deny", reason: LOCKDOWN_REASON, by: "lockdown" });
        this.deck.cancelAll();
      }
      changed = true;
    }
    this.applyGated(this.readGated()); // also follows `ki-deck gate`
    const inbox = this.inbox();
    const key = inbox.map((i) => `${i.session.id}:${i.attention.kind}`).join(",");
    if (key !== this.attentionKey) {
      this.attentionKey = key;
      changed = true;
    }
    if (this.settings.notifications.mayNeedYou) {
      for (const { session, attention } of inbox) {
        if (attention.kind !== "may-need-you" || this.mayNeedYouNotified.has(session.id)) continue;
        this.mayNeedYouNotified.add(session.id);
        void this.notifier.mayNeedYou(session);
      }
    }
    if (changed) this.changed();
  }

  /** Coalesces bursts of hook events into one re-render. */
  private changed(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    setImmediate(() => {
      this.emitQueued = false;
      this.emit("changed");
    });
  }

  private health(): unknown {
    return {
      ok: true,
      version: this.options.version,
      pid: process.pid,
      streamDeck: this.streamDeckConnected,
      sessions: this.registry.all().length,
      approvals: this.approvals.pending().length,
      lockdown: this.lockdown,
      gated: [...this.gatedCached],
      usage: this.usage.state.snapshot?.credits?.percent,
      usageAt: this.usage.state.fetchedAt === undefined ? undefined : new Date(this.usage.state.fetchedAt).toISOString(),
      usageConnected: this.usageClient?.connected ?? false, // kiro-cli kept running between refreshes
      deckSessions: this.deck.size,
      deckConnected: this.deck.connected,
      // `host`, not `pid`: the CLI reads the bridge's own "pid" from this document.
      companions: this.companions.list().map((c) => ({ host: c.pid, version: c.version })),
      push: this.pusher.status(),
    };
  }

  /** Debug view for `curl --unix-socket ... /v1/sessions`. Tool summaries are left out. */
  private snapshot(): unknown {
    const iso = (t: number | undefined) => (t === undefined ? undefined : new Date(t).toISOString());
    return this.registry.all().map((s) => ({
      id: s.id,
      workspace: s.workspace,
      cwd: s.cwd,
      surface: s.surface,
      state: s.state,
      attention: this.attention(s)?.kind,
      ungated: s.ungated && { tool: s.ungated.tool, category: s.ungated.category, count: s.ungated.count, at: iso(s.ungated.at) },
      approvals: this.approvals.forSession(s.id).map((a) => ({ category: a.category, tool: a.toolName, since: iso(a.createdAt) })),
      origin: s.origin,
      pending: s.pending.map((t) => ({ name: t.name, category: t.category, since: iso(t.since) })),
      lastTool: s.lastTool && { name: s.lastTool.name, category: s.lastTool.category },
      counts: s.counts,
      contextPercent: s.contextPercent ?? this.deck.get(s.id)?.contextPercent,
      firstSeen: iso(s.firstSeen),
      lastEvent: iso(s.lastEvent),
    }));
  }
}

/** A deck request the bridge declines (lockdown, a bad folder, no such session): not a failure. */
export class DeckRefusal extends Error {
  override name = "DeckRefusal";
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function checkPrompt(text: string): void {
  if (!text.trim()) throw new DeckRefusal("the prompt is empty");
  if (text.length > MAX_PROMPT_CHARS) throw new DeckRefusal(`the prompt is longer than ${MAX_PROMPT_CHARS} characters`);
}

/** kd-hook prints a 200 body to stdout, so this hands the decision to Kiro's own prompt. */
function askReply(reason: string): Reply {
  return {
    status: 200,
    body: JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: reason } }),
  };
}

/**
 * The companion's answer: the decision kind, and the rejection reason for a deny (which the
 * agent sees). On `ask` the companion answers nothing and Kiro's own dialog stays open.
 */
function companionReply(decision: Decision): Reply {
  return {
    status: 200,
    body: JSON.stringify({ kind: decision.kind, ...(decision.reason ? { reason: decision.reason } : {}) }),
  };
}
