// The activity report (src/bridge/report.ts): counts from the ledger, privacy, and the page.

import { describe, expect, it } from "vitest";
import { median, renderReport, summarize, type ReportDay } from "../src/bridge/report";

const line = (fields: Record<string, unknown>) => JSON.stringify({ ts: "2026-11-09T09:15:00.000Z", workspace: "shop", surface: "ide", ...fields });

const DAYS: ReportDay[] = [
  {
    date: "2026-11-08",
    text: [
      line({ event: "UserPromptSubmit", session: "a" }),
      line({ event: "PreToolUse", session: "a", category: "shell", summary: "rm -rf secret-dir" }),
      line({ event: "PreToolUse", session: "a", category: "write" }),
      line({ event: "Stop", session: "a", turnMs: 120_000 }),
      "not json",
      "",
    ].join("\n"),
  },
  { date: "2026-11-09", text: "" },
  {
    date: "2026-11-10",
    text: [
      line({ event: "UserPromptSubmit", session: "b", workspace: "infra<script>", surface: "cli" }),
      line({ event: "PreToolUse", session: "b", workspace: "infra<script>", category: "shell" }),
      line({ event: "Decision", session: "b", workspace: "infra<script>", decision: "deny", by: "mobile", waitMs: 4_000 }),
      line({ event: "Decision", session: "b", workspace: "infra<script>", decision: "allow", by: "device-1", waitMs: 10_000 }),
      line({ event: "Decision", session: "b", workspace: "infra<script>", decision: "ask", by: "timeout", waitMs: 585_000 }),
      line({ event: "Ungated", session: "b", workspace: "infra<script>", category: "shell" }),
      line({ event: "Stop", session: "b", workspace: "infra<script>", surface: "cli", turnMs: 60_000 }),
      line({ event: "Stop", session: "c", workspace: "billing", surface: "deck", turnMs: 30_000, credits: 0.25 }),
    ].join("\n"),
  },
];

describe("activity report", () => {
  it("counts turns, time, tools, approvals and credits per day and workspace", () => {
    const s = summarize(DAYS);
    expect(s).toMatchObject({ sessions: 3, prompts: 2, turns: 3, turnMs: 210_000, toolCalls: 3, allowed: 1, denied: 1, handed: 1, ungated: 1, credits: 0.25 });
    expect(s.perDay.map((d) => [d.date, d.turns])).toEqual([["2026-11-08", 1], ["2026-11-09", 0], ["2026-11-10", 2]]);
    expect(s.workspaces.map((w) => [w.name, w.sessions, w.turns, w.denied])).toEqual([
      ["shop", 1, 1, 0],
      ["infra<script>", 1, 1, 1],
      ["billing", 1, 1, 0],
    ]);
    expect(s.categories).toEqual([{ name: "shell", count: 2 }, { name: "write", count: 1 }]);
    expect(s.surfaces.map((x) => x.name)).toEqual(["Kiro IDE", "kiro-cli", "Deck sessions"]);
    expect(s.answeredBy.map((x) => x.name)).toContain("Stream Deck Mobile");
    expect(s.hours.reduce((a, b) => a + b, 0)).toBe(2);
    expect(s.waitMs).toEqual([4_000, 10_000]); // the timeout is not an answer
    expect(median(s.waitMs)).toBe(7_000);
    expect(s.answeredBy.map((x) => x.name)).toContain("Nobody (timed out)");
    expect(median([])).toBeUndefined();
  });

  it("is a self-contained page with no scripts, no commands and escaped names", () => {
    const html = renderReport({ stats: summarize(DAYS), now: new Date(2026, 10, 10, 18, 0), presentation: false, version: "test", credits: { plan: "Pro Max", used: 2970, limit: 5000, percent: 59, resetDate: "2026-12-01" } });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toMatch(/<script|<link|src="http|@import/);
    expect(html).not.toContain("rm -rf"); // ledger summaries never reach the report
    expect(html).toContain("infra&lt;script&gt;");
    expect(html).toContain("2,970 of 5,000");
    expect(html).toContain("Last 3 days");
    expect(html).toContain("0.25");
  });

  it("hides workspace names in presentation mode", () => {
    const html = renderReport({ stats: summarize(DAYS), now: new Date(2026, 10, 10), presentation: true, version: "test" });
    expect(html).not.toContain("shop");
    expect(html).not.toContain("infra");
    expect(html).toContain("Workspace 1");
  });

  it("handles an empty period", () => {
    const html = renderReport({ stats: summarize([{ date: "2026-11-10", text: "" }]), now: new Date(2026, 10, 10), presentation: false, version: "test" });
    expect(html).toContain("No activity in this period.");
    expect(html).toContain("No calls waited for the deck");
  });
});
