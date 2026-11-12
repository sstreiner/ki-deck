import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { IdeSettings } from "../src/bridge/ide-settings";
import type { Session } from "../src/bridge/sessions";

const home = mkdtempSync(join(tmpdir(), "sdk-ide-settings-"));
const sessionsDir = join(home, "sessions");
const workspace = join(home, "shop");
const id = "sess_12345678-abcd";

mkdirSync(workspace);
const canonicalWorkspace = realpathSync(workspace);

const session = {
  id,
  cwd: workspace,
  workspace: "shop",
  surface: "ide",
  state: "working",
} as Session;

function sessionFile(sessionId = id): string {
  const hash = createHash("sha256").update(canonicalWorkspace).digest("hex").slice(0, 16);
  const dir = join(sessionsDir, hash, sessionId);
  mkdirSync(dir, { recursive: true });
  return join(dir, "session.json");
}

function writeSession(): void {
  writeFileSync(
    sessionFile(),
    JSON.stringify({
      id,
      workspacePaths: [canonicalWorkspace],
      modelId: "gpt-5.6-sol",
      effortLevel: "xhigh",
      autopilot: true,
      agentMode: "vibe",
      contextSnapshotModelDisplay: { display: "GPT 5.6 Sol" },
    }),
  );
}

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("IDE session settings", () => {
  it("reads the current model, effort and autonomy without making them writable", async () => {
    writeSession();
    const settings = new IdeSettings(sessionsDir);

    expect(await settings.refresh([session], () => workspace)).toBe(true);
    expect(settings.view(session)).toMatchObject({
      id,
      working: true,
      metadataAvailable: true,
      model: { value: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
      effort: "xhigh",
      autopilot: true,
      writableSettings: [],
    });
  });

  it("enables only options that a live hub response advertises", async () => {
    writeSession();
    const settings = new IdeSettings(sessionsDir);
    await settings.refresh([session], () => workspace);
    expect(
      settings.applyConfigOptions(id, [
        { type: "select", id: "model", currentValue: "gpt-5.6-sol", options: [{ value: "gpt-5.6-sol", name: "GPT 5.6 Sol" }, { value: "auto", name: "Auto" }] },
        { type: "select", id: "effortLevel", currentValue: "xhigh", options: [{ value: "high", name: "High" }, { value: "xhigh", name: "Extra high" }] },
        { type: "select", id: "autopilot", currentValue: "on", options: [{ value: "on", name: "Autopilot" }, { value: "off", name: "Supervised" }] },
      ]),
    ).toBe(true);

    expect(settings.view(session)).toMatchObject({
      models: [{ value: "gpt-5.6-sol" }, { value: "auto" }],
      effortLevels: ["high", "xhigh"],
      autopilotValues: ["on", "off"],
      writableSettings: ["model", "effortLevel", "autopilot"],
    });
  });

  it("invalidates advertised choices when Kiro changes the model outside the deck", async () => {
    writeSession();
    const settings = new IdeSettings(sessionsDir);
    await settings.refresh([session], () => workspace);
    settings.applyConfigOptions(id, [
      { type: "select", id: "model", currentValue: "gpt-5.6-sol", options: [{ value: "gpt-5.6-sol", name: "GPT 5.6 Sol" }, { value: "auto", name: "Auto" }] },
      { type: "select", id: "effortLevel", currentValue: "xhigh", options: [{ value: "xhigh", name: "xHigh" }] },
    ]);

    writeFileSync(sessionFile(), JSON.stringify({ id, workspacePaths: [canonicalWorkspace], modelId: "auto", autopilot: true }));
    expect(await settings.refresh([session], () => workspace)).toBe(true);
    expect(settings.view(session)).toMatchObject({ model: { value: "auto" }, effortLevels: [], writableSettings: [] });
    expect(settings.view(session).effort).toBeUndefined();
  });

  it("hides values when the file is malformed, mismatched or missing", async () => {
    const settings = new IdeSettings(sessionsDir);
    writeFileSync(sessionFile(), "not json");
    expect(await settings.refresh([session], () => workspace)).toBe(false);
    expect(settings.view(session)).toMatchObject({ metadataAvailable: false, models: [], effortLevels: [] });

    writeFileSync(sessionFile(), JSON.stringify({ id: "sess_someone_else", modelId: "auto" }));
    expect(await settings.refresh([session], () => workspace)).toBe(false);
    expect(settings.view(session).model).toBeUndefined();

    expect(await settings.refresh([{ ...session, id: "../outside" }], () => workspace)).toBe(false);
  });
});
