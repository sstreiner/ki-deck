// Stream Deck companion for Kiro IDE. Runs in every Kiro window.
//
// It connects to the window's agent hub as an observer, so it sees every permission request
// Kiro shows with the full question. Each one is handed to the plugin's bridge over the private
// Unix socket; when a key on the deck decides, the companion answers that exact call with
// `_kiro/permission/respond`, as Kiro's own dialog would. If the bridge is unreachable, or the
// deck chooses "Decide in Kiro", it answers nothing and Kiro's dialog works exactly as before.
//
// It also reports how full each chat's context window is (context.ts), and holds a command
// stream from the bridge open, so pressing a Session key shows that chat (or the integrated
// terminal kiro-cli runs in) in this window.

import { execFile } from "node:child_process";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { optionOf, type PermissionAsk } from "./ask";
import { BridgeLink, type CompanionCommand } from "./bridge-link";
import { ContextPoller } from "./context";
import { HubClient, pickEndpoint, type Endpoint, type HubEvents } from "./hub";
import { newerInstalled } from "./update";

/** Must equal extension/package.json "version" (a test checks). Traced at start for `doctor`. */
export const VERSION = "0.6.0";
const EXTENSION_ID = "sstreiner.ki-deck-companion";
const BASE = process.env.KI_DECK_HOME || join(homedir(), ".ki-deck");
const TRACE = join(BASE, "run", `companion-${process.pid}.jsonl`);
const RETRY_MS = 5000;
/** How often the window looks for a newer installed companion (install.sh updates it in place). */
const UPDATE_CHECK_MS = 60_000;

/** A bridge without the command stream (plugin before 0.8.0) is asked again this rarely. */
const OLD_BRIDGE_RETRY_MS = 60_000;

const link = new BridgeLink(join(BASE, "run", "bridge.sock"));

let hub: HubClient | undefined;
let endpoint: Endpoint | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let commandsRetry: ReturnType<typeof setTimeout> | undefined;
let closeCommands: (() => void) | undefined;
let commandsOpen = false;
let updateTimer: ReturnType<typeof setInterval> | undefined;
let offeredReload: string | undefined;
let stopped = false;
let output: vscode.OutputChannel;

/** Context use over short-lived hub connections that ask and leave (see context.ts). */
const contexts = new ContextPoller({
  open: async () => {
    if (!endpoint) return undefined;
    const client = new HubClient(endpoint, { name: "ki-deck-context", version: VERSION }, QUIET);
    try {
      await client.connect();
      return client;
    } catch {
      client.close();
      return undefined;
    }
  },
  report: (sessionId, percent) => link.context(process.pid, sessionId, percent),
  active: () => commandsOpen, // no bridge (or one before 0.8.0): nobody to tell
});

/** Events of a short-lived connection: everything it receives meanwhile is ignored. */
const QUIET: HubEvents = { ask: () => undefined, resolved: () => undefined, sessions: () => undefined, message: () => undefined, closed: () => undefined };

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("ki-deck");
  context.subscriptions.push(output, { dispose: () => stop() });
  log(`companion ${VERSION} started (pid ${process.pid}); trace: ${TRACE}`);
  void trace({ event: "started", version: VERSION, pid: process.pid });
  void connect();
  openCommands();
  // The bridge routes Session keys by workspace folder, so it needs the current ones.
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => reopenCommands()));
  const extensionsDir = dirname(context.extensionPath);
  updateTimer = setInterval(() => void offerReload(extensionsDir), UPDATE_CHECK_MS);
  void offerReload(extensionsDir);
}

export function deactivate(): void {
  stop();
}

function stop(): void {
  stopped = true;
  clearTimeout(retry);
  clearTimeout(commandsRetry);
  clearInterval(updateTimer);
  contexts.stop();
  closeCommands?.();
  link.close();
  hub?.close();
}

/**
 * The bridge's command stream for this window. It reconnects whenever the bridge restarts (with
 * Stream Deck), and then reports every chat's context again, since the bridge forgot it.
 */
