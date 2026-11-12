// The companion -> bridge -> deck flow end to end: BridgeLink posts a native permission ask the
// way the companion observed it from Kiro's hub, the bridge merges it into the same approval
// queue the gate uses, and decide()/lockdown settle it. The reply is what the companion then
// answers Kiro with. The hub side (parsing, responding) is covered in companion.test.ts.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bridge, bridgePaths, LOCKDOWN_REASON } from "../src/bridge";
import { Companions, type CompanionCommand } from "../src/bridge/companions";
import { silentLogger } from "../src/bridge/logger";
import type { RunResult } from "../src/bridge/system";
import type { PermissionAsk } from "../src/companion/ask";
import { BridgeLink } from "../src/companion/bridge-link";

const home = mkdtempSync(join(tmpdir(), "sdk-companion-bridge-"));
const paths = bridgePaths(home);
const kiroSessionsDir = join(home, "kiro-sessions");
const commands: Array<{ cmd: string; args: string[] }> = [];

const bridge = new Bridge({
  version: "test",
  logger: silentLogger,
  paths,
  kiroSessionsDir,
  bins: {},
  isAlive: () => true,
  tickMs: 50, // prompt-only sessions leave on the tick after their prompt
  run: async (cmd, args): Promise<RunResult> => {
    commands.push({ cmd, args });
    return { ok: true, stdout: "", stderr: "" };
  },
});

const link = new BridgeLink(paths.socket);

/** An IDE chat as kd-hook reports it. */
const IDE = { surface: "ide" as const, bundle: "dev.kiro.desktop", term: "", termSession: "", tmuxPane: "", tty: "", pid: 4321 };

const OPTIONS = [
  { optionId: "accept", name: "Allow", kind: "allow_once" },
  { optionId: "reject", name: "Deny", kind: "reject_once" },
];

const writeAsk = (toolCallId: string): PermissionAsk => ({
  sessionId: "sess_1",
  toolCallId,
  consentRound: 1,
  title: "Write File",
  toolId: "fs_write",
  capability: "fs_write",
  resource: "/Users/me/shop/src/app.ts",
  workspaceRoot: "/Users/me/shop",
  paths: ["/Users/me/shop/src/app.ts"],
  options: OPTIONS,
});

const shellAsk = (toolCallId: string): PermissionAsk => ({
  sessionId: "sess_1",
  toolCallId,
  consentRound: 1,
  title: "npm install left-pad",
  toolId: "run_command",
  capability: "shell",
  command: "npm install left-pad",
  workspaceRoot: "/Users/me/shop",
  paths: [],
  options: OPTIONS,
});

async function waitFor<T>(probe: () => T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  writeFileSync(paths.config, JSON.stringify({ notifications: { quietHours: "" }, ledger: { storeRaw: true }, deck: { models: ["auto"] } }));
  await bridge.start();
});

