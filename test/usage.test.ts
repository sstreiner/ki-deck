import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpConnection } from "../src/bridge/acp";
import { silentLogger } from "../src/bridge/logger";
import { ledgerFile, summarizeLedger, Today } from "../src/bridge/today";
import {
  parseUsage,
  planLabel,
  USAGE_RETRY_MS,
  USAGE_TICK_MS,
  UsageClient,
  UsageMonitor,
  type ClientOptions,
  type UsageSnapshot,
} from "../src/bridge/usage";
import { formatCount, formatResetDate, renderToday, renderUsage, usageColor } from "../src/render/tiles";

// What `_kiro/account/getUsage` returned for a Kiro Pro Max account (kiro-cli 3.0.0).
const GET_USAGE = {
  success: true,
  message: "Plan: KIRO PRO MAX | 1 usage breakdowns",
  data: {
    planName: "KIRO PRO MAX",
    billingCycleReset: "2026-12-01",
    overagesEnabled: true,
    isEnterprise: true,
    usageBreakdowns: [
      {
        resourceType: "CREDIT",
        displayName: "Credits",
        used: 2826.17,
        limit: 5000,
        percentage: 56,
        currentOverages: 0,
        overageRate: 0.04,
        overageCharges: 0,
        currency: "USD",
        hasLimit: true,
      },
    ],
    bonusCredits: [],
    addOnCredits: [],
    overageCapable: true,
  },
};

const tmp = mkdtempSync(join(tmpdir(), "sdk-usage-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("parseUsage", () => {
  it("reads plan, credits and reset date", () => {
    expect(parseUsage(GET_USAGE)).toEqual({
      plan: "Pro Max",
      resetDate: "2026-12-01",
      credits: { used: 2826.17, limit: 5000, percent: 56, overageCharges: 0, currency: "USD" },
      overagesEnabled: true,
      managedByAdmin: false,
    });
  });

  it("computes the percentage when Kiro leaves it out, and drops the limit when there is none", () => {
    const breakdown = (b: object) => ({ success: true, data: { planName: "KIRO FREE", usageBreakdowns: [b] } });
    expect(parseUsage(breakdown({ resourceType: "CREDIT", used: 25, limit: 50, hasLimit: true })).credits?.percent).toBe(50);
    expect(parseUsage(breakdown({ resourceType: "CREDIT", used: 25, hasLimit: false })).credits).toEqual({
      used: 25,
      overageCharges: 0,
      currency: "USD",
    });
  });

  it("treats a success without data as an account whose usage an admin manages", () => {
    expect(parseUsage({ success: true, message: "managed" })).toEqual({ plan: "Managed by admin", overagesEnabled: false, managedByAdmin: true });
  });

  it("throws Kiro's message when the call failed", () => {
    expect(() => parseUsage({ success: false, message: "Not logged in" })).toThrow("Not logged in");
    expect(() => parseUsage(null)).toThrow("Kiro did not return usage");
  });

  it("turns plan names into labels", () => {
    expect(["KIRO PRO MAX", "KIRO PRO+", "KIRO FREE", "Kiro", ""].map(planLabel)).toEqual(["Pro Max", "Pro+", "Free", "Kiro", "Kiro"]);
  });
});

// A stand-in for `kiro-cli acp`: answers initialize and getUsage like kiro-cli 3.0.0, and
// first asks the client something, which the client must refuse.
const FAKE_AGENT = `
const readline = require("node:readline");
const mode = process.argv[2];
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
if (mode === "exit") { process.stderr.write("error: you are not logged in\\n"); process.exit(3); }
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === 99) { console.error("client answered: " + JSON.stringify(m.error)); return; }
  if (mode === "silent") return;
  if (m.method === "initialize") {
    process.stdout.write("not json\\n");
    send({ jsonrpc: "2.0", method: "session/update", params: {} });
    send({ jsonrpc: "2.0", id: 99, method: "fs/read_text_file", params: { path: "/etc/hosts" } });
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (m.method === "_kiro/account/getUsage" && mode === "refused") {
    send({ jsonrpc: "2.0", id: m.id, result: { success: false, message: "Not logged in" } });
  } else if (m.method === "_kiro/account/getUsage") {
    send({ jsonrpc: "2.0", id: m.id, result: ${JSON.stringify(GET_USAGE)} });
  } else {
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
  }
});
`;
const agentScript = join(tmp, "fake-agent.cjs");
writeFileSync(agentScript, FAKE_AGENT);
const agent = (mode = "ok") => ({ command: process.execPath, args: [agentScript, mode] });

