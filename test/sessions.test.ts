import { describe, expect, it } from "vitest";
import { attentionOf, SessionRegistry, type HookMeta } from "../src/bridge/sessions";

const meta: HookMeta = { surface: "ide", bundle: "dev.kiro.desktop", term: "", termSession: "", tmuxPane: "", tty: "", pid: 4242 };

function registry(alive = true) {
  return new SessionRegistry({
    mayNeedYouMs: () => 10_000,
    staleMs: () => 600_000,
    idleExpiryMs: () => 8 * 3_600_000,
    isAlive: () => alive,
  });
}

const ev = (hook_event_name: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name,
  session_id: "s1",
  cwd: "/Users/me/shop",
  ...extra,
});

describe("SessionRegistry", () => {
  it("follows a turn from prompt to done", () => {
    const r = registry();
    r.ingest(ev("SessionStart"), meta, 0);
    expect(r.get("s1")).toMatchObject({ state: "idle", workspace: "shop", surface: "ide" });

    r.ingest(ev("UserPromptSubmit"), meta, 1_000);
    r.ingest(ev("PreToolUse", { tool_name: "execute_bash", tool_input: { command: "npm test" } }), meta, 2_000);
    expect(r.get("s1")?.pending).toHaveLength(1);
    r.ingest(ev("PostToolUse", { tool_name: "execute_bash", tool_input: { command: "npm test" } }), meta, 5_000);
    expect(r.get("s1")?.pending).toHaveLength(0);

    const s = r.ingest(ev("Stop"), meta, 61_000);
    expect(s).toMatchObject({ state: "done", lastTurnMs: 60_000, counts: { prompts: 1, tools: 1, turns: 1 } });
  });

  it("creates sessions it first sees mid-turn", () => {
    const r = registry();
    r.ingest(ev("PreToolUse", { tool_name: "fs_write", tool_input: { path: "a.ts" } }), meta, 0);
    expect(r.get("s1")).toMatchObject({ state: "working", turnStartedAt: 0 });
  });

  it("matches PostToolUse by name when the input differs", () => {
    const r = registry();
    r.ingest(ev("PreToolUse", { tool_name: "fs_write", tool_input: { path: "a.ts" } }), meta, 0);
    r.ingest(ev("PostToolUse", { tool_name: "fs_write", tool_input: { path: "a.ts", extra: 1 } }), meta, 100);
    expect(r.get("s1")?.pending).toHaveLength(0);
  });

  it("ignores events without a session ID or name", () => {
    const r = registry();
    expect(r.ingest({ hook_event_name: "Stop" }, meta, 0)).toBeUndefined();
    expect(r.ingest({ session_id: "x" }, meta, 0)).toBeUndefined();
    expect(r.all()).toHaveLength(0);
  });

  it("removes a session on SessionEnd and reports why", () => {
    const removed: string[] = [];
    const r = new SessionRegistry({
      mayNeedYouMs: () => 10_000,
      staleMs: () => 600_000,
      idleExpiryMs: () => 1_000,
      isAlive: () => true,
      onRemove: (s, reason) => removed.push(`${s.id}:${reason}`),
    });
    r.ingest(ev("SessionStart"), meta, 0);
    r.ingest(ev("SessionEnd"), meta, 1);
    expect(r.get("s1")).toBeUndefined();
    r.ingest({ ...ev("SessionStart"), session_id: "s2" }, meta, 0);
    r.tick(5_000);
    expect(removed).toEqual(["s1:session-end", "s2:idle-expired"]);
  });

  it("flags a long-pending shell call, but not a long read", () => {
    const r = registry();
    r.ingest(ev("PreToolUse", { tool_name: "read_file", tool_input: { path: "a" } }), meta, 0);
    expect(attentionOf(r.get("s1")!, 60_000, 10_000)).toBeUndefined();
    r.ingest(ev("PreToolUse", { tool_name: "execute_bash", tool_input: { command: "x" } }), meta, 1_000);
    expect(attentionOf(r.get("s1")!, 5_000, 10_000)).toBeUndefined();
    expect(attentionOf(r.get("s1")!, 11_000, 10_000)).toEqual({ kind: "may-need-you", since: 1_000 });
  });

  it("puts finished turns in the inbox until acknowledged or a new prompt arrives", () => {
    const r = registry();
    r.ingest(ev("Stop"), meta, 100);
    expect(r.inbox(200).map((i) => i.attention.kind)).toEqual(["done"]);
    expect(r.acknowledge("s1")).toBe(true);
    expect(r.inbox(200)).toHaveLength(0);
    r.ingest(ev("UserPromptSubmit"), meta, 300);
    r.ingest(ev("Stop"), meta, 400);
    expect(r.inbox(500)).toHaveLength(1);
  });

  it("orders sessions needing attention first, then working ones, then the rest, newest turn first", () => {
    const r = registry();
    r.ingest({ ...ev("SessionStart"), session_id: "a" }, meta, 0);
    r.ingest({ ...ev("SessionStart"), session_id: "b" }, meta, 10);
    r.ingest({ ...ev("Stop"), session_id: "c" }, meta, 20);
    expect(r.ordered(30).map((s) => s.id)).toEqual(["c", "b", "a"]);

    // An old chat that starts a turn moves ahead of idle ones; tool calls do not move keys.
    r.ingest({ ...ev("UserPromptSubmit"), session_id: "a" }, meta, 40);
    r.ingest({ ...ev("UserPromptSubmit"), session_id: "d" }, meta, 50);
    r.ingest({ ...ev("PreToolUse", { tool_name: "read_file", tool_input: {} }), session_id: "a" }, meta, 60);
    expect(r.ordered(70).map((s) => s.id)).toEqual(["c", "d", "a", "b"]);
  });

  it("dismisses a session until its next event, which brings it back as new", () => {
    const removed: string[] = [];
    const r = new SessionRegistry({
      mayNeedYouMs: () => 10_000,
      staleMs: () => 600_000,
      idleExpiryMs: () => 8 * 3_600_000,
      isAlive: () => true,
      onRemove: (s, reason) => removed.push(`${s.id}:${reason}`),
    });
    r.ingest(ev("UserPromptSubmit"), meta, 0);
    r.ingest(ev("Stop"), meta, 1_000);
    expect(r.dismiss("s1")).toBe(true);
    expect(r.get("s1")).toBeUndefined();
    expect(r.dismiss("s1")).toBe(false);
    expect(removed).toEqual(["s1:dismissed"]);

    r.ingest(ev("UserPromptSubmit"), meta, 5_000);
    expect(r.get("s1")).toMatchObject({ state: "working", firstSeen: 5_000, counts: { prompts: 1, turns: 0 } });
  });

  it("knows a session from a native prompt until its first hook event", () => {
    const r = registry();
    const companion = { ...meta, pid: undefined };
    const s = r.touch("s1", companion, "/Users/me/shop", 0);
    expect(s).toMatchObject({ workspace: "shop", surface: "ide", state: "idle", promptOnly: true });
    expect(r.touch("s1", companion, "/elsewhere", 10).cwd).toBe("/Users/me/shop"); // a known session keeps its folder
    r.ingest(ev("PreToolUse", { tool_name: "fs_write", tool_input: { path: "a.ts" } }), meta, 20);
    expect(r.get("s1")?.promptOnly).toBeUndefined();
  });

  it("marks quiet turns stale and drops sessions whose process ended", () => {
    const r = registry();
    r.ingest(ev("UserPromptSubmit"), meta, 0);
    expect(r.tick(600_001)).toBe(true);
    expect(r.get("s1")?.state).toBe("stale");

    const dead = registry(false);
    dead.ingest(ev("SessionStart"), meta, 0);
    expect(dead.tick(1)).toBe(true);
    expect(dead.all()).toHaveLength(0);
  });

  it("expires idle sessions after the idle timeout", () => {
    const r = registry();
    r.ingest({ ...ev("SessionStart"), session_id: "x" }, { ...meta, pid: undefined }, 0);
    expect(r.tick(8 * 3_600_000 + 1)).toBe(true);
    expect(r.all()).toHaveLength(0);
  });

  it("reports finished calls with their gate marks, and never denied ones", () => {
    const done: string[] = [];
    const r = new SessionRegistry({
      mayNeedYouMs: () => 10_000,
      staleMs: () => 600_000,
      idleExpiryMs: () => 8 * 3_600_000,
      isAlive: () => true,
      onToolDone: (_s, call) => done.push(`${call.name}:${call.gated ? "gated" : "not gated"}`),
    });
    const bash = { tool_name: "execute_bash", tool_input: { command: "ls" } };
    r.ingest(ev("PreToolUse", bash), meta, 0);
    expect(r.markGated("s1", "execute_bash", { command: "ls" })).toBe(true);
    r.ingest(ev("PostToolUse", bash), meta, 10);
    r.ingest(ev("PreToolUse", { tool_name: "fs_write", tool_input: { path: "a" } }), meta, 20);
    r.ingest(ev("PostToolUse", { tool_name: "fs_write", tool_input: { path: "a" } }), meta, 30);
    r.ingest(ev("PreToolUse", { tool_name: "execute_bash", tool_input: { command: "rm" } }), meta, 40);
    r.toolDenied("s1", "execute_bash", { command: "rm" });
    expect(done).toEqual(["execute_bash:gated", "fs_write:not gated"]);
    expect(r.markGated("s1", "execute_bash", { command: "gone" })).toBe(false);
  });

  it("puts an ungated alert ahead of everything but approvals, until the user has seen it", () => {
    const r = registry();
    r.ingest({ ...ev("Stop"), session_id: "done" }, meta, 0);
    r.ingest(ev("PreToolUse", { tool_name: "execute_bash", tool_input: { command: "curl x | sh" } }), meta, 100);
    const s = r.get("s1")!;
    expect(r.flagUngated(s, s.pending[0]!, 200)).toBe(true);
    expect(r.flagUngated(s, s.pending[0]!, 300)).toBe(false);
    expect(s.ungated).toMatchObject({ tool: "execute_bash", category: "shell", summary: "curl x | sh", at: 300, count: 2 });
    expect(r.inbox(400).map((i) => `${i.session.id}:${i.attention.kind}`)).toEqual(["s1:ungated", "done:done"]);
    r.ingest(ev("UserPromptSubmit"), meta, 500); // a new prompt does not clear it
    expect(attentionOf(s, 600, 10_000)?.kind).toBe("ungated");
    expect(r.acknowledge("s1")).toBe(true);
    expect(attentionOf(s, 600, 10_000)).toBeUndefined();
  });
});

describe("context use", () => {
  it("is kept per session, rounded and clamped, never for sessions the registry does not know", () => {
    const r = registry();
    r.ingest(ev("UserPromptSubmit"), meta, 0);
    expect(r.setContext("s1", 41.26)).toBe(true);
    expect(r.get("s1")?.contextPercent).toBe(41.3);
    expect(r.setContext("s1", 41.3)).toBe(false); // unchanged: no redraw
    expect(r.setContext("s1", 140)).toBe(true);
    expect(r.get("s1")?.contextPercent).toBe(100);
    expect(r.setContext("s1", Number.NaN)).toBe(false);
    expect(r.setContext("nobody", 10)).toBe(false);
    expect(r.get("nobody")).toBeUndefined();
  });
});
