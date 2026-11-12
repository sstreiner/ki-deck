// The approval flow end to end: the real hooks/kd-hook gate waits on a running bridge,
// and the bridge's decide/lockdown commands (what the keys call) answer it.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bridge, bridgePaths, LOCKDOWN_REASON } from "../src/bridge";
import { silentLogger } from "../src/bridge/logger";
import type { RunResult } from "../src/bridge/system";

const KD_HOOK = join(import.meta.dirname, "..", "hooks", "kd-hook");
const home = mkdtempSync(join(tmpdir(), "sdk-approvals-"));
const paths = bridgePaths(home);
const commands: Array<{ cmd: string; args: string[] }> = [];

const bridge = new Bridge({
  version: "test",
  logger: silentLogger,
  paths,
  bins: {},
  isAlive: () => true,
  tickMs: 60_000,
  run: async (cmd, args): Promise<RunResult> => {
    commands.push({ cmd, args });
    return { ok: true, stdout: "", stderr: "" };
  },
});

const IDE_ENV = { __CFBundleIdentifier: "dev.kiro.desktop" };
let n = 0;

interface Gate {
  child: ChildProcess;
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

/** Starts `kd-hook gate shell` for a fresh tool call, as Kiro would. */
function gate(command: string, session = "s1"): Gate {
  // detached, like Kiro: the hook gets its own process group, which Kiro kills as a whole
  const child = spawn(KD_HOOK, ["gate", "shell"], {
    detached: true,
    env: { PATH: process.env.PATH ?? "", HOME: home, KI_DECK_HOME: home, ...IDE_ENV },
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => (stdout += d));
  child.stderr?.on("data", (d) => (stderr += d));
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, stdout, stderr })),
  );
  child.stdin?.end(
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: session,
      cwd: "/Users/me/shop",
      tool_name: "execute_bash",
      tool_input: { command: `${command} #${n++}` },
    }),
  );
  return { child, done };
}

async function waitFor<T>(probe: () => T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const waitingApproval = () => waitFor(() => bridge.targetApproval());

beforeAll(async () => {
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "gated"), "shell\n");
  writeFileSync(
    paths.config,
    JSON.stringify({ gate: { timeoutSeconds: 2, onTimeout: "ask" }, notifications: { quietHours: "" }, ledger: { storeRaw: true } }),
  );
  await bridge.start();
});

afterAll(async () => {
  await bridge.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("approvals through kd-hook", () => {
  it("holds a gated call until Allow, then lets Kiro continue", async () => {
    const g = gate("npm test");
    const approval = await waitingApproval();
    expect(approval).toMatchObject({ sessionId: "s1", workspace: "shop", category: "shell", toolName: "execute_bash" });
    expect(approval.summary).toMatch(/^npm test/);
    expect(bridge.attention(bridge.registry.get("s1")!)).toMatchObject({ kind: "approval" });

    expect(bridge.decide(approval.id, "allow", { by: "mobile" })).toBe(true);
    expect(await g.done).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(bridge.approvals.pending()).toHaveLength(0);
  });

  it("notifies when a call starts waiting, even in quiet hours", async () => {
    commands.length = 0;
    const g = gate("make deploy");
    const approval = await waitingApproval();
    await waitFor(() => commands.find((c) => c.cmd === "/usr/bin/osascript"));
    expect(commands.find((c) => c.cmd === "/usr/bin/osascript")?.args[3]).toMatch(/^Wants to run shell: make deploy/);
    bridge.decide(approval.id, "allow", { by: "test" });
    await g.done;
  });

  it("denies with a preset reason the agent sees, and never answers twice", async () => {
    const g = gate("npm install left-pad");
    const approval = await waitingApproval();
    expect(bridge.decide(approval.id, "deny", { by: "mobile", reasonIndex: 0 })).toBe(true);
    expect(bridge.decide(approval.id, "allow", { by: "mobile" })).toBe(false);
    const result = await g.done;
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("The user denied this on Stream Deck: Explain your plan first");
    expect(bridge.registry.get("s1")?.pending).toHaveLength(0);
  });

  it("hands the call to Kiro's prompt and focuses the window for Decide in Kiro", async () => {
    commands.length = 0;
    const g = gate("rm -rf build");
    const approval = await waitingApproval();
    bridge.decide(approval.id, "ask", { by: "mobile" });
    const result = await g.done;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "The user chose to decide in Kiro." },
    });
    // The test runner has a terminal, so this session counts as CLI and focus activates its app.
    await waitFor(() => commands.find((c) => c.cmd === "/usr/bin/open"));
  });

  it("answers the oldest call first", async () => {
    const first = gate("echo first");
    const firstApproval = await waitingApproval();
    const second = gate("echo second");
    await waitFor(() => (bridge.approvals.pending().length === 2 ? true : undefined));
    expect(bridge.targetApproval()?.id).toBe(firstApproval.id);
    bridge.decide(firstApproval.id, "allow", { by: "test" });
    expect(bridge.targetApproval()?.summary).toMatch(/^echo second/);
    bridge.decide(bridge.targetApproval()!.id, "allow", { by: "test" });
    await Promise.all([first.done, second.done]);
  });

  it("falls back to Kiro's prompt when nobody answers in time", async () => {
    const result = await gate("sleep 1").done;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/Nobody answered/);
  }, 10_000);

  it("drops the request when Kiro stops waiting", async () => {
    const g = gate("long thing");
    await waitingApproval();
    process.kill(-g.child.pid!, "SIGTERM"); // what Kiro does when the turn is cancelled or the hook times out
    await g.done;
    await waitFor(() => (bridge.approvals.pending().length === 0 ? true : undefined));
  });

  it("lockdown denies what is waiting and blocks new calls without the bridge", async () => {
    const g = gate("curl example.com");
    await waitingApproval();
    await bridge.setLockdown(true);
    expect(existsSync(paths.lockdown)).toBe(true);
    const waiting = await g.done;
    expect(waiting.code).toBe(2);
    expect(waiting.stderr).toContain(LOCKDOWN_REASON);

    const blocked = await gate("curl example.com").done; // kd-hook itself refuses
    expect(blocked.code).toBe(2);
    expect(bridge.approvals.pending()).toHaveLength(0);

    await bridge.setLockdown(false);
    expect(existsSync(paths.lockdown)).toBe(false);
  });

  it("writes every decision to the audit trail", () => {
    const file = readdirSync(paths.data).find((f) => f.startsWith("events-"))!;
    const decisions = readFileSync(join(paths.data, file), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === "Decision");
    expect(decisions.map((d) => `${d.decision}:${d.by}`)).toEqual(
      expect.arrayContaining(["allow:mobile", "deny:mobile", "ask:mobile", "ask:timeout", "ask:cancelled", "deny:lockdown"]),
    );
    expect(decisions[0]).toMatchObject({ category: "shell", tool: "execute_bash", workspace: "shop" });
    expect(typeof decisions[0].waitMs).toBe("number");
  });
});
