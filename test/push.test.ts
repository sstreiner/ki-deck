// Push notifications (src/bridge/push.ts): config checks, the requests, and when they go out.

import { describe, expect, it, vi } from "vitest";
import type { Approval } from "../src/bridge/approvals";
import { DEFAULT_CONFIG } from "../src/bridge/config";
import { silentLogger } from "../src/bridge/logger";
import { Notifier } from "../src/bridge/notify";
import type { Session } from "../src/bridge/sessions";
import { parseIdleSeconds, parsePush, pushRequest, Pusher, type Fetch, type PushMessage } from "../src/bridge/push";

const KEY = "a".repeat(30);
const approval: PushMessage = { event: "approval", title: "Kiro: shop", message: "Wants to run shell. Approve on Stream Deck.", urgent: true };
const finished: PushMessage = { event: "finished", title: "Kiro: shop", message: "Finished after 4m. Waiting for you.", urgent: false };

describe("push config", () => {
  it("is off without a setting", () => {
    expect(parsePush(null)).toEqual({ off: true });
    expect(parsePush(undefined)).toEqual({ off: true });
  });

  it("reads an ntfy topic url, also on a self-hosted server under a path", () => {
    const a = parsePush({ provider: "ntfy", url: "https://ntfy.sh/kiro-me-7f3a" });
    expect(a).toMatchObject({ target: { provider: "ntfy", endpoint: "https://ntfy.sh/", topic: "kiro-me-7f3a", host: "ntfy.sh", awayMinutes: 0, approvalDelaySeconds: 300 } });
    const b = parsePush({ provider: "ntfy", url: "https://home.example/ntfy/kiro", token: "tk_x", events: ["approval"], awayMinutes: 5, approvalDelaySeconds: 0 });
    expect(b).toMatchObject({ target: { endpoint: "https://home.example/ntfy/", topic: "kiro", token: "tk_x", awayMinutes: 5, approvalDelaySeconds: 0 } });
    if ("target" in b) expect([...b.target.events]).toEqual(["approval"]);
    expect(parsePush({ provider: "ntfy", url: "http://localhost:8080/kiro" })).toHaveProperty("target");
  });

  it("refuses plain http, credentials in the url, bad topics, events and providers", () => {
    expect(parsePush({ provider: "ntfy", url: "http://ntfy.example/kiro" })).toEqual({ error: expect.stringContaining("https") });
    expect(parsePush({ provider: "ntfy", url: "https://u:p@ntfy.sh/kiro" })).toEqual({ error: expect.stringContaining("token") });
    expect(parsePush({ provider: "ntfy", url: "https://ntfy.sh/" })).toEqual({ error: expect.stringContaining("topic") });
    expect(parsePush({ provider: "ntfy", url: "https://ntfy.sh/a b" })).toHaveProperty("error");
    expect(parsePush({ provider: "ntfy", url: "https://ntfy.sh/kiro", events: ["everything"] })).toEqual({ error: expect.stringContaining("everything") });
    expect(parsePush({ provider: "ntfy", url: "https://ntfy.sh/kiro", awayMinutes: -1 })).toHaveProperty("error");
    for (const approvalDelaySeconds of [-1, 1801, "300"]) {
      expect(parsePush({ provider: "ntfy", url: "https://ntfy.sh/kiro", approvalDelaySeconds })).toEqual({ error: expect.stringContaining("approvalDelaySeconds") });
    }
    expect(parsePush({ provider: "slack" })).toHaveProperty("error");
    expect(parsePush({ provider: "pushover", token: KEY })).toEqual({ error: expect.stringContaining("user") });
    expect(parsePush("ntfy")).toHaveProperty("error");
    expect(parsePush({ provider: "ntfy", url: "https://ntfy.sh/kiro", token: "tk_abc\ndef" })).toEqual({ error: expect.stringContaining("visible ASCII") });
  });

  it("builds an ntfy JSON message and a Pushover form", () => {
    const ntfy = parsePush({ provider: "ntfy", url: "https://ntfy.sh/kiro", token: "tk_x" });
    if (!("target" in ntfy)) throw new Error("expected a target");
    const r = pushRequest(ntfy.target, { ...approval, title: "Kiro: café" });
    expect(r.url).toBe("https://ntfy.sh/");
    expect(r.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer tk_x" });
    expect(JSON.parse(r.body)).toEqual({ topic: "kiro", title: "Kiro: café", message: approval.message, priority: 4, tags: ["raised_hand"] });

    const po = parsePush({ provider: "pushover", token: KEY, user: "u".repeat(30) });
    if (!("target" in po)) throw new Error("expected a target");
    const p = pushRequest(po.target, finished);
    expect(p.url).toBe("https://api.pushover.net/1/messages.json");
    expect(Object.fromEntries(new URLSearchParams(p.body))).toEqual({ token: KEY, user: "u".repeat(30), title: "Kiro: shop", message: finished.message, priority: "0" });
  });

  it("reads the idle time ioreg reports", () => {
    expect(parseIdleSeconds('| |   "HIDIdleTime" = 84795125000\n')).toBeCloseTo(84.795, 2);
    expect(parseIdleSeconds("nothing")).toBeUndefined();
  });
});

describe("Pusher", () => {
  function pusher(push: unknown, options: { quietHours?: string; idle?: number; now?: Date } = {}) {
    const sent: Array<{ url: string; body: string }> = [];
    const fetch: Fetch = async (url, init) => {
      sent.push({ url, body: init.body });
      return { ok: true, status: 200 };
    };
    let now = options.now ?? new Date(2026, 10, 10, 14, 0);
    const p = new Pusher({
      config: () => ({ push, quietHours: options.quietHours ?? "" }),
      run: async () => ({ ok: options.idle !== undefined, stdout: `"HIDIdleTime" = ${(options.idle ?? 0) * 1e9}`, stderr: "" }),
      log: silentLogger,
      now: () => now,
      fetch,
    });
    return { p, sent, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
  }
  const NTFY = { provider: "ntfy", url: "https://ntfy.sh/kiro" };

  it("sends nothing while push is off or invalid, and says so", async () => {
    const off = pusher(null);
    await off.p.send(approval, "approval:s1");
    expect(off.sent).toHaveLength(0);
    expect(off.p.status()).toBe("off");
    expect(await off.p.test()).toMatchObject({ ok: false });
    const bad = pusher({ provider: "ntfy", url: "http://x/kiro" });
    await bad.p.send(approval, "approval:s1");
    expect(bad.sent).toHaveLength(0);
    expect(bad.p.status()).toMatch(/^invalid: /);
  });

  it("sends each event once a minute per session, and only the events asked for", async () => {
    const { p, sent, advance } = pusher({ ...NTFY, events: ["approval"] });
    await p.send(approval, "approval:s1");
    await p.send(approval, "approval:s1");
    await p.send(approval, "approval:s2");
    await p.send(finished, "finished:s1");
    expect(sent).toHaveLength(2);
    advance(61_000);
    await p.send(approval, "approval:s1");
    expect(sent).toHaveLength(3);
    expect(p.status()).toBe("ntfy to ntfy.sh, approvals after 5 min");
  });

  it("pushes an approval only if it still waits after approvalDelaySeconds", async () => {
    vi.useFakeTimers();
    try {
      const { p, sent } = pusher({ ...NTFY, approvalDelaySeconds: 300 });
      p.schedule(approval, "approval:answered");
      p.schedule(approval, "approval:waiting");
      p.schedule(finished, "finished:s1"); // only approvals wait
      await vi.advanceTimersByTimeAsync(0);
      expect(sent.map((s) => JSON.parse(s.body).priority)).toEqual([3]);

      await vi.advanceTimersByTimeAsync(299_000);
      p.cancel("approval:answered"); // answered at the Mac within the delay
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent.map((s) => JSON.parse(s.body).priority)).toEqual([3, 4]); // only the one still waiting

      p.schedule(approval, "approval:late");
      p.stop(); // plugin shutdown
      await vi.advanceTimersByTimeAsync(300_000);
      expect(sent).toHaveLength(2);

      const now = pusher({ ...NTFY, approvalDelaySeconds: 0 });
      now.p.schedule(approval, "approval:x");
      await vi.advanceTimersByTimeAsync(0);
      expect(now.sent).toHaveLength(1);
      expect(now.p.status()).toBe("ntfy to ntfy.sh");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps quiet hours, except for approvals", async () => {
    const { p, sent } = pusher(NTFY, { quietHours: "22:00-07:00", now: new Date(2026, 10, 10, 23, 30) });
    await p.send(finished, "finished:s1");
    await p.send(approval, "approval:s1");
    expect(sent.map((s) => JSON.parse(s.body).priority)).toEqual([4]);
  });

  it("with awayMinutes, waits until the Mac has been idle that long", async () => {
    const atDesk = pusher({ ...NTFY, awayMinutes: 5 }, { idle: 30 });
    await atDesk.p.send(approval, "approval:s1");
    expect(atDesk.sent).toHaveLength(0);
    const away = pusher({ ...NTFY, awayMinutes: 5 }, { idle: 600 });
    await away.p.send(approval, "approval:s1");
    expect(away.sent).toHaveLength(1);
  });

  it("sends a test message on request, and reports a failure without throwing or quoting secrets", async () => {
    const { p, sent } = pusher(NTFY);
    expect(await p.test()).toEqual({ ok: true, message: "Sent a test push with ntfy to ntfy.sh." });
    expect(JSON.parse(sent[0]!.body).message).toContain("Push works");
    const inits: Array<Parameters<Fetch>[1]> = [];
    const failing = new Pusher({
      config: () => ({ push: { ...NTFY, token: "tk_secret" }, quietHours: "" }),
      run: async () => ({ ok: false, stdout: "", stderr: "" }),
      log: silentLogger,
      fetch: async (_url, init) => {
        inits.push(init);
        throw new Error("redirect to http://ntfy.sh/kiro refused, Bearer tk_secret");
      },
    });
    const result = await failing.test();
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("tk_secret");
    expect(result.message).not.toContain("/kiro");
    expect(inits[0]?.redirect).toBe("error"); // https stays https: no redirect is followed
    await expect(failing.send(approval, "approval:s1")).resolves.toBeUndefined();
  });

  it("tells the Mac at once, and the phone only if the approval is still waiting", async () => {
    vi.useFakeTimers();
    try {
      const { p, sent } = pusher({ ...NTFY, approvalDelaySeconds: 300 });
      const macos: string[] = [];
      const notifier = new Notifier(
        () => ({ ...DEFAULT_CONFIG, notifications: { ...DEFAULT_CONFIG.notifications, quietHours: "" } }),
        {},
        async (_cmd, args) => (macos.push(args.join(" ")), { ok: true, stdout: "", stderr: "" }),
        () => new Date(2026, 10, 10, 14, 0),
        p,
      );
      const session = { id: "s1", workspace: "shop" } as Session;
      const call = (id: string): Approval => ({ id, sessionId: "s1", workspace: "shop", category: "shell", toolName: "execute_bash", summary: "npm test", detail: "npm test", createdAt: 0 });

      await notifier.approvalWaiting(session, call("answered"));
      await notifier.approvalWaiting(session, call("forgotten"));
      expect(macos).toHaveLength(2); // the Mac hears about both right away
      await vi.advanceTimersByTimeAsync(60_000);
      notifier.approvalSettled(call("answered"));
      await vi.advanceTimersByTimeAsync(240_000);
      expect(sent.map((s) => JSON.parse(s.body).message)).toEqual(["Wants to run shell. Approve on Stream Deck."]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a second send slip through while the idle check runs", async () => {
    const { p, sent } = pusher({ ...NTFY, awayMinutes: 5 }, { idle: 600 });
    await Promise.all([p.send(approval, "approval:a1"), p.send(approval, "approval:a1")]);
    expect(sent).toHaveLength(1);
  });
});
