// End to end: the real hooks/kd-hook script talks to a running bridge over a temporary socket.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bridge, bridgePaths } from "../src/bridge";
import { silentLogger } from "../src/bridge/logger";
import type { RunResult } from "../src/bridge/system";

const KD_HOOK = join(import.meta.dirname, "..", "hooks", "kd-hook");
const home = mkdtempSync(join(tmpdir(), "sdk-"));
const paths = bridgePaths(home);
const commands: Array<{ cmd: string; args: string[] }> = [];
let clock = 1_000_000;

const bridge = new Bridge({
  version: "test",
  logger: silentLogger,
  paths,
  now: () => clock,
  bins: {},
  isAlive: () => true,
  tickMs: 60_000,
  run: async (cmd, args): Promise<RunResult> => {
    commands.push({ cmd, args });
    return { ok: true, stdout: "", stderr: "" };
  },
});

function hook(args: string[], event: object, env: Record<string, string> = {}, viaShell = false) {
  const command = viaShell ? ["-c", `"${KD_HOOK}" ${args.join(" ")}`] : [KD_HOOK, ...args];
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("/bin/sh", command, {
      env: { PATH: process.env.PATH ?? "", HOME: home, KI_DECK_HOME: home, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(event));
  });
}

function get(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request({ socketPath: paths.socket, path }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(JSON.parse(body)));
    })
      .on("error", reject)
      .end();
  });
}

beforeAll(async () => {
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  writeFileSync(paths.config, JSON.stringify({ notifications: { quietHours: "", minTurnSeconds: 30 } }));
  await bridge.start();
});

