// The report and push through a running bridge: `POST /v1/report` writes and opens the page,
// a waiting approval reaches the phone with its category only, `POST /v1/push/test` sends one.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bridge, bridgePaths } from "../src/bridge";
import { silentLogger } from "../src/bridge/logger";
import type { Fetch } from "../src/bridge/push";
import type { RunResult } from "../src/bridge/system";
import { ledgerFile } from "../src/bridge/today";
import { BridgeLink } from "../src/companion/bridge-link";

const home = mkdtempSync(join(tmpdir(), "sdk-report-push-"));
const paths = bridgePaths(home);
const commands: Array<{ cmd: string; args: string[] }> = [];
const pushes: Array<{ url: string; body: Record<string, unknown> }> = [];

const fetch: Fetch = async (url, init) => {
  pushes.push({ url, body: JSON.parse(init.body) });
  return { ok: true, status: 200 };
};

const bridge = new Bridge({
  version: "test",
  logger: silentLogger,
  paths,
  bins: {},
  isAlive: () => true,
  tickMs: 60_000,
  fetch,
  run: async (cmd, args): Promise<RunResult> => {
    commands.push({ cmd, args });
    return { ok: true, stdout: "", stderr: "" };
  },
});

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
  mkdirSync(paths.data, { recursive: true, mode: 0o700 });
  writeFileSync(
    paths.config,
    JSON.stringify({
      notifications: { macos: false, quietHours: "", push: { provider: "ntfy", url: "https://ntfy.example/kiro-test", approvalDelaySeconds: 0 } },
      ledger: { storeRaw: true },
    }),
  );
  writeFileSync(
    ledgerFile(paths.data, new Date()),
    `${JSON.stringify({ ts: new Date().toISOString(), event: "Stop", session: "s1", workspace: "shop", surface: "ide", turnMs: 90_000 })}\n`,
  );
  await bridge.start();
});

afterAll(async () => {
  await bridge.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("report and push through the bridge", () => {
  it("writes the report privately and opens it", async () => {
    const { status, json } = await post("/v1/report", { days: 7 });
    expect(status).toBe(200);
    const file = String(json.path);
    expect(file).toBe(join(home, "reports", file.split("/").pop()!));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("Last 7 days");
    expect(commands.at(-1)).toEqual({ cmd: "/usr/bin/open", args: [file] });
  });

  it("pushes a waiting approval with its category only, never the file", async () => {
    const link = new BridgeLink(paths.socket);
    const pending = link.ask({
      sessionId: "sess_push",
      toolCallId: "toolu_push_1",
      consentRound: 1,
      title: "Write File",
      toolId: "fs_write",
      capability: "fs_write",
      resource: "/Users/me/shop/secrets.env",
      workspaceRoot: "/Users/me/shop",
      paths: ["/Users/me/shop/secrets.env"],
      options: [{ optionId: "accept", name: "Allow", kind: "allow_once" }],
    });
    const approval = await waitFor(() => bridge.targetApproval());
    const push = await waitFor(() => pushes.find((p) => p.body.priority === 4));
    expect(push.url).toBe("https://ntfy.example/");
    expect(push.body).toMatchObject({ topic: "kiro-test", title: "Kiro: shop", message: "Wants to run write. Approve on Stream Deck." });
    expect(JSON.stringify(push.body)).not.toContain("secrets");
    bridge.decide(approval.id, "allow", { by: "test" });
    await pending;
    link.close();
  });

  it("sends a test push on request and reports push in health", async () => {
    const { status, json } = await post("/v1/push/test", {});
    expect(status).toBe(200);
    expect(json.message).toBe("Sent a test push with ntfy to ntfy.example.");
    expect(pushes.at(-1)?.body.message).toContain("Push works");
  });
});
