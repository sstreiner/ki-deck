import { describe, expect, it } from "vitest";
import { Companions, parseCompanionInfo } from "../src/bridge/companions";
import { ideRootFor, planFocus } from "../src/bridge/focus";
import type { Origin, Session } from "../src/bridge/sessions";

function session(surface: Session["surface"], origin: Partial<Origin>, cwd = "/Users/me/shop"): Session {
  return {
    id: "s1",
    cwd,
    workspace: "shop",
    surface,
    origin: { bundle: "", term: "", termSession: "", tmuxPane: "", tty: "", ...origin },
    state: "done",
    firstSeen: 0,
    lastEvent: 0,
    activeAt: 0,
    pending: [],
    compacting: false,
    counts: { prompts: 0, tools: 0, turns: 0 },
    acknowledged: false,
  };
}

const bins = { tmux: "/opt/homebrew/bin/tmux" };
const OPEN_IN_KIRO = (folder: string) => [{ cmd: "/usr/bin/open", args: ["-b", "dev.kiro.desktop", folder] }];

describe("planFocus", () => {
  it("focuses IDE sessions by opening their folder in Kiro, then by activating Kiro", () => {
    const plan = planFocus(session("ide", { bundle: "dev.kiro.desktop" }), [], bins);
    expect(plan).toEqual([OPEN_IN_KIRO("/Users/me/shop"), [{ cmd: "/usr/bin/open", args: ["-b", "dev.kiro.desktop"] }]]);
  });

  it("only activates Kiro when the session has no folder", () => {
    expect(planFocus(session("ide", {}, ""), [], {})).toEqual([[{ cmd: "/usr/bin/open", args: ["-b", "dev.kiro.desktop"] }]]);
  });

  it("selects the iTerm2 session by the UUID part of ITERM_SESSION_ID", () => {
    const plan = planFocus(
      session("cli", { bundle: "com.googlecode.iterm2", term: "iTerm.app", termSession: "w0t1p0:ABC-123" }),
      [],
      bins,
    );
    expect(plan[0]?.[0]?.args.at(-1)).toBe("ABC-123");
    expect(plan.at(-1)).toEqual([{ cmd: "/usr/bin/open", args: ["-b", "com.googlecode.iterm2"] }]);
  });

  it("selects the Terminal.app tab by tty", () => {
    const plan = planFocus(session("cli", { bundle: "com.apple.Terminal", term: "Apple_Terminal", tty: "ttys004" }), [], bins);
    expect(plan[0]?.[0]?.args.at(-1)).toBe("/dev/ttys004");
  });

  it("selects the tmux pane, then activates the terminal", () => {
    const plan = planFocus(session("cli", { bundle: "com.apple.Terminal", tmuxPane: "%3" }), [], bins);
    expect(plan[0]?.map((s) => s.args[0])).toEqual(["select-window", "select-pane", "-b"]);
  });

  it("focuses the IDE window that contains a kiro-cli in Kiro's terminal", () => {
    const s = session("cli", { bundle: "dev.kiro.desktop", term: "kiro", tty: "ttys009" }, "/Users/me/shop/api");
    expect(planFocus(s, ["/Users/me/shop", "/Users/me/other"], bins)[0]).toEqual(OPEN_IN_KIRO("/Users/me/shop"));
  });
});

describe("ideRootFor", () => {
  it("does not treat a name prefix as a parent folder", () => {
    expect(ideRootFor("/Users/me/shop-admin", ["/Users/me/shop"])).toBeUndefined();
    expect(ideRootFor("/Users/me/shop/a", ["/Users/me", "/Users/me/shop"])).toBe("/Users/me/shop");
  });
});

describe("Companions", () => {
  const info = (pid: number, ...folders: string[]) => ({ pid, version: "0.4.0", folders });

  it("sends a command to the window that owns the session", () => {
    const c = new Companions();
    const got: Record<number, string[]> = { 1: [], 2: [] };
    c.add(info(1, "/Users/me"), (l) => void got[1]!.push(l.trim()));
    c.add(info(2, "/Users/me/shop"), (l) => void got[2]!.push(l.trim()));

    // No claim yet: the window with the closest workspace folder.
    expect(c.send("s1", "/Users/me/shop/api", { kind: "focus", sessionId: "s1" })).toBe(true);
    expect(got[2]).toEqual(['{"kind":"focus","sessionId":"s1"}']);

    // A window that reported the session's context owns it, wherever its folder is.
    c.claim(1, "s1");
    c.send("s1", "/Users/me/shop/api", { kind: "focus", sessionId: "s1" });
    expect(got[1]).toHaveLength(1);

    expect(c.send("s9", "/elsewhere", { kind: "focus", sessionId: "s9" })).toBe(false);
    expect(c.send("s9", "", { kind: "focus", sessionId: "s9" })).toBe(false);
  });

  it("forgets a stream when it closes; after a reload the newest stream wins", () => {
    const c = new Companions();
    const old: string[] = [];
    const fresh: string[] = [];
    const closeOld = c.add(info(1, "/Users/me/shop"), (l) => void old.push(l));
    c.add(info(3, "/Users/me/shop"), (l) => void fresh.push(l));
    c.send("s1", "/Users/me/shop", { kind: "focus", sessionId: "s1" });
    expect([old.length, fresh.length]).toEqual([0, 1]);
    closeOld();
    expect(c.list().map((i) => i.pid)).toEqual([3]);
  });

  it("reads a hello defensively", () => {
    expect(parseCompanionInfo({ pid: 71769, version: "0.4.0", folders: ["/Users/me/shop", 7, "relative"] })).toEqual({ pid: 71769, version: "0.4.0", folders: ["/Users/me/shop"] });
    expect(parseCompanionInfo({ pid: 1, folders: [] })).toBeUndefined();
    expect(parseCompanionInfo({ pid: "71769" })).toBeUndefined();
    expect(parseCompanionInfo(null)).toBeUndefined();
  });
});
