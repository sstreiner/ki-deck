// Deck sessions end to end: the bridge drives a stand-in for `kiro-cli acp --agent-engine=v3`
// that speaks the protocol as kiro-cli 3.0.0 did in a live probe (session/new with config
// options, session/prompt with updates, permission requests, _session/steer, session/cancel).

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bridge, bridgePaths, DeckRefusal, LOCKDOWN_REASON } from "../src/bridge";
import { parseSettings, shortModelName, toolNameOf, turnCredits } from "../src/bridge/deck";
import { silentLogger } from "../src/bridge/logger";
import type { RunResult } from "../src/bridge/system";
import { formatCredits, renderAutonomy, renderEffort, renderModel, renderPrompt, renderStop, tileModel } from "../src/render/tiles";

const FAKE_KIRO = `
const readline = require("node:readline");
const fs = require("node:fs");
const log = process.argv[2];
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const note = (m) => fs.appendFileSync(log, JSON.stringify(m) + "\\n");
const waiting = new Map();
const sessions = new Map();
let next = 1000;
const MODELS = [
  { value: "auto", name: "Auto", _meta: { kiro: { rateMultiplier: 1 } } },
  { value: "claude-opus-5.5", name: "Claude Opus 5.5", _meta: { kiro: { rateMultiplier: 2 } } },
  { value: "claude-haiku-5.5", name: "Claude Haiku 5.5", _meta: { kiro: { rateMultiplier: 0.06 } } },
];
function options(s) {
  const out = [
    { type: "select", id: "mode", currentValue: "vibe", options: [{ value: "vibe", name: "Default" }, { value: "plan", name: "Plan" }] },
    { type: "select", id: "model", currentValue: s.model, options: MODELS },
  ];
  if (s.model !== "auto") out.push({ type: "select", id: "effortLevel", currentValue: s.effort, options: ["low", "medium", "high"].map((v) => ({ value: v, name: v })) });
  out.push({ type: "select", id: "autopilot", currentValue: s.autopilot, options: [{ value: "on", name: "Autopilot" }, { value: "off", name: "Supervised" }] });
  return out;
}
const update = (sessionId, u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const ask = (params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); send({ jsonrpc: "2.0", id, method: "session/request_permission", params }); });
async function turn(m, s) {
  const text = m.params.prompt[0].text;
  if (text === "write") {
    const path = s.cwd + "/a.txt";
    update(s.id, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Write File", kind: "edit", status: "in_progress", rawInput: { path, text: "hi" } });
    const r = await ask({ sessionId: s.id, toolCall: { toolCallId: "t1", status: "pending", title: "Write File" },
      options: [{ optionId: "accept", name: "Allow", kind: "allow_once" }, { optionId: "always-accept", name: "Always allow", kind: "allow_always" }, { optionId: "reject", name: "Deny", kind: "reject_once" }],
      _meta: { kiro: { toolId: "fs_write", consent: { capability: "fs_write", resource: path, workspaceRoot: s.cwd } } } });
    note({ answer: r.result ?? r.error });
    const ok = r.result && r.result.outcome && r.result.outcome.optionId === "accept";
    update(s.id, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: ok ? "completed" : "failed", _meta: ok ? {} : { kiro: { failureReason: "denied" } } });
  }
  if (text === "wait") {
    update(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working" } });
    await new Promise((resolve) => (s.cancel = resolve));
    update(s.id, { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "turn_completion", status: "aborted", promptTurnSummaries: [] } } });
    return send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "cancelled" } });
  }
  update(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
  update(s.id, { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "context_usage", usagePercentage: 3.5 } } });
  update(s.id, { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "turn_completion", status: "success", promptTurnSummaries: [{ unit: "credit", unitPlural: "credits", usage: 0.05 }] } } });
  send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined) { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } return; }
  note({ method: m.method, params: m.params });
  const reply = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize": return reply({ protocolVersion: 1, agentCapabilities: {} });
    case "session/new": {
      const kiro = (m.params._meta && m.params._meta.kiro) || {};
      const s = { id: "sess_" + (sessions.size + 1) + "abc", cwd: m.params.cwd, model: kiro.modelId || "auto", effort: kiro.effortLevel || "medium", autopilot: "on" };
      sessions.set(s.id, s);
      return reply({ sessionId: s.id, configOptions: options(s) });
    }
    case "session/set_config_option": {
      const s = sessions.get(m.params.sessionId);
      const key = { model: "model", effortLevel: "effort", autopilot: "autopilot" }[m.params.configId];
      if (key) s[key] = m.params.value;
      return reply({ configOptions: options(s) });
    }
    case "session/prompt": return void turn(m, sessions.get(m.params.sessionId));
    case "session/cancel": { const s = sessions.get(m.params.sessionId); if (s && s.cancel) s.cancel(); return; }
    case "_session/steer": return reply({ queued: true, messageId: "steer-1" });
    case "session/close": sessions.delete(m.params.sessionId); return reply({});
    case "_kiro/account/getUsage": return reply({ success: true, data: { planName: "KIRO PRO", usageBreakdowns: [{ resourceType: "CREDIT", used: 10, limit: 100, percentage: 10 }] } });
    default: return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
  }
});
`;