afterAll(async () => {
  link.close();
  await bridge.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("companion setting ownership", () => {
  it("rejects an in-flight write when the session moves to another window", async () => {
    const companions = new Companions();
    const sent: CompanionCommand[] = [];
    const removeFirst = companions.add({ pid: 1001, version: "test", folders: ["/workspace"] }, (line) => sent.push(JSON.parse(line)));
    const removeSecond = companions.add({ pid: 1002, version: "test", folders: ["/workspace"] }, () => undefined);
    companions.claim(1001, "sess_move");
    const pending = companions.requestConfig("sess_move", "model", "auto");
    expect(sent[0]).toMatchObject({ kind: "set_config", sessionId: "sess_move" });

    companions.claim(1002, "sess_move");
    await expect(pending).rejects.toThrow("another window");
    expect(companions.settleConfig(1001, (sent[0] as Extract<CompanionCommand, { kind: "set_config" }>).requestId, { ok: true })).toBe(false);
    removeSecond();
    removeFirst();
  });
});

describe("companion asks through the bridge", () => {
  it("holds a native write prompt until Allow, then tells the companion to allow", async () => {
    const pending = link.ask(writeAsk("toolu_write_1"));
    const approval = await waitFor(() => bridge.targetApproval());
    expect(approval).toMatchObject({ sessionId: "sess_1", workspace: "shop", category: "write", toolName: "fs_write" });
    expect(approval.summary).toBe("src/app.ts");

    expect(bridge.decide(approval.id, "allow", { by: "mobile" })).toBe(true);
    expect(await pending).toEqual({ kind: "allow" });
    expect(bridge.approvals.pending()).toHaveLength(0);
  });

  it("maps a preset deny reason into the answer the agent sees", async () => {
    const pending = link.ask(shellAsk("toolu_shell_1"));
    const approval = await waitFor(() => bridge.targetApproval());
    expect(approval).toMatchObject({ category: "shell", toolName: "run_command" });
    expect(approval.summary).toBe("npm install left-pad");

    expect(bridge.decide(approval.id, "deny", { by: "mobile", reasonIndex: 0 })).toBe(true);
    const decision = await pending;
    expect(decision?.kind).toBe("deny");
    expect(decision?.reason).toContain("Explain your plan first");
  });

  it("leaves the prompt to Kiro when the deck decides in Kiro", async () => {
    const pending = link.ask(writeAsk("toolu_write_2"));
    const approval = await waitFor(() => bridge.targetApproval());
    expect(bridge.decide(approval.id, "ask", { by: "mobile" })).toBe(true);
    expect(await pending).toMatchObject({ kind: "ask" }); // the companion ignores "ask" and leaves Kiro's dialog
  });

  it("answers nothing when Kiro resolves the ask itself", async () => {
    const ask = shellAsk("toolu_shell_2");
    const pending = link.ask(ask);
    await waitFor(() => bridge.targetApproval());
    link.cancel(ask.toolCallId, ask.consentRound); // Kiro's own dialog answered it
    expect(await pending).toBeUndefined();
    await waitFor(() => (bridge.approvals.pending().length === 0 ? true : undefined));
  });

  it("shows a prompt from a session the hooks never reported, and drops it with the prompt", async () => {
    const pending = link.ask({ ...writeAsk("toolu_write_4"), sessionId: "sess_nohooks" });
    const approval = await waitFor(() => bridge.targetApproval());
    expect(bridge.inbox().map((i) => `${i.session.id}:${i.attention.kind}`)).toContain("sess_nohooks:approval");
    expect(bridge.sessionAt(0)).toMatchObject({ id: "sess_nohooks", workspace: "shop", surface: "ide", promptOnly: true });
    expect(bridge.clear("sess_nohooks")).toBe("busy"); // its approval keeps its key

    expect(bridge.decide(approval.id, "allow", { by: "mobile" })).toBe(true);
    expect(await pending).toEqual({ kind: "allow" });
    await waitFor(() => (bridge.registry.get("sess_nohooks") ? undefined : true));
  });

  it("denies a native ask under lockdown without queuing it", async () => {
    await bridge.setLockdown(true);
    expect(await link.ask(writeAsk("toolu_write_3"))).toEqual({ kind: "deny", reason: LOCKDOWN_REASON });
    expect(bridge.approvals.pending()).toHaveLength(0);
    await bridge.setLockdown(false);
  });

  it("takes context use only for sessions on the deck", async () => {
    bridge.registry.ingest({ hook_event_name: "UserPromptSubmit", session_id: "sess_ctx", cwd: "/Users/me/shop" }, IDE, Date.now());
    expect(await link.context(4242, "sess_ctx", 41.26)).toBe(true);
    expect(bridge.registry.get("sess_ctx")?.contextPercent).toBe(41.3);
    expect(await link.context(4242, "sess_unknown", 10)).toBe(false);
    expect(bridge.registry.get("sess_unknown")).toBeUndefined();
  });

  it("reads an IDE session's settings, then enables changes after the hub probe", async () => {
    const workspace = join(home, "live-shop");
    const sessionId = "sess_live-settings";
    mkdirSync(workspace, { recursive: true });
    const canonicalWorkspace = realpathSync(workspace);
    const hash = createHash("sha256").update(canonicalWorkspace).digest("hex").slice(0, 16);
    const sessionDir = join(kiroSessionsDir, hash, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const sessionJson = join(sessionDir, "session.json");
    writeFileSync(
      sessionJson,
      JSON.stringify({ id: sessionId, workspacePaths: [canonicalWorkspace], modelId: "gpt-5.6-sol", effortLevel: "xhigh", autopilot: true, contextSnapshotModelDisplay: { display: "GPT 5.6 Sol" } }),
    );
    bridge.registry.ingest({ hook_event_name: "SessionStart", session_id: sessionId, cwd: workspace }, IDE, Date.now());

    const received: CompanionCommand[] = [];
    let opened = false;
    const close = link.commands(
      { pid: 4242, version: "0.5.0", folders: [workspace] },
      { onOpen: () => void (opened = true), onCommand: (command) => void received.push(command), onClose: () => undefined },
    );
    await waitFor(() => (opened ? true : undefined));
    bridge.companions.claim(4242, sessionId);
    expect(await bridge.focus(sessionId)).toBe(true);
    await waitFor(() => (bridge.settingsTarget()?.model?.value === "gpt-5.6-sol" ? true : undefined));
    expect(bridge.settingsTarget()).toMatchObject({ effort: "xhigh", autopilot: true, writableSettings: [] });

    const probe = (await waitFor(() => received.find((command) => command.kind === "set_config"))) as Extract<(typeof received)[number], { kind: "set_config" }>;
    const options = (effort: string, autopilot = "on") => [
      { type: "select", id: "model", currentValue: "gpt-5.6-sol", options: [{ value: "auto", name: "Auto" }, { value: "gpt-5.6-sol", name: "GPT 5.6 Sol" }] },
      { type: "select", id: "effortLevel", currentValue: effort, options: [{ value: "high", name: "High" }, { value: "xhigh", name: "Extra high" }] },
      { type: "select", id: "autopilot", currentValue: autopilot, options: [{ value: "on", name: "Autopilot" }, { value: "off", name: "Supervised" }] },
    ];
    await link.configResult(4242, probe.requestId, { ok: true, configOptions: options("xhigh") });
    await waitFor(() => (bridge.settingsTarget()?.writableSettings.length === 3 ? true : undefined));

    const changed = bridge.settingsSet("effortLevel", "high", sessionId);
    const command = (await waitFor(() => received.filter((item) => item.kind === "set_config")[1])) as Extract<(typeof received)[number], { kind: "set_config" }>;
    await link.configResult(4242, command.requestId, { ok: true, configOptions: options("high") });
    expect(await changed).toMatchObject({ effort: "high", writableSettings: ["model", "effortLevel", "autopilot"] });
    expect(JSON.parse(readFileSync(sessionJson, "utf8")).effortLevel).toBe("xhigh"); // bridge never writes Kiro's file

    const supervised = bridge.settingsSet("autopilot", "off", sessionId);
    const restored = bridge.settingsSet("autopilot", "on", sessionId);
    const firstAutonomy = (await waitFor(() => received.filter((item) => item.kind === "set_config")[2])) as Extract<(typeof received)[number], { kind: "set_config" }>;
    expect(received.filter((item) => item.kind === "set_config")).toHaveLength(3); // the second write waits for the first
    await link.configResult(4242, firstAutonomy.requestId, { ok: true, configOptions: options("high", "off") });
    expect(await supervised).toMatchObject({ autopilot: false });
    const secondAutonomy = (await waitFor(() => received.filter((item) => item.kind === "set_config")[3])) as Extract<(typeof received)[number], { kind: "set_config" }>;
    await link.configResult(4242, secondAutonomy.requestId, { ok: true, configOptions: options("high", "on") });
    expect(await restored).toMatchObject({ autopilot: true });

    bridge.ideSettings.applyConfigOptions(sessionId, [
      ...options("high").slice(0, 2),
      { type: "select", id: "autopilot", currentValue: "on", options: [{ value: "on", name: "Autopilot" }] },
    ]);
    await expect(bridge.settingsSet("autopilot", "off", sessionId)).rejects.toThrow("not a autopilot Kiro offers");

    bridge.ideSettings.applyConfigOptions(sessionId, options("high"));
    const firstOwnerWrite = bridge.settingsSet("effortLevel", "xhigh", sessionId);
    const staleQueuedWrite = bridge.settingsSet("effortLevel", "high", sessionId);
    const firstRejected = expect(firstOwnerWrite).rejects.toThrow("another window");
    const queuedRejected = expect(staleQueuedWrite).rejects.toThrow("changed windows");
    await waitFor(() => received.filter((item) => item.kind === "set_config")[4]);
    const secondReceived: CompanionCommand[] = [];
    let secondOpened = false;
    const closeSecond = link.commands(
      { pid: 5252, version: "0.5.0", folders: [workspace] },
      { onOpen: () => void (secondOpened = true), onCommand: (command) => void secondReceived.push(command), onClose: () => undefined },
    );
    await waitFor(() => (secondOpened ? true : undefined));
    expect(await link.context(5252, sessionId, 20)).toBe(true); // ownership transfers while two writes wait
    await firstRejected;
    await queuedRejected;
    const newOwnerProbe = (await waitFor(() => secondReceived.find((item) => item.kind === "set_config"))) as Extract<CompanionCommand, { kind: "set_config" }>;
    expect(newOwnerProbe).toMatchObject({ configId: "model", value: "gpt-5.6-sol" });
    await link.configResult(5252, newOwnerProbe.requestId, { ok: true, configOptions: options("high") });
    await waitFor(() => (bridge.settingsTarget()?.writableSettings.length === 3 ? true : undefined));

    closeSecond();
    close();
    await waitFor(() => (bridge.companions.list().length === 0 ? true : undefined));
  });

  it("asks the window's companion to show the chat or terminal of a pressed Session key", async () => {
    const lines: unknown[] = [];
    let opened = false;
    let closedWith = "";
    const close = link.commands(
      { pid: 4242, version: "0.4.0", folders: ["/Users/me/shop"] },
      { onOpen: () => void (opened = true), onCommand: (c) => void lines.push(c), onClose: (r) => void (closedWith = r) },
    );
    await waitFor(() => (opened && bridge.companions.list().length === 1 ? true : undefined));
    const other = link.commands({ pid: 5151, version: "0.4.0", folders: ["/Users/me/other"] }, { onOpen: () => undefined, onCommand: (c) => void lines.push({ wrong: c }), onClose: () => undefined });
    await waitFor(() => (bridge.companions.list().length === 2 ? true : undefined));

    bridge.registry.ingest({ hook_event_name: "UserPromptSubmit", session_id: "sess_ctx", cwd: "/Users/me/shop" }, IDE, Date.now());
    commands.length = 0;
    expect(await bridge.focus("sess_ctx")).toBe(true);
    expect(bridge.settingsTarget()).toMatchObject({ id: "sess_ctx", metadataAvailable: false });
    expect(bridge.settingsModels()).toEqual([]); // selected session with unavailable metadata stays blank despite configured model slots
    expect(commands[0]).toEqual({ cmd: "/usr/bin/open", args: ["-b", "dev.kiro.desktop", "/Users/me/shop"] }); // raises the window
    await waitFor(() => (lines.length ? true : undefined));
    expect(lines).toEqual([{ kind: "focus", sessionId: "sess_ctx" }]); // then the window shows the chat

    // kiro-cli in Kiro's integrated terminal: the window whose folder holds it brings that terminal forward.
    const CLI_IN_KIRO = { ...IDE, surface: "cli" as const, tty: "ttys009", pid: 777 };
    bridge.registry.ingest({ hook_event_name: "UserPromptSubmit", session_id: "cli_1", cwd: "/Users/me/shop/api" }, CLI_IN_KIRO, Date.now());
    expect(await bridge.focus("cli_1")).toBe(true);
    expect(bridge.settingsTarget()?.id).toBe("sess_ctx"); // CLI focus does not discard the IDE/deck settings target
    await waitFor(() => (lines.length === 2 ? true : undefined));
    expect(lines[1]).toEqual({ kind: "terminal", tty: "ttys009" });

    other();
    close();
    await waitFor(() => (bridge.companions.list().length === 0 ? true : undefined));
    expect(closedWith).toBe("");
  });

  it("round-trips a live session setting through its owning companion", async () => {
    const received: unknown[] = [];
    let opened = false;
    const close = link.commands(
      { pid: 4242, version: "0.5.0", folders: ["/Users/me/shop"] },
      { onOpen: () => void (opened = true), onCommand: (command) => void received.push(command), onClose: () => undefined },
    );
    await waitFor(() => (opened && bridge.companions.list().length === 1 ? true : undefined));
    await expect(bridge.companions.requestConfig("sess_cfg", "effortLevel", "high")).rejects.toThrow("claimed");
    bridge.companions.claim(4242, "sess_cfg");

    const pending = bridge.companions.requestConfig("sess_cfg", "effortLevel", "high");
    const command = (await waitFor(() => received[0])) as { requestId: string };
    expect(command).toMatchObject({ kind: "set_config", sessionId: "sess_cfg", configId: "effortLevel", value: "high" });
    expect(command.requestId).toMatch(/^config-[0-9a-f-]{36}$/);
    const configOptions = [{ type: "select", id: "effortLevel", currentValue: "high", options: [{ value: "high", name: "High" }] }];
    expect(await link.configResult(5151, command.requestId, { ok: true, configOptions })).toBe(false);
    expect(await link.configResult(4242, command.requestId, { ok: true, configOptions })).toBe(true);
    expect(await pending).toEqual({ ok: true, configOptions });

    bridge.companions.claim(4242, "sess_gone");
    const abandoned = bridge.companions.requestConfig("sess_gone", "model", "auto");
    await waitFor(() => received[1]);
    bridge.companions.forgetSession("sess_gone");
    await expect(abandoned).rejects.toThrow("session ended");

    close();
    await waitFor(() => (bridge.companions.list().length === 0 ? true : undefined));
  });

  it("refuses a command stream without a usable hello", async () => {
    const reason = await new Promise<string>((resolve) => {
      link.commands({ pid: 0, version: "x", folders: [] }, { onOpen: () => resolve("opened"), onCommand: () => undefined, onClose: resolve });
    });
    expect(reason).toBe("bridge answered 400");
  });

  it("writes each decision to the audit trail", () => {
    const file = readdirSync(paths.data).find((f) => f.startsWith("events-"))!;
    const decisions = readFileSync(join(paths.data, file), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === "Decision");
    expect(decisions.map((d) => `${d.decision}:${d.by}`)).toEqual(
      expect.arrayContaining(["allow:mobile", "deny:mobile", "ask:mobile", "ask:cancelled"]),
    );
    expect(decisions.find((d) => d.decision === "allow")).toMatchObject({ category: "write", tool: "fs_write", workspace: "shop" });
  });
});