/** One fetch on a fresh client, closed afterwards. */
async function fetchOnce(options: ClientOptions): Promise<UsageSnapshot> {
  const client = new UsageClient(options);
  try {
    return await client.fetch();
  } finally {
    client.close();
  }
}

describe("UsageClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fetches usage through initialize and the Kiro extension method, then keeps kiro-cli running", async () => {
    const spawn = vi.spyOn(AcpConnection, "spawn");
    const client = new UsageClient({ ...agent(), timeoutMs: 5000 });
    try {
      expect((await client.fetch()).credits?.percent).toBe(56);
      expect((await client.fetch()).credits?.used).toBe(2826.17);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(client.connected).toBe(true);
    } finally {
      client.close();
    }
    expect(client.connected).toBe(false);
  });

  it("stops kiro-cli when idle and starts it again on the next fetch", async () => {
    const spawn = vi.spyOn(AcpConnection, "spawn");
    const client = new UsageClient({ ...agent(), timeoutMs: 5000, idleCloseMs: 100 });
    try {
      await client.fetch();
      await vi.waitFor(() => expect(client.connected).toBe(false), { timeout: 2000 });
      await client.fetch();
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      client.close();
    }
  });

  it("keeps the connection when Kiro answers with an error of its own", async () => {
    const client = new UsageClient({ ...agent("refused"), timeoutMs: 5000 });
    try {
      await expect(client.fetch()).rejects.toThrow("Not logged in");
      expect(client.connected).toBe(true);
    } finally {
      client.close();
    }
  });

  it("refuses requests from the agent and maps JSON-RPC errors", async () => {
    const acp = AcpConnection.spawn(process.execPath, [agentScript, "ok"]);
    try {
      await acp.request("initialize", {}, 5000);
      await expect(acp.request("session/new", {}, 5000)).rejects.toMatchObject({ name: "AcpError", code: -32601 });
      // stderr is a separate pipe, so the agent's note can arrive after its stdout reply.
      await vi.waitFor(() => expect(acp.stderr).toContain('client answered: {"code":-32601'), { timeout: 2000 });
    } finally {
      acp.close();
    }
    await expect(acp.request("initialize", {}, 5000)).rejects.toThrow("connection closed");
  });

  it("reports the agent's last stderr line when it exits", async () => {
    await expect(fetchOnce({ ...agent("exit"), timeoutMs: 5000 })).rejects.toThrow("agent exited (code 3): error: you are not logged in");
  });

  it("times out when the agent does not answer, and starts a new one next time", async () => {
    const spawn = vi.spyOn(AcpConnection, "spawn");
    const client = new UsageClient({ ...agent("silent"), timeoutMs: 300 });
    try {
      await expect(client.fetch()).rejects.toThrow("initialize timed out");
      expect(client.connected).toBe(false);
      await expect(client.fetch()).rejects.toThrow("initialize timed out");
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      client.close();
    }
  });

  it("fails when the command does not exist", async () => {
    await expect(fetchOnce({ command: join(tmp, "no-such-kiro-cli"), timeoutMs: 5000 })).rejects.toThrow("could not start");
  });
});