afterAll(async () => {
  await bridge.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("bridge with kd-hook", () => {
  const iterm = { __CFBundleIdentifier: "com.googlecode.iterm2", TERM_PROGRAM: "iTerm.app", ITERM_SESSION_ID: "w0t2p0:UUID-1" };

  it("answers health checks", async () => {
    expect(await get("/v1/health")).toMatchObject({ ok: true, version: "test" });
  });

  it("records where a CLI session runs, including the harness PID", async () => {
    const result = await hook(["observe"], { hook_event_name: "SessionStart", session_id: "cli-1", cwd: "/tmp/shop" }, iterm);
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(bridge.registry.get("cli-1")).toMatchObject({
      workspace: "shop",
      surface: "cli",
      origin: { bundle: "com.googlecode.iterm2", term: "iTerm.app", termSession: "w0t2p0:UUID-1", pid: process.pid },
    });
  });

  it("finds the harness PID when Kiro's sh -c sits in between", async () => {
    await hook(["observe"], { hook_event_name: "SessionStart", session_id: "cli-2", cwd: "/tmp/x" }, iterm, true);
    expect(bridge.registry.get("cli-2")?.origin.pid).toBe(process.pid);
  });

  it("notifies when a long turn finishes", async () => {
    await hook(["observe"], { hook_event_name: "UserPromptSubmit", session_id: "cli-1", cwd: "/tmp/shop" }, iterm);
    clock += 45_000;
    await hook(["observe"], { hook_event_name: "Stop", session_id: "cli-1", cwd: "/tmp/shop" }, iterm);
    await new Promise((r) => setTimeout(r, 50));
    const notification = commands.find((c) => c.cmd === "/usr/bin/osascript");
    expect(notification?.args.slice(2)).toEqual(["Kiro: shop", "Finished after 45s. Waiting for you.", "Glass"]);
    expect(bridge.inbox().map((i) => i.session.id)).toContain("cli-1");
  });

  it("lists sessions without tool summaries", async () => {
    await hook(["observe"], { hook_event_name: "PreToolUse", session_id: "cli-1", tool_name: "execute_bash", tool_input: { command: "echo secret" } }, iterm);
    const list = (await get("/v1/sessions")) as Array<{ id: string }>;
    expect(list.map((s) => s.id).sort()).toEqual(["cli-1", "cli-2"]);
    expect(JSON.stringify(list)).not.toContain("echo secret");
  });

  it("hands waiting gated calls to Kiro's prompt when the plugin stops", async () => {
    writeFileSync(join(home, "gated"), "shell\n");
    const pending = hook(["gate", "shell"], { hook_event_name: "PreToolUse", session_id: "cli-1", tool_name: "execute_bash" });
    for (let i = 0; i < 100 && bridge.approvals.pending().length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(bridge.approvals.pending()).toHaveLength(1);
    bridge.approvals.settleAll({ kind: "ask", reason: "Stream Deck closed. Decide in Kiro.", by: "shutdown" }); // as stop() does
    const result = await pending;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    rmSync(join(home, "gated"));
  });

  it("takes the terminal of kiro-cli 3.x from the TUI above its detached agent process", async () => {
    // The process chain seen live: agent node (no tty) -> bun TUI (ttys002) -> kiro-cli (ttys002).
    const bin = join(home, "fake-ps");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "ps"),
      [
        "#!/bin/sh",
        'for a; do pid=$a; done # the last argument is the pid',
        'case "$pid" in',
        '  9001) echo " 9002 ttys002  /Users/me/Library/Application Support/kiro-cli/bun" ;;',
        '  9002) echo " 9003 ttys002  kiro-cli" ;;',
        '  *) echo " 9001 ??       /Users/me/Library/Application Support/kiro-cli/node" ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}` };
    // Inside Kiro's integrated terminal the agent inherits Kiro's bundle ID: still a CLI session.
    await hook(["observe"], { hook_event_name: "SessionStart", session_id: "cli-kiro-term", cwd: "/tmp/shop" }, { ...env, __CFBundleIdentifier: "dev.kiro.desktop", TERM_PROGRAM: "kiro" });
    expect(bridge.registry.get("cli-kiro-term")).toMatchObject({ surface: "cli", origin: { tty: "ttys002", bundle: "dev.kiro.desktop", pid: process.pid } });
    // Terminal.app: the tab is found by this tty.
    await hook(["observe"], { hook_event_name: "SessionStart", session_id: "cli-terminal", cwd: "/tmp/shop" }, { ...env, __CFBundleIdentifier: "com.apple.Terminal", TERM_PROGRAM: "Apple_Terminal" });
    expect(bridge.registry.get("cli-terminal")?.origin.tty).toBe("ttys002");
  });

  it("keeps sessions whose process still runs when Stream Deck reports that Kiro quit", async () => {
    await hook(["observe"], { hook_event_name: "SessionStart", session_id: "ide-1", cwd: "/tmp/app" }, { __CFBundleIdentifier: "dev.kiro.desktop" });
    expect(bridge.registry.get("ide-1")?.origin.bundle).toBe("dev.kiro.desktop");
    bridge.applicationTerminated("dev.kiro.desktop");
    expect(bridge.registry.get("ide-1")).toBeDefined();
  });

  it("focuses an iTerm2 session with AppleScript and acknowledges it", async () => {
    commands.length = 0;
    expect(await bridge.focus("cli-1")).toBe(true);
    expect(commands[0]?.cmd).toBe("/usr/bin/osascript");
    expect(commands[0]?.args.at(-1)).toBe("UUID-1");
  });
  it("reports usage as unavailable without kiro-cli", async () => {
    expect(await bridge.usage.refresh()).toBe(false);
    expect(bridge.usage.state.error).toBe("kiro-cli not found; usage needs it");
    expect(await get("/v1/health")).not.toHaveProperty("usage");
  });
});

describe("bridge usage", () => {
  // The gate test sends no observe event, so its tool call is not counted. Five sessions: two
  // iTerm2, the two kiro-cli 3.x terminal ones and the IDE one.
  const sofar = { sessions: 5, prompts: 1, turns: 1, toolCalls: 1 };

  it("counts today's activity live, as the ledger records it", () => {
    expect(bridge.today.value).toMatchObject(sofar);
  });

  it("uses the fetcher it is given, and a new bridge starts from today's ledger file", async () => {
    const fetched = { plan: "Pro", credits: { used: 10, limit: 100, percent: 10, overageCharges: 0, currency: "USD" }, overagesEnabled: false, managedByAdmin: false };
    const b = new Bridge({ version: "test", logger: silentLogger, paths, now: () => clock, bins: {}, isAlive: () => true, fetchUsage: async () => fetched });
    expect(await b.usage.refresh()).toBe(true);
    expect(b.usage.state.snapshot).toEqual(fetched);
    await b.today.load();
    expect(b.today.value).toMatchObject(sofar);
  });

  it("reads the refresh intervals from config, with floors", () => {
    expect(bridge.usageTiming()).toEqual({ activeMs: 15_000, idleMs: 600_000 });
  });
});

describe("holding a session key", () => {
  // Straight into the registry, so the activity counts above stay as they are.
  const ide = { surface: "ide", bundle: "dev.kiro.desktop", term: "", termSession: "", tmuxPane: "", tty: "", pid: process.pid } as const;
  const event = (hook_event_name: string) => ({ hook_event_name, session_id: "ide-hold", cwd: "/tmp/app" });

  it("marks a finished turn seen first, then removes the session until its next event", () => {
    bridge.registry.ingest(event("UserPromptSubmit"), ide, clock);
    expect(bridge.clear("ide-hold")).toBe("busy"); // working: it would come straight back
    bridge.registry.ingest(event("Stop"), ide, clock + 1_000);
    expect(bridge.clear("ide-hold")).toBe("acknowledged");
    expect(bridge.clear("ide-hold")).toBe("dismissed");
    expect(bridge.registry.get("ide-hold")).toBeUndefined();
    expect(bridge.clear("ide-hold")).toBe("gone");

    bridge.registry.ingest(event("UserPromptSubmit"), ide, clock + 2_000);
    expect(bridge.registry.get("ide-hold")?.state).toBe("working");
    bridge.registry.dismiss("ide-hold");
  });
});
