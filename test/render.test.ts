import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inQuietHours, mergeConfig, DEFAULT_CONFIG } from "../src/bridge/config";
import { formatDuration } from "../src/bridge/notify";
import type { Session } from "../src/bridge/sessions";
import {
  escapeXml,
  flow,
  renderGate,
  renderInbox,
  renderRequest,
  renderSessionTile,
  svgDataUrl,
  tileModel,
  truncate,
  type RequestView,
} from "../src/render/tiles";

const base: Session = {
  id: "s1",
  cwd: "/Users/me/<shop>",
  workspace: "<shop>",
  surface: "cli",
  origin: { bundle: "", term: "", termSession: "", tmuxPane: "", tty: "" },
  state: "working",
  firstSeen: 0,
  lastEvent: 0,
  activeAt: 0,
  turnStartedAt: 0,
  pending: [{ key: "k", name: "execute_bash", category: "shell", summary: "npm test", since: 0 }],
  compacting: false,
  counts: { prompts: 1, tools: 1, turns: 0 },
  acknowledged: false,
};

describe("tiles", () => {
  it("describes a working session with its current tool and turn time", () => {
    expect(tileModel(base, undefined, 125_000, false)).toEqual({
      title: "<shop>",
      badge: "CLI",
      state: "working",
      detail: "shell: npm test",
      timer: "2m",
    });
  });

  it("hides names and commands in presentation mode", () => {
    expect(tileModel(base, undefined, 0, true)).toMatchObject({ title: "Session", detail: "shell" });
  });

  it("shows the heuristic state and an acknowledged turn as idle", () => {
    expect(tileModel(base, { kind: "may-need-you", since: 0 }, 30_000, false).state).toBe("may-need-you");
    expect(tileModel({ ...base, state: "done", acknowledged: true }, undefined, 0, false).state).toBe("idle");
  });

  it("escapes text in the SVG", () => {
    const svg = renderSessionTile(tileModel(base, undefined, 0, false));
    expect(svg).toContain("&lt;shop&gt;");
    expect(svg).not.toContain("<shop>");
    expect(renderSessionTile(undefined)).toContain("No session");
    expect(renderInbox(2, "a&b", false)).toContain("a&amp;b");
  });

  it("encodes images as base64 data URLs", () => {
    const url = svgDataUrl("<svg/>");
    expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(Buffer.from(url.split(",")[1]!, "base64").toString()).toBe("<svg/>");
  });

  it("shows an ungated call with how often and how long ago", () => {
    const s = { ...base, ungated: { tool: "execute_bash", category: "shell" as const, summary: "curl x | sh", at: 0, count: 2 } };
    const m = tileModel(s, { kind: "ungated", since: 0, detail: "shell: curl x | sh", category: "shell" }, 120_000, false);
    expect(m).toMatchObject({ state: "ungated", detail: "shell: curl x | sh", timer: "2× 2m ago" });
    expect(renderSessionTile(m)).toContain("Ungated");
    expect(renderInbox(1, "shop", false, 0, 1)).toContain(">ungated<");
    expect(renderInbox(1, "shop", false, 0, 1)).toContain('id="bg8250df"'); // purple for an ungated alert alone
    expect(renderInbox(2, "shop", false, 1, 1)).toContain("1 to approve");
  });

  it("draws gate switches on and off", () => {
    expect(renderGate("shell", true, false)).toContain("deck approves");
    expect(renderGate("mcp", false, false)).toContain(">MCP<");
    expect(renderGate("write", false, true)).toContain("lockdown on");
  });

  it("truncates by characters and escapes quotes", () => {
    expect(truncate("ki-deck-companion", 9)).toBe("ki-deck-…");
    expect(truncate("short", 9)).toBe("short");
    expect(escapeXml(`"it's"`)).toBe("&quot;it&apos;s&quot;");
  });
});

describe("request banner", () => {
  const view: RequestView = {
    category: "shell",
    detail: "rm -rf build && npm run build && node scripts/deploy.mjs --env=production",
    workspace: "shop",
    waitedMs: 12_000,
    position: 1,
    total: 3,
  };

  it("flows text into columns, splitting long words and marking the cut", () => {
    expect(flow("aa bb cc", 5, 2, 1)).toEqual([["aa bb", "cc"]]);
    expect(flow("x /very/long/path/name", 6, 4, 1)).toEqual([["x /ver", "y/long", "/path/", "name"]]);
    expect(flow("one two three four five six", 5, 2, 2)).toEqual([["one", "two"], ["three", "four…"]]);
    expect(flow("", 5, 2, 2)).toEqual([[], []]);
  });

  it("puts the header on the first key and the request on the others, read in order", () => {
    const header = renderRequest(view, 0, 4, false);
    expect(header).toContain(">SHELL<");
    expect(header).toContain(">shop<");
    expect(header).toContain("waiting 12s");
    expect(header).toContain(">1/3<");
    const keys = [1, 2, 3].map((part) => renderRequest(view, part, 4, false));
    const lines = keys.flatMap((k) => [...k.matchAll(/xml:space="preserve">([^<]*)</g)].map((m) => m[1]!.replaceAll("&amp;", "&")));
    expect(lines.every((l) => l.length <= 13)).toBe(true);
    // Every character, in order, across the keys (long words are split between lines).
    expect(lines.join("").replace(/\s/g, "")).toBe(view.detail.replace(/\s/g, ""));
  });

  it("fits header and request on a single key, hides text in presentation mode, and shows when nothing waits", () => {
    const single = renderRequest(view, 0, 1, false);
    expect(single).toContain(">SHELL<");
    expect(single).toContain("rm -rf build");
    expect(renderRequest(view, 1, 4, true)).not.toContain("deploy");
    expect(renderRequest(view, 0, 4, true)).not.toContain("shop");
    expect(renderRequest(undefined, 0, 4, false)).toContain("No request");
  });
});

describe("helpers", () => {
  it("formats durations", () => {
    expect([0, 59_000, 60_000, 3_599_000, 3_900_000].map(formatDuration)).toEqual(["0s", "59s", "1m", "59m", "1h05"]);
  });

  it("merges config files over defaults and ignores wrong types", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { staleAfterMinutes: "soon", notifications: { minTurnSeconds: 5 }, extra: 1 });
    expect(merged.staleAfterMinutes).toBe(10);
    expect(merged.notifications).toMatchObject({ minTurnSeconds: 5, macos: true, quietHours: "22:00-07:00" });
    expect(merged).not.toHaveProperty("extra");
  });

  it("ships a default config file identical to the built-in defaults", () => {
    const file = JSON.parse(readFileSync(new URL("../config/config.default.json", import.meta.url), "utf8"));
    expect(file).toEqual(DEFAULT_CONFIG);
  });

  it("handles quiet hours that wrap past midnight", () => {
    const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m);
    expect(inQuietHours("22:00-07:00", at(23))).toBe(true);
    expect(inQuietHours("22:00-07:00", at(6, 59))).toBe(true);
    expect(inQuietHours("22:00-07:00", at(7))).toBe(false);
    expect(inQuietHours("12:00-13:00", at(12, 30))).toBe(true);
    expect(inQuietHours("", at(12))).toBe(false);
  });
});