describe("UsageMonitor", () => {
  const snapshot: UsageSnapshot = parseUsage(GET_USAGE);
  const timing = { activeMs: 15_000, idleMs: 10 * 60_000 };
  let clock = 0;
  let calls = 0;
  let active = false;
  let result: () => Promise<UsageSnapshot>;
  let changes = 0;
  const monitor = () =>
    new UsageMonitor(
      () => {
        calls++;
        return result();
      },
      () => timing,
      () => active,
      () => clock,
      () => changes++,
      silentLogger,
    );
  /** Moves the clock and the fake timers forward together. */
  const pass = async (ms: number) => {
    for (let t = 0; t < ms; t += 1000) {
      clock += 1000;
      await vi.advanceTimersByTimeAsync(1000);
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000_000;
    calls = 0;
    changes = 0;
    active = false;
    result = async () => snapshot;
  });
  afterEach(() => vi.useRealTimers());

  it("fetches when the first key appears, then every idle interval while no agent works", async () => {
    const m = monitor();
    m.watch();
    m.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(m.state).toMatchObject({ snapshot, fetchedAt: clock, fetching: false });

    await pass(9 * 60_000);
    expect(calls).toBe(1);
    await pass(60_000 + USAGE_TICK_MS);
    expect(calls).toBe(2);

    m.unwatch();
    m.unwatch();
    expect(m.watched).toBe(false);
    await pass(30 * 60_000);
    expect(calls).toBe(2);
  });

  it("refreshes every active interval while an agent works", async () => {
    const m = monitor();
    m.watch();
    await vi.advanceTimersByTimeAsync(0);
    active = true;
    await pass(60_000);
    // At most one tick late: every 15 to 17 s.
    expect(calls).toBeGreaterThanOrEqual(1 + 3);
    expect(calls).toBeLessThanOrEqual(1 + 4);
    m.stop();
  });

  it("refreshes shortly after a nudge (a turn ended), even when not due", async () => {
    const m = monitor();
    m.nudge(3000); // ignored: no key shows usage
    m.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    m.nudge(3000);
    m.nudge(10_000); // the earlier one wins
    await pass(2000);
    expect(calls).toBe(1);
    await pass(USAGE_TICK_MS);
    expect(calls).toBe(2);
    await pass(10_000);
    expect(calls).toBe(2);
    m.stop();
  });

  it("joins a fetch that is already running", async () => {
    let finish!: (s: UsageSnapshot) => void;
    result = () => new Promise((resolve) => (finish = resolve));
    const m = monitor();
    const a = m.refresh();
    const b = m.refresh();
    expect(m.state.fetching).toBe(true);
    finish(snapshot);
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(calls).toBe(1);
    expect(changes).toBe(2); // fetching, then done
  });

  it("keeps the last snapshot on errors and retries no sooner than a minute later, even while active", async () => {
    const m = monitor();
    await m.refresh();
    result = async () => {
      throw new Error("kiro-cli not found");
    };
    clock += 10 * 60_000;
    expect(await m.refresh()).toBe(false);
    expect(m.state).toMatchObject({ snapshot, error: "kiro-cli not found", errorAt: clock, fetching: false });

    active = true;
    m.watch(); // the error is fresh, so no immediate retry
    await pass(USAGE_RETRY_MS - 1000);
    expect(calls).toBe(2);
    await pass(USAGE_TICK_MS + 1000);
    expect(calls).toBe(3);
    m.stop();

    result = async () => snapshot;
    expect(await m.refresh()).toBe(true);
    expect(m.state.error).toBeUndefined();
  });
});