function openCommands(): void {
  if (stopped) return;
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  let opened = false;
  closeCommands = link.commands(
    { pid: process.pid, version: VERSION, folders },
    {
      onOpen: () => {
        opened = true;
        commandsOpen = true;
        log("connected to the Stream Deck bridge");
        contexts.resend();
      },
      onCommand: (command) => void runCommand(command),
      onClose: (reason) => {
        closeCommands = undefined;
        commandsOpen = false;
        if (opened) log(`bridge stream ended: ${reason}`);
        if (!stopped) commandsRetry = setTimeout(openCommands, reason.startsWith("bridge answered 404") ? OLD_BRIDGE_RETRY_MS : RETRY_MS);
      },
    },
  );
}

/** Opens the stream again at once, with the window's current folders. */
function reopenCommands(): void {
  clearTimeout(commandsRetry);
  closeCommands?.(); // closing from our side reports nothing, so no retry is pending
  closeCommands = undefined;
  commandsOpen = false;
  openCommands();
}

/** A command from the Stream Deck bridge for this Kiro window. */
async function runCommand(command: CompanionCommand): Promise<void> {
  try {
    if (command.kind === "focus") {
      // Kiro's own command: switches the chat panel to that chat, as picking it from the history does.
      await vscode.commands.executeCommand("kiroAgent.viewSession", command.sessionId);
      log(`SHOW chat ${command.sessionId}`);
      contexts.refresh(command.sessionId); // a chat idle since this window loaded has no value yet
      return;
    }
    if (command.kind === "terminal") {
      const shown = await showTerminal(command.tty);
      log(`SHOW terminal ${command.tty}${shown ? "" : ": no terminal of this window runs on it"}`);
      return;
    }
    await setSessionConfig(command);
  } catch (err) {
    const target = command.kind === "focus" ? command.sessionId : command.kind === "terminal" ? command.tty : command.sessionId;
    log(`could not run ${command.kind} for ${target}: ${String(err)}`);
  }
}

/** Sends a correlated result even when the hub is offline or rejects the setting. */
async function setSessionConfig(command: Extract<CompanionCommand, { kind: "set_config" }>): Promise<void> {
  try {
    if (!hub) throw new Error("Kiro agent hub is not connected");
    const result = await hub.setConfigOption(command.sessionId, command.configId, command.value);
    const record = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : undefined;
    await link.configResult(process.pid, command.requestId, {
      ok: true,
      ...(Array.isArray(record?.configOptions) ? { configOptions: record.configOptions } : {}),
    });
    log(`SET ${command.configId}=${command.value} in ${command.sessionId}`);
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await link.configResult(process.pid, command.requestId, { ok: false, error });
    log(`SET failed ${command.configId} in ${command.sessionId}: ${error}`);
  }
}

/** Brings forward the integrated terminal whose shell runs on `tty` (kiro-cli inside Kiro). */
async function showTerminal(tty: string): Promise<boolean> {
  for (const terminal of vscode.window.terminals) {
    const pid = await terminal.processId;
    if (pid !== undefined && (await ttyOf(pid)) === tty) {
      terminal.show(false);
      return true;
    }
  }
  return false;
}

function ttyOf(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-o", "tty=", "-p", String(pid)], { timeout: 2000 }, (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined));
  });
}

/**
 * A window keeps the companion it loaded until it reloads, so an update installed meanwhile
 * (by install.sh) would not reach it. Offer the reload once per newer version.
 */
async function offerReload(extensionsDir: string): Promise<void> {
  let newer: string | undefined;
  try {
    newer = newerInstalled(await readdir(extensionsDir), EXTENSION_ID, VERSION);
  } catch {
    return; // the folder is Kiro's; if it cannot be read, there is nothing to offer
  }
  if (!newer || newer === offeredReload) return;
  offeredReload = newer;
  log(`companion ${newer} is installed; this window still runs ${VERSION}`);
  const choice = await vscode.window.showInformationMessage(
    `ki-deck ${newer} is installed. Reload this window so the Stream Deck gets its approval prompts, context use and focus.`,
    "Reload Window",
  );
  if (choice === "Reload Window") await vscode.commands.executeCommand("workbench.action.reloadWindow");
}