const home = mkdtempSync(join(tmpdir(), "sdk-deck-"));
const paths = bridgePaths(home);
const workspace = join(home, "shop");
const agentLog = join(home, "agent.jsonl");
const script = join(home, "fake-kiro.cjs");
writeFileSync(script, FAKE_KIRO);

const bridge = new Bridge({
  version: "test",
  logger: silentLogger,
  paths,
  bins: {},
  isAlive: () => true,
  tickMs: 50,
  run: async (): Promise<RunResult> => ({ ok: true, stdout: "", stderr: "" }),
  deckAgent: { command: process.execPath, args: [script, agentLog] },
});

/** What the fake kiro-cli received, in order. */
const received = (): Array<{ method?: string; params?: Record<string, unknown>; answer?: unknown }> =>
  readFileSync(agentLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

async function waitFor<T>(probe: () => T | undefined | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function post(path: string, body: object): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: paths.socket, path, method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

beforeAll(async () => {
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  mkdirSync(workspace);
  writeFileSync(agentLog, "");
  writeFileSync(paths.config, JSON.stringify({ notifications: { macos: false }, deck: { models: ["claude-haiku-5.5", "claude-opus-5.5", "not-offered"] } }));
  await bridge.start();
});

afterAll(async () => {
  await bridge.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("deck protocol helpers", () => {
  it("reads advertised settings with credit rates", () => {
    const settings = parseSettings([
      { type: "select", id: "model", currentValue: "auto", options: [{ value: "auto", name: "Auto", _meta: { kiro: { rateMultiplier: 1 } } }, { value: "x" }] },
      { type: "toggle", id: "ignored", currentValue: "on" },
      { type: "select", id: "broken" },
    ]);
    expect(settings).toEqual([{ id: "model", current: "auto", choices: [{ value: "auto", name: "Auto", rate: 1 }, { value: "x", name: "x" }] }]);
  });

  it("names ACP tool calls the way hooks name them", () => {
    expect(toolNameOf({ kind: "execute", title: "npm test" })).toBe("execute_bash");
    expect(toolNameOf({ kind: "edit", title: "Write File" })).toBe("fs_write");
    expect(toolNameOf({ title: "@github/create_issue" })).toBe("mcp_github_create_issue");
    expect(toolNameOf({ _meta: { kiro: { mcpTool: { identity: { serverName: "My-Server", toolName: "search" } } } } })).toBe("mcp_myserver_search");
    expect(toolNameOf({ kind: "think" })).toBe("tool");
  });

  it("draws the deck keys, dimmed without a deck session", () => {
    const shop = { workspace: "shop", working: false };
    for (const svg of [renderModel(undefined, undefined, { slot: false, current: false, presentation: false }), renderEffort(undefined, undefined, false), renderStop(undefined, false)]) {
      expect(svg).toContain("no deck");
    }
    expect(renderAutonomy(true, shop, false)).toContain("Autopilot");
    expect(renderAutonomy(false, shop, false)).toContain("Supervised");
    expect(renderEffort(undefined, shop, false)).toContain("n/a");
    const readOnly = { ...shop, metadataAvailable: true, enabled: false };
    expect(renderModel({ name: "GPT 5.6 Sol" }, readOnly, { slot: false, current: true, presentation: false })).toContain("GPT 5.6");
    expect(renderEffort("xhigh", readOnly, false)).toContain("xhigh");
    expect(renderAutonomy(true, readOnly, false)).toContain("Autopilot");
    const unavailable = { ...shop, metadataAvailable: false, enabled: false };
    expect(renderModel(undefined, unavailable, { slot: false, current: false, presentation: false })).not.toContain("no deck");
    expect(renderEffort(undefined, unavailable, false)).not.toContain("n/a");
    expect(renderAutonomy(undefined, unavailable, false)).not.toContain("Autopilot");
    expect(renderPrompt("Run the tests & fix", { ...shop, working: true }, false)).toContain("STEER");
    expect(renderPrompt("Run the tests & fix", shop, false)).toContain("&amp;");
    expect(renderPrompt("Run the tests", shop, true)).not.toContain("shop"); // presentation mode hides the workspace
  });

  it("adds up the credits of a turn and shortens model names", () => {
    expect(turnCredits({ promptTurnSummaries: [{ unit: "credit", usage: 0.03 }, { unit: "credit", usage: 0.02 }] })).toBeCloseTo(0.05);
    expect(turnCredits({ promptTurnSummaries: [] })).toBeUndefined();
    expect(shortModelName("Claude Opus 5.5")).toBe("Opus 5.5");
    expect([0.0298, 1.53, 12.4].map(formatCredits)).toEqual(["0.03 cr", "1.5 cr", "12 cr"]);
  });
});

describe("deck sessions", () => {
  let id = "";

  it("refuses folders that do not exist, and starts a Supervised session in one that does", async () => {
    await expect(bridge.deckStart("relative/path")).rejects.toBeInstanceOf(DeckRefusal);
    const view = await bridge.deckStart(workspace, { model: "claude-haiku-5.5", effort: "low" });
    id = view.id;
    expect(view).toMatchObject({ workspace: "shop", working: false, effort: "low", autopilot: false, model: { value: "claude-haiku-5.5", rate: 0.06 } });
    expect(bridge.registry.get(id)).toMatchObject({ surface: "deck", state: "idle", workspace: "shop" });
    expect(bridge.deckTarget()?.id).toBe(id);
    expect(received().find((m) => m.method === "session/new")?.params).toMatchObject({ cwd: workspace, _meta: { kiro: { modelId: "claude-haiku-5.5", effortLevel: "low" } } });
  });

  it("runs a turn: working, then done with the credits it used", async () => {
    expect(await bridge.deckPrompt("hello")).toBe("started");
    expect(bridge.registry.get(id)?.state).toBe("working");
    await waitFor(() => bridge.registry.get(id)?.state === "done");
    expect(bridge.deck.get(id)).toMatchObject({ working: false, lastTurnCredits: 0.05, totalCredits: 0.05, contextPercent: 3.5 });
    const tile = tileModel(bridge.registry.get(id)!, undefined, Date.now(), false, { model: "Haiku 5.5", credits: 0.05 });
    expect(tile).toMatchObject({ badge: "DECK", state: "done" });
    expect(tile.detail).toContain("0.05 cr");
  });

  it("puts permission requests on the deck and answers them", async () => {
    await bridge.deckPrompt("write");
    const approval = await waitFor(() => bridge.targetApproval());
    expect(approval).toMatchObject({ sessionId: id, source: "deck", category: "write", toolName: "fs_write", summary: "shop/a.txt" });
    expect(bridge.attention(bridge.registry.get(id)!)?.kind).toBe("approval");
    expect(bridge.decide(approval.id, "ask", { by: "test" })).toBe(false); // no Kiro prompt behind it
    expect(bridge.decide(approval.id, "allow", { by: "test" })).toBe(true);
    await waitFor(() => bridge.registry.get(id)?.state === "done");
    expect(received().filter((m) => m.answer).at(-1)?.answer).toEqual({ outcome: { outcome: "selected", optionId: "accept" } });
  });

  it("tells the agent why when Deny carries a reason", async () => {
    await bridge.deckPrompt("write");
    const approval = await waitFor(() => bridge.targetApproval());
    expect(bridge.decide(approval.id, "deny", { by: "test", reasonIndex: 1 })).toBe(true);
    await waitFor(() => bridge.registry.get(id)?.state === "done");
    const log = received();
    expect(log.filter((m) => m.method === "_session/steer").at(-1)?.params).toMatchObject({ sessionId: id, message: expect.stringContaining("Find the root cause first") });
    expect(log.filter((m) => m.answer).at(-1)?.answer).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  });

  it("changes only advertised settings, and steps models in the configured order", async () => {
    await expect(bridge.deckSet("model", "gpt-unknown")).rejects.toThrow("is not a model Kiro offers");
    expect(bridge.deckModels().map((m) => m.value)).toEqual(["claude-haiku-5.5", "claude-opus-5.5"]); // unknown pins are dropped
    expect((await bridge.deckCycle("model")).model?.value).toBe("claude-opus-5.5");
    expect((await bridge.deckCycle("model")).model?.value).toBe("claude-haiku-5.5");
    expect((await bridge.deckCycle("effortLevel")).effort).toBe("medium");
    expect((await bridge.deckSet("autopilot", "on")).autopilot).toBe(true);
    expect(bridge.deckModelLabel(bridge.deckTarget()?.model)).toBe("Haiku 5.5 · 0.06x");
    const key = renderModel(bridge.deckModels()[0], { workspace: "shop", working: false }, { slot: true, current: true, presentation: false });
    expect(key).toContain("Haiku 5.5");
    expect(key).toContain("0.06x credits");
  });

  it("steers a running turn, and Stop ends it", async () => {
    expect(bridge.deckStop()).toBe(false); // nothing running
    await bridge.deckPrompt("wait");
    await waitFor(() => bridge.deck.get(id)?.working);
    expect(await bridge.deckPrompt("Use the staging database")).toBe("steered");
    expect(received().filter((m) => m.method === "_session/steer").at(-1)?.params).toMatchObject({ message: "Use the staging database" });
    expect(renderStop({ workspace: "shop", working: true, workingMs: 5000 }, false)).toContain("working 5s");
    expect(bridge.deckStop()).toBe(true);
    await waitFor(() => bridge.registry.get(id)?.state === "done");
    expect(received().some((m) => m.method === "session/cancel")).toBe(true);
  });

  it("stops deck turns and refuses prompts under lockdown", async () => {
    await bridge.deckPrompt("wait");
    await waitFor(() => bridge.deck.get(id)?.working);
    await bridge.setLockdown(true);
    await waitFor(() => !bridge.deck.get(id)?.working);
    await expect(bridge.deckPrompt("again")).rejects.toThrow("lockdown is on");
    await bridge.setLockdown(false);
    expect(LOCKDOWN_REASON).toContain("lockdown");
  });

  it("reads account credits through the deck session's kiro-cli", async () => {
    expect(await bridge.usage.refresh()).toBe(true);
    expect(bridge.usage.state.snapshot?.credits).toMatchObject({ used: 10, limit: 100 });
  });

  it("answers the CLI over the socket", async () => {
    const list = await post("/v1/deck/list", {});
    expect(list.status).toBe(200);
    expect(list.json.message).toContain(id);
    const missing = await post("/v1/deck/say", { session: "nope", text: "hi" });
    expect(missing).toMatchObject({ status: 409, json: { ok: false, message: "no deck session nope" } });
    const said = await post("/v1/deck/say", { session: id.slice(5, 7), text: "hello again" }); // a unique prefix without sess_
    expect(said).toMatchObject({ status: 200, json: { ok: true, result: "started" } });
    await waitFor(() => bridge.registry.get(id)?.state === "done");
  });

  it("writes a transcript of prompts, replies, tools and decisions", () => {
    const file = join(paths.base, "deck", readdirSync(join(paths.base, "deck"))[0]!);
    const transcript = readFileSync(file, "utf8");
    expect(transcript).toContain("# Deck session: shop");
    expect(transcript).toContain("## You");
    expect(transcript).toContain("hello");
    expect(transcript).toContain("Done.");
    expect(transcript).toContain("- ✓ write: shop/a.txt");
    expect(transcript).toContain("allowed on Stream Deck");
    expect(transcript).toContain("> Steering: Use the staging database");
    expect(transcript).toContain("Turn stopped");
  });

  it("closes a deck session when its key is held with nothing left to mark as seen", async () => {
    expect(bridge.clear(id)).toBe("acknowledged");
    expect(bridge.clear(id)).toBe("dismissed");
    await waitFor(() => received().some((m) => m.method === "session/close"));
    await waitFor(() => !bridge.deck.owns(id));
    expect(bridge.registry.get(id)).toBeUndefined();
    expect(bridge.deck.connected).toBe(false); // the last session closed, so kiro-cli stopped
  });
});

describe("ki-deck deck", () => {
  const CLI = join(import.meta.dirname, "..", "bin", "ki-deck");
  const cli = (...args: string[]) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      execFile("/bin/sh", [CLI, "deck", ...args], { env: { PATH: process.env.PATH ?? "", HOME: home, KI_DECK_HOME: home } }, (err, stdout, stderr) =>
        resolve({ code: err ? Number(err.code ?? 1) : 0, out: `${stdout}${stderr}` }),
      );
    });

  it("starts, prompts, switches and closes a deck session from the command line", async () => {
    const started = await cli("start", "--cwd", workspace, "--model", "claude-opus-5.5", "--autopilot", 'say "hi" & exit');
    expect(started.code).toBe(0);
    expect(started.out).toMatch(/Started sess_\w+ {2}shop/);
    expect(started.out).toContain("Opus 5.5 · 2x");
    expect(started.out).toContain("Autopilot");
    const prompt = received().filter((m) => m.method === "session/prompt").at(-1)?.params as { prompt: Array<{ text: string }> };
    expect(prompt.prompt[0]?.text).toBe('say "hi" & exit'); // exactly as typed
    await waitFor(() => !bridge.deckTarget()?.working);

    expect((await cli("effort", "high")).out).toContain("effort high");
    expect(await cli("model", "nope")).toMatchObject({ code: 1, out: expect.stringContaining("is not a model Kiro offers") });
    expect((await cli("models")).out).toMatch(/\* claude-opus-5\.5/);
    expect((await cli("list")).out).toContain("* sess_");
    expect((await cli("stop")).out).toContain("Nothing is running.");
    expect((await cli("close")).code).toBe(0);
    expect((await cli("say", "anyone?")).code).toBe(1);
  });
});