describe("today", () => {
  const lines = [
    { event: "SessionStart", session: "a" },
    { event: "UserPromptSubmit", session: "a" },
    { event: "PreToolUse", session: "a", tool: "read_file" },
    { event: "PreToolUse", session: "b", tool: "execute_bash" },
    { event: "Stop", session: "a", turnMs: 90_000 },
    { event: "Stop", session: "b" },
    { event: "Decision", session: "c", decision: "allow" },
    { event: "Decision", session: "c", decision: "deny" },
    { event: "Decision", session: "c", decision: "ask" },
  ];

  it("summarizes a ledger file and skips broken lines", () => {
    const text = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n{"event":"Stop"\n\n`;
    expect(summarizeLedger(text)).toEqual({ sessions: 2, prompts: 1, turns: 2, toolCalls: 2, turnMs: 90_000, allowed: 1, denied: 1 });
  });

  it("names the ledger file by local date", () => {
    expect(ledgerFile("/d", new Date(2026, 10, 9, 23, 59))).toBe("/d/events-2026-11-09.jsonl");
  });

  it("starts from today's file, then counts live, and starts over at midnight", async () => {
    let clock = new Date(2026, 10, 10, 23, 59).getTime();
    const today = new Today(tmp, () => clock);
    await today.load(); // no file yet
    expect(today.value).toMatchObject({ turns: 0, sessions: 0 });

    writeFileSync(ledgerFile(tmp, new Date(clock)), `${JSON.stringify(lines[4])}\n`);
    await today.load();
    expect(today.value).toMatchObject({ turns: 1, sessions: 1, turnMs: 90_000 });
    today.add({ event: "PreToolUse", session: "b" }, new Date(clock));
    today.add({ event: "Decision", session: "b", decision: "allow" }, new Date(clock));
    expect(today.value).toMatchObject({ turns: 1, sessions: 2, toolCalls: 1, allowed: 1 });

    clock += 2 * 60_000; // past midnight
    expect(today.value).toMatchObject({ turns: 0, sessions: 0, toolCalls: 0 });
    today.add({ event: "Stop", session: "a", turnMs: 1000 }, new Date(clock));
    expect(today.value).toMatchObject({ turns: 1, sessions: 1, turnMs: 1000 });
  });
});

describe("usage tiles", () => {
  const now = new Date(2026, 10, 10, 15);

  it("colors by how much is used", () => {
    expect([10, 69.9, 70, 89, 90, 120].map(usageColor)).toEqual(["#1a7f37", "#1a7f37", "#d29922", "#d29922", "#d1242f", "#d1242f"]);
  });

  it("formats counts and reset dates", () => {
    expect([2826.17, 9999, 12_400, 250_000].map(formatCount)).toEqual(["2,826", "9,999", "12.4k", "250k"]);
    expect(formatResetDate("2026-11-10", now)).toBe("today");
    expect(formatResetDate("2026-11-11", now)).toBe("tomorrow");
    expect(formatResetDate("2026-11-14", now)).toBe("in 4 days");
    expect(formatResetDate("2026-12-01", now)).toBe("Dec 1");
    expect(formatResetDate("soon", now)).toBe("soon");
  });

  it("draws credits, overage charges and the stale marker", () => {
    const view = { plan: "Pro Max", used: 2826.17, limit: 5000, percent: 56, resetDate: "2026-12-01", fetching: false, stale: false };
    const svg = renderUsage(view, now);
    expect(svg).toContain("56%");
    expect(svg).toContain("2,826 / 5,000");
    expect(svg).toContain("resets Dec 1");
    expect(svg).toContain("Pro Max");
    const over = renderUsage({ ...view, percent: 104, overageCharges: 9.6, currency: "USD", stale: true }, now);
    expect(over).toContain("+$9.60");
    expect(over).toContain(">old<");
    expect(over).toContain("A31 31 0 1 1 71.99 35.00"); // the ring stops at full
  });

  it("says why there are no numbers", () => {
    expect(renderUsage({ fetching: true, stale: false }, now)).toContain("loading…");
    const failed = renderUsage({ error: "kiro-cli not found", fetching: false, stale: false }, now);
    expect(failed).toContain("unavailable");
    expect(failed).toContain("press to retry");
  });

  it("draws today's activity", () => {
    const svg = renderToday({ turns: 1, toolCalls: 12, turnMs: 3_900_000, allowed: 2, denied: 1 });
    expect(svg).toContain("1 turn<");
    expect(svg).toContain("12 tools");
    expect(svg).toContain("1h05 working");
    expect(svg).toContain(">2<"); // allowed, next to a green check
    expect(svg).toContain(">1<"); // denied, next to a red cross
  });
});
