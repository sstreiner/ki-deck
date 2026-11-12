// Deck sessions: Kiro sessions the plugin starts and owns over `kiro-cli acp --agent-engine=v3`.
// The deck only watches IDE and CLI sessions through hooks; deck sessions it controls fully:
// model, effort, autopilot, prompts, steering, stop, and every permission request.
//
// kiro-cli 3.0.0 runs no global hooks for ACP sessions (tested), so this module is the only
// source of their state. It turns the ACP update stream into the same events the hooks send,
// so the registry, the ledger, the Inbox and the Session keys treat deck sessions like any other.
// It also writes a Markdown transcript per session, the only place their replies can be read.

import { appendFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { optionOf, parsePermissionAsk, type PermissionAsk } from "../companion/ask";
import { AcpConnection } from "./acp";
import type { Logger } from "./logger";
import type { HookEvent, HookMeta } from "./sessions";
import { categorize, summarize } from "./tools";

/** One choice of a select option, as Kiro advertises it. */
export interface Choice {
  value: string;
  name: string;
  /** Credits per request relative to Auto (models only). */
  rate?: number;
}

/** A session setting Kiro advertises: `model`, `effortLevel`, `autopilot`, `mode`, ... */
export interface Setting {
  id: string;
  current: string;
  choices: Choice[];
}

export interface DeckInit {
  model?: string;
  effort?: string;
  autopilot?: boolean;
}

/** A permission request from a deck session, ready for the approval queue. */
export interface DeckAsk extends PermissionAsk {
  /** Kiro's end-of-turn "Review changes" (accept or reject the turn's file changes). */
  review: boolean;
  /** The deck session's folder, when the request comes from one we know. */
  cwd?: string;
}

export type DeckAnswer = { kind: "allow" } | { kind: "deny"; reason?: string } | { kind: "cancel" };

export interface DeckEvents {
  /** A lifecycle event for the registry, shaped like a hook event. */
  event(event: HookEvent, meta: HookMeta, extra?: { credits?: number }): void;
  /** The agent asks permission. Resolve with the deck's answer; `signal` aborts when the turn ends. */
  permission(ask: DeckAsk, signal: AbortSignal): Promise<DeckAnswer>;
  changed(): void;
}

export interface DeckOptions {
  /** kiro-cli, or undefined when it is not installed. */
  command: () => string | undefined;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** Where transcripts go (created 0700, files 0600). */
  dir: string;
  now: () => number;
  log: Logger;
  events: DeckEvents;
}

/** Settings shown by Model, Effort and Autonomy for their selected session. */
export interface SessionSettingsView {
  id: string;
  cwd: string;
  workspace: string;
  working: boolean;
  /** False when Kiro's local session metadata could not be read. */
  metadataAvailable: boolean;
  /** Config option IDs this connection advertised and can change. */
  writableSettings: string[];
  model?: Choice;
  models: Choice[];
  effort?: string;
  effortLevels: string[];
  autopilot?: boolean;
  autopilotValues: string[];
}

/** What the deck keys show about one deck-owned session. */
export interface DeckView extends SessionSettingsView {
  title?: string;
  contextPercent?: number;
  lastTurnCredits?: number;
  totalCredits: number;
  transcript: string;
}

interface ToolState {
  name: string;
  input: unknown;
  done: boolean;
}

interface DeckSession {
  id: string;
  cwd: string;
  title?: string;
  transcript: string;
  settings: Setting[];
  turn?: { startedAt: number };
  /** Bumped by every prompt and steer: the target is the most recently used session. */
  usedAt: number;
  tools: Map<string, ToolState>;
  asks: Set<AbortController>;
  contextPercent?: number;
  lastTurnCredits?: number;
  totalCredits: number;
  writer: Promise<void>;
  /** What the transcript ends with, so the next block gets the blank lines Markdown needs. */
  last: "text" | "item" | "block";
}

const DEFAULT_ARGS = ["acp", "--agent-engine=v3"];
const REQUEST_TIMEOUT_MS = 60_000;
/** ACP tool kinds, mapped to the Kiro tool the hooks would name, so categories match. */
const KIND_TOOL: Readonly<Record<string, string>> = {
  execute: "execute_bash",
  edit: "fs_write",
  delete: "delete_file",
  move: "smart_relocate",
  read: "read_file",
  search: "grep_search",
  fetch: "web_fetch",
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Reads the `configOptions` of a session/new result or a config_option_update. */
export function parseSettings(raw: unknown): Setting[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((o) => {
    const opt = obj(o);
    const id = str(opt?.id);
    const current = str(opt?.currentValue);
    if (!opt || !id || current === undefined || opt.type !== "select") return [];
    const choices = (Array.isArray(opt.options) ? opt.options : []).flatMap((c) => {
      const choice = obj(c);
      const value = str(choice?.value);
      if (!choice || !value) return [];
      const rate = num(obj(obj(choice._meta)?.kiro)?.rateMultiplier);
      return [{ value, name: str(choice.name) ?? value, ...(rate !== undefined ? { rate } : {}) }];
    });
    return [{ id, current, choices }];
  });
}

/** The tool name a hook would report for an ACP tool call, so categories and summaries match. */
export function toolNameOf(update: Record<string, unknown>): string {
  const identity = obj(obj(obj(obj(update._meta)?.kiro)?.mcpTool)?.identity);
  const server = str(identity?.serverName);
  const tool = str(identity?.toolName);
  const mcpName = (s: string, t: string) => `mcp_${s}_${t}`.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (server && tool) return mcpName(server, tool);
  const title = str(update.title) ?? "";
  const mcp = /^@([^/\s]+)\/(\S+)$/.exec(title);
  if (mcp) return mcpName(mcp[1]!, mcp[2]!);
  return KIND_TOOL[str(update.kind) ?? ""] ?? "tool";
}

/** Credits a turn used, from a turn_completion's `promptTurnSummaries`. */
export function turnCredits(kiro: Record<string, unknown>): number | undefined {
  const summaries = Array.isArray(kiro.promptTurnSummaries) ? kiro.promptTurnSummaries : [];
  let total: number | undefined;
  for (const s of summaries) {
    const o = obj(s);
    const usage = num(o?.usage);
    if (usage !== undefined && /^credit/i.test(str(o?.unit) ?? "credit")) total = (total ?? 0) + usage;
  }
  return total;
}

/** "Claude Opus 5.5" -> "Opus 5.5". */
export function shortModelName(name: string): string {
  return name.replace(/^Claude\s+/i, "").trim() || name;
}

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
const seconds = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);

export class DeckHost {
  private acp?: AcpConnection;
  private ready?: Promise<AcpConnection>;
  private readonly sessions = new Map<string, DeckSession>();
  private selected?: string;
  /** The last model list Kiro advertised, for model keys while no session is open. */
  private lastModels: Choice[] = [];

  constructor(private readonly options: DeckOptions) {}

  owns(id: string): boolean {
    return this.sessions.has(id);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** True while kiro-cli runs for deck sessions. */
  get connected(): boolean {
    return this.acp !== undefined && !this.acp.isClosed;
  }

  /** A request on the running connection (account usage), or undefined when none runs. */
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> | undefined {
    return this.connected && this.sessions.size > 0 ? this.acp!.request(method, params, timeoutMs) : undefined;
  }

  /** Finds a session by ID or unique ID prefix (with or without `sess_`); without one, the target. */
  find(idOrPrefix?: string): DeckView | undefined {
    if (!idOrPrefix) return this.target();
    const exact = this.sessions.get(idOrPrefix);
    const matches = exact
      ? [exact]
      : [...this.sessions.values()].filter((s) => s.id.startsWith(idOrPrefix) || s.id.startsWith(`sess_${idOrPrefix}`));
    return matches.length === 1 ? this.view(matches[0]!) : undefined;
  }

  /** The session deck keys act on: the one picked last (Session key press), else the most recently used. */
  target(): DeckView | undefined {
    const s = this.targetSession();
    return s && this.view(s);
  }

  select(id: string): boolean {
    if (!this.sessions.has(id)) return false;
    this.selected = id;
    this.options.events.changed();
    return true;
  }

  get(id: string): DeckView | undefined {
    const s = this.sessions.get(id);
    return s && this.view(s);
  }

  list(): DeckView[] {
    return [...this.sessions.values()].map((s) => this.view(s));
  }

  /** Starts a deck session in `cwd` (an existing absolute folder). */
  async start(cwd: string, init: DeckInit = {}): Promise<DeckView> {
    const acp = await this.connection();
    const kiro = { ...(init.model ? { modelId: init.model } : {}), ...(init.effort ? { effortLevel: init.effort } : {}) };
    const result = obj(
      await acp.request("session/new", { cwd, mcpServers: [], ...(Object.keys(kiro).length ? { _meta: { kiro } } : {}) }, REQUEST_TIMEOUT_MS),
    );
    const id = str(result?.sessionId);
    if (!id) throw new Error("kiro-cli did not return a session ID");
    const now = this.options.now();
    const s: DeckSession = {
      id,
      cwd,
      transcript: join(this.options.dir, `${id}.md`),
      settings: parseSettings(result?.configOptions),
      usedAt: now,
      tools: new Map(),
      asks: new Set(),
      totalCredits: 0,
      writer: Promise.resolve(),
      last: "block",
    };
    this.sessions.set(id, s);
    this.remember(s);
    this.options.log.info(`deck session ${id} started in ${cwd}`);
    this.emit(s, { hook_event_name: "SessionStart" });
    const model = this.setting(s, "model");
    this.write(s, `# Deck session: ${basename(cwd) || cwd}\n\n${cwd}, started ${new Date(now).toLocaleString()}. Session \`${id}\`.\n`);
    if (model) this.note(s, `Model: ${model.choices.find((c) => c.value === model.current)?.name ?? model.current}.`);
    if (init.autopilot !== undefined) await this.set(id, "autopilot", init.autopilot ? "on" : "off");
    return this.view(s);
  }

  /**
   * Sends text to a session: a new turn when it is idle, steering for the running turn otherwise
   * (Kiro adds it to the turn at its next step).
   */
  async prompt(id: string, text: string): Promise<"started" | "steered"> {
    const s = this.require(id);
    const acp = await this.connection();
    s.usedAt = this.options.now();
    if (s.turn) {
      await acp.request("_session/steer", { sessionId: id, message: text }, REQUEST_TIMEOUT_MS);
      this.block(s, `> Steering: ${text.replace(/\n/g, "\n> ")}`);
      this.options.events.changed();
      return "steered";
    }
    const startedAt = this.options.now();
    s.turn = { startedAt };
    s.lastTurnCredits = undefined; // a stopped turn may report none
    this.emit(s, { hook_event_name: "UserPromptSubmit", prompt: text });
    this.block(s, `## You, ${clock(startedAt)}\n\n${text}\n\n## Kiro`);
    acp.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text }] }, 0).then(
      (result) => this.endTurn(s, str(obj(result)?.stopReason) ?? "end_turn"),
      (err: unknown) => this.endTurn(s, `error: ${err instanceof Error ? err.message : String(err)}`),
    );
    return "started";
  }

  /** Stops the running turn. False when nothing runs. */
  cancel(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s?.turn || !this.connected) return false;
    this.acp!.notify("session/cancel", { sessionId: id });
    this.abortAsks(s); // the agent no longer waits for them
    return true;
  }

  /** Stops every running turn (lockdown). Returns how many. */
  cancelAll(): number {
    return [...this.sessions.keys()].filter((id) => this.cancel(id)).length;
  }

  /** Changes an advertised setting to one of its advertised values. */
  async set(id: string, settingId: string, value: string): Promise<DeckView> {
    const s = this.require(id);
    const setting = this.setting(s, settingId);
    if (!setting) throw new Error(`this session has no ${settingId} setting`);
    if (!setting.choices.some((c) => c.value === value)) {
      throw new Error(`${value} is not a ${settingId} Kiro offers (${setting.choices.map((c) => c.value).join(", ")})`);
    }
    const acp = await this.connection();
    const result = obj(await acp.request("session/set_config_option", { sessionId: id, configId: settingId, value }, REQUEST_TIMEOUT_MS));
    const settings = parseSettings(result?.configOptions);
    if (settings.length) s.settings = settings;
    else setting.current = value;
    this.remember(s);
    this.note(s, `${settingId} set to ${value}.`);
    this.options.events.changed();
    return this.view(s);
  }

  /** Moves a setting to its next value (wrapping). */
  cycle(id: string, settingId: string, values?: string[]): Promise<DeckView> {
    const s = this.require(id);
    const setting = this.setting(s, settingId);
    const offered = setting?.choices.map((c) => c.value) ?? [];
    const order = values?.length ? values.filter((v) => offered.includes(v)) : offered;
    if (!setting || order.length === 0) return Promise.reject(new Error(`this session has no ${settingId} to change`));
    const next = order[(order.indexOf(setting.current) + 1) % order.length]!;
    return this.set(id, settingId, next);
  }

  /** Ends a session: stops its turn, closes it in kiro-cli, and stops kiro-cli after the last one. */
  async close(id: string): Promise<void> {
    const s = this.require(id);
    this.cancel(id);
    await this.acp?.request("session/close", { sessionId: id }, 10_000).catch(() => undefined);
    this.note(s, `Session closed ${new Date(this.options.now()).toLocaleString()}.`);
    this.drop(s, "closed");
    if (this.sessions.size === 0) this.shutdown();
  }

  /** Plugin shutdown: kiro-cli stops, running turns end with it. */
  stop(): void {
    for (const s of [...this.sessions.values()]) this.drop(s, "plugin stopped");
    this.shutdown();
  }

  // ---- ACP -----------------------------------------------------------------------------

  private connection(): Promise<AcpConnection> {
    if (this.ready && this.connected) return this.ready;
    const command = this.options.command();
    if (!command) return Promise.reject(new Error("kiro-cli not found; deck sessions need it"));
    const acp = AcpConnection.spawn(command, this.options.args ?? DEFAULT_ARGS, this.options.env, {
      notification: (method, params) => this.onNotification(method, params),
      request: (method, params) => this.onRequest(method, params),
      closed: (err) => this.onClosed(acp, err),
    });
    this.acp = acp;
    this.ready = mkdir(this.options.dir, { recursive: true, mode: 0o700 })
      .then(() =>
        acp.request(
          "initialize",
          {
            protocolVersion: 1,
            // The deck reads and writes no files and runs no terminals for the agent.
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: "ki-deck", version: "1" },
          },
          REQUEST_TIMEOUT_MS,
        ),
      )
      .then(
        () => acp,
        (err: unknown) => {
          const tail = acp.stderr.trim().split("\n").filter(Boolean).at(-1);
          acp.close();
          throw new Error(`kiro-cli did not start: ${err instanceof Error ? err.message : String(err)}${tail ? `: ${tail.slice(0, 200)}` : ""}`);
        },
      );
    return this.ready;
  }

  private onClosed(acp: AcpConnection, err: Error): void {
    if (this.acp !== acp) return;
    this.acp = undefined;
    this.ready = undefined;
    if (this.sessions.size === 0) return;
    this.options.log.warn(`deck: kiro-cli stopped (${err.message}); its sessions ended`);
    for (const s of [...this.sessions.values()]) this.drop(s, `kiro-cli stopped: ${err.message}`);
  }

  private shutdown(): void {
    const acp = this.acp;
    this.acp = undefined;
    this.ready = undefined;
    acp?.close();
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const p = obj(params);
    const s = this.sessions.get(str(p?.sessionId) ?? "");
    const update = obj(p?.update);
    if (!s || !update) return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = str(obj(update.content)?.text);
        if (text) this.say(s, text);
        break;
      }
      case "tool_call":
        this.toolStarted(s, update);
        break;
      case "tool_call_update":
        this.toolUpdated(s, update);
        break;
      case "config_option_update": {
        const settings = parseSettings(update.configOptions);
        if (settings.length) {
          s.settings = settings;
          this.remember(s);
          this.options.events.changed();
        }
        break;
      }
      case "session_info_update":
        this.info(s, update);
        break;
    }
  }

  private info(s: DeckSession, update: Record<string, unknown>): void {
    const kiro = obj(obj(update._meta)?.kiro) ?? {};
    const context = num(obj(kiro.contextUsage)?.usagePercentage) ?? (kiro.kind === "context_usage" ? num(kiro.usagePercentage) : undefined);
    if (context !== undefined && context !== s.contextPercent) {
      s.contextPercent = context;
      this.options.events.changed();
    }
    const title = str(update.title);
    if (title && kiro.kind === "focus_update") s.title = title;
    if (kiro.kind === "turn_completion") {
      const credits = turnCredits(kiro);
      if (credits !== undefined) {
        s.lastTurnCredits = credits;
        s.totalCredits += credits;
      }
    }
    if (kiro.kind === "display_error") {
      const message = str(kiro.message) ?? str(obj(kiro.displayError)?.message);
      if (message) this.item(s, `⚠ ${message}`);
    }
  }

  private toolStarted(s: DeckSession, update: Record<string, unknown>): void {
    const id = str(update.toolCallId);
    if (!id || s.tools.has(id)) return this.toolUpdated(s, update);
    const tool: ToolState = { name: toolNameOf(update), input: update.rawInput ?? {}, done: false };
    s.tools.set(id, tool);
    this.emit(s, { hook_event_name: "PreToolUse", tool_name: tool.name, tool_input: tool.input });
    this.toolUpdated(s, update);
  }

  private toolUpdated(s: DeckSession, update: Record<string, unknown>): void {
    const tool = s.tools.get(str(update.toolCallId) ?? "");
    const status = str(update.status);
    if (!tool || tool.done || (status !== "completed" && status !== "failed")) return;
    tool.done = true;
    this.emit(s, { hook_event_name: "PostToolUse", tool_name: tool.name, tool_input: tool.input });
    const what = `${categorize(tool.name)}: ${summarize(tool.name, tool.input)}`;
    this.item(s, status === "completed" ? `✓ ${what}` : `✗ ${what} (${str(obj(obj(update._meta)?.kiro)?.failureReason) ?? "failed"})`);
  }

  private onRequest(method: string, params: unknown): Promise<unknown> | undefined {
    if (method !== "session/request_permission") return undefined;
    const ask = parsePermissionAsk(params);
    const s = ask && this.sessions.get(ask.sessionId);
    // Never allow what the deck cannot show: unreadable requests and unknown sessions run nothing.
    if (!ask || !s) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const review = obj(obj(obj(params)?._meta)?.kiro)?.type === "turn_approval";
    const controller = new AbortController();
    s.asks.add(controller);
    const what = review ? "review this turn's changes" : `${ask.title}${ask.resource && ask.resource !== ask.title ? ` (${ask.resource})` : ""}`;
    return this.options.events.permission({ ...ask, review, cwd: s.cwd }, controller.signal).then(async (answer) => {
      s.asks.delete(controller);
      const outcome = answer.kind === "allow" ? "allowed" : answer.kind === "deny" ? "denied" : "not answered";
      this.item(s, `Approval, ${what}: ${outcome} on Stream Deck`);
      return this.outcome(ask, answer, review);
    });
  }

  /** The ACP answer for a deck decision. A deny reason goes to the agent as steering first. */
  private async outcome(ask: PermissionAsk, answer: DeckAnswer, review: boolean): Promise<unknown> {
    if (answer.kind === "cancel") return { outcome: { outcome: "cancelled" } };
    const option = optionOf(ask, answer.kind === "allow" ? "allow_once" : "reject_once");
    if (!option) return { outcome: { outcome: "cancelled" } };
    if (answer.kind === "deny" && answer.reason && !review) {
      await this.acp?.request("_session/steer", { sessionId: ask.sessionId, message: answer.reason }, 10_000).catch(() => undefined);
    }
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  }

  // ---- State -----------------------------------------------------------------------------

  private endTurn(s: DeckSession, stopReason: string): void {
    if (!s.turn) return;
    const tookMs = this.options.now() - s.turn.startedAt;
    s.turn = undefined;
    this.abortAsks(s);
    for (const tool of s.tools.values()) tool.done = true;
    s.tools.clear();
    if (!this.sessions.has(s.id)) return; // closed meanwhile
    this.emit(s, { hook_event_name: "Stop" }, { ...(s.lastTurnCredits !== undefined ? { credits: s.lastTurnCredits } : {}) });
    const credits = s.lastTurnCredits !== undefined ? `, ${s.lastTurnCredits.toFixed(2)} credits` : "";
    const how = stopReason === "end_turn" ? "Turn ended" : stopReason === "cancelled" ? "Turn stopped" : `Turn ended (${stopReason})`;
    this.note(s, `${how} after ${seconds(tookMs)}${credits}.`);
  }

  private drop(s: DeckSession, why: string): void {
    if (!this.sessions.delete(s.id)) return;
    this.abortAsks(s);
    s.turn = undefined;
    if (this.selected === s.id) this.selected = undefined;
    this.options.log.info(`deck session ${s.id} ended: ${why}`);
    this.emit(s, { hook_event_name: "SessionEnd" });
  }

  private abortAsks(s: DeckSession): void {
    for (const controller of s.asks) controller.abort();
    s.asks.clear();
  }

  private emit(s: DeckSession, event: HookEvent & Record<string, unknown>, extra?: { credits?: number }): void {
    const meta: HookMeta = { surface: "deck", bundle: "", term: "", termSession: "", tmuxPane: "", tty: "", ...(this.acp?.pid ? { pid: this.acp.pid } : {}) };
    this.options.events.event({ session_id: s.id, cwd: s.cwd, ...event }, meta, extra);
  }

  private remember(s: DeckSession): void {
    const models = this.setting(s, "model")?.choices;
    if (models?.length) this.lastModels = models;
  }

  private setting(s: DeckSession, id: string): Setting | undefined {
    return s.settings.find((x) => x.id === id);
  }

  private require(id: string): DeckSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`no deck session ${id}`);
    return s;
  }

  private targetSession(): DeckSession | undefined {
    const selected = this.selected ? this.sessions.get(this.selected) : undefined;
    return selected ?? [...this.sessions.values()].sort((a, b) => b.usedAt - a.usedAt)[0];
  }

  private view(s: DeckSession): DeckView {
    const model = this.setting(s, "model");
    const effort = this.setting(s, "effortLevel");
    const autopilot = this.setting(s, "autopilot");
    const models = model?.choices.length ? model.choices : this.lastModels;
    return {
      id: s.id,
      cwd: s.cwd,
      workspace: basename(s.cwd) || s.cwd,
      working: s.turn !== undefined,
      metadataAvailable: true,
      writableSettings: s.settings.map((setting) => setting.id),
      ...(s.title ? { title: s.title } : {}),
      ...(model ? { model: model.choices.find((c) => c.value === model.current) ?? { value: model.current, name: model.current } } : {}),
      models,
      ...(effort ? { effort: effort.current } : {}),
      effortLevels: effort?.choices.map((c) => c.value) ?? [],
      ...(autopilot ? { autopilot: autopilot.current === "on" } : {}),
      autopilotValues: autopilot?.choices.map((choice) => choice.value) ?? [],
      ...(s.contextPercent !== undefined ? { contextPercent: s.contextPercent } : {}),
      ...(s.lastTurnCredits !== undefined ? { lastTurnCredits: s.lastTurnCredits } : {}),
      totalCredits: s.totalCredits,
      transcript: s.transcript,
    };
  }

  /** The model list Kiro offered last, for model keys before any session is open. */
  get models(): Choice[] {
    return this.target()?.models ?? this.lastModels;
  }

  // ---- Transcript ------------------------------------------------------------------------

  /** Streamed reply text, appended as it arrives. */
  private say(s: DeckSession, text: string): void {
    this.write(s, s.last === "text" ? text : `\n${text}`);
    s.last = "text";
  }

  /** One list item (a tool, an approval, a warning); consecutive items form one list. */
  private item(s: DeckSession, line: string): void {
    this.write(s, `${s.last === "text" ? "\n\n" : s.last === "block" ? "\n" : ""}- ${line}\n`);
    s.last = "item";
  }

  /** A paragraph or heading block, set apart by blank lines. */
  private block(s: DeckSession, markdown: string): void {
    this.write(s, `${s.last === "text" ? "\n\n" : "\n"}${markdown}\n`);
    s.last = "block";
  }

  /** A status line in italics. */
  private note(s: DeckSession, line: string): void {
    this.block(s, `_${line}_`);
  }

  private write(s: DeckSession, text: string): void {
    s.writer = s.writer
      .then(() => appendFile(s.transcript, text, { mode: 0o600 }))
      .catch((err: unknown) => this.options.log.warn(`deck: cannot write ${s.transcript}: ${err instanceof Error ? err.message : String(err)}`));
  }
}