async function connect(): Promise<void> {
  if (stopped) return;
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  let endpoints: Endpoint[] = [];
  try {
    endpoints = ((await vscode.commands.executeCommand("kiro.agentRegistry.getAgentEndpoints")) as Endpoint[] | undefined) ?? [];
  } catch (err) {
    log(`agent registry not available: ${String(err)}`);
  }
  const picked = pickEndpoint(endpoints, folders);
  await trace({
    event: "endpoints",
    folders,
    endpoints: endpoints.map((e) => ({ windowId: e.windowId, port: e.port, folders: e.folders.map((f) => f.path) })), // no tokens
    picked: picked?.windowId,
  });
  if (!picked) {
    log(`no agent endpoint for ${folders.join(", ") || "this window"} yet; retrying`);
    retry = setTimeout(() => void connect(), RETRY_MS);
    return;
  }
  endpoint = picked;

  const client = new HubClient(picked, { name: "ki-deck-companion", version: VERSION }, {
    ask: (ask) => {
      log(`ASK ${ask.title} in ${ask.sessionId}: ${ask.command ?? ask.paths.join(", ")} [${ask.options.map((o) => o.kind).join(", ")}]`);
      void trace({ event: "ask", ask });
      void answerAsk(client, ask);
    },
    resolved: (resolved) => {
      log(`RESOLVED ${resolved.toolCallId} in ${resolved.sessionId}`);
      void trace({ event: "resolved", resolved });
      link.cancel(resolved.toolCallId, resolved.consentRound);
    },
    sessions: (changed) => {
      for (const s of changed) {
        log(`SESSION ${s.sessionId} ${s.status}`);
        contexts.changed(s.sessionId, s.status);
      }
      void trace({ event: "sessions", changed });
    },
    message: (direction, message) => void trace({ event: "message", direction, message }),
    closed: (reason) => {
      log(`hub connection ${reason}`);
      void trace({ event: "closed", reason });
      link.close(); // pending posts belong to this connection; a reconnect resends the asks
      contexts.resetStatuses(); // updates missed while disconnected would leave chats "working"
      if (hub === client) hub = undefined;
      if (!stopped) retry = setTimeout(() => void connect(), RETRY_MS);
    },
  });
  try {
    const init = await client.connect();
    hub = client;
    log(`observing the agent hub of window ${picked.windowId} on port ${picked.port}`);
    await trace({ event: "initialized", windowId: picked.windowId, port: picked.port, result: init });
  } catch (err) {
    log(`connect failed: ${String(err)}`);
    client.close();
  }
}

/**
 * Asks the bridge how the deck decides this call, then answers Kiro's hub natively. On `allow`
 * it picks the "allow once" option, on `deny` the "reject once" option with the reason the agent
 * sees. On `ask`, no bridge, or a missing option, it answers nothing: Kiro's own dialog stands.
 */
async function answerAsk(client: HubClient, ask: PermissionAsk): Promise<void> {
  const decision = await link.ask(ask);
  if (!decision || decision.kind === "ask") return;
  const option = optionOf(ask, decision.kind === "allow" ? "allow_once" : "reject_once");
  if (!option) {
    log(`no ${decision.kind} option offered for ${ask.toolCallId}; leaving it to Kiro`);
    return;
  }
  try {
    await client.respond(ask.toolCallId, option.optionId, decision.kind === "deny" ? decision.reason : undefined);
    log(`ANSWERED ${ask.toolCallId} ${decision.kind}${decision.reason ? `: ${decision.reason}` : ""}`);
    await trace({ event: "answered", toolCallId: ask.toolCallId, decision });
  } catch (err) {
    // Kiro no longer waits for this call (answered elsewhere, or the turn ended).
    log(`answer failed for ${ask.toolCallId}: ${String(err)}`);
  }
}

function log(line: string): void {
  output.appendLine(`${new Date().toISOString()} ${line}`);
}

async function trace(entry: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(join(BASE, "run"), { recursive: true, mode: 0o700 });
    await appendFile(TRACE, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    // the trace is best effort
  }
}
