// Read-only settings metadata for Kiro IDE sessions. Kiro owns these files; this module never
// writes them and treats their undocumented schema as optional input.

import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseSettings, type Choice, type SessionSettingsView, type Setting } from "./deck";
import type { Session } from "./sessions";

export interface IdeSessionMetadata {
  modelId?: string;
  modelName?: string;
  effortLevel?: string;
  autopilot?: boolean;
  agentMode?: string;
}

interface Entry {
  metadata: IdeSessionMetadata;
  settings: Setting[];
}

const MAX_SESSION_BYTES = 64 * 1024;
const SESSION_ID = /^sess_[A-Za-z0-9_-]{1,128}$/;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;

/** Cache of the small session.json documents belonging to registry-known IDE chats. */
export class IdeSettings {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly sessionsDir: string) {}

  async refresh(sessions: Session[], workspaceRoot: (session: Session) => string | undefined): Promise<boolean> {
    const ideSessions = sessions.filter((session) => session.surface === "ide");
    const live = new Set(ideSessions.map((session) => session.id));
    let changed = false;

    await Promise.all(
      ideSessions.map(async (session) => {
        const root = workspaceRoot(session) ?? session.cwd;
        const metadata = await this.read(session.id, root);
        const previous = this.entries.get(session.id);
        if (!metadata) {
          if (previous) {
            this.entries.delete(session.id);
            changed = true;
          }
          return;
        }
        if (!previous) {
          this.entries.set(session.id, { metadata, settings: [] });
          changed = true;
          return;
        }
        if (!sameMetadata(previous.metadata, metadata)) {
          const modelChanged = previous.metadata.modelId !== metadata.modelId;
          previous.metadata = metadata;
          if (modelChanged) previous.settings = [];
          changed = true;
        }
      }),
    );

    for (const id of this.entries.keys()) {
      if (!live.has(id)) {
        this.entries.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  view(session: Session): SessionSettingsView {
    const entry = this.entries.get(session.id);
    const metadata = entry?.metadata;
    const modelSetting = entry?.settings.find((setting) => setting.id === "model");
    const effortSetting = entry?.settings.find((setting) => setting.id === "effortLevel");
    const autopilotSetting = entry?.settings.find((setting) => setting.id === "autopilot");
    const modelId = metadata?.modelId ?? modelSetting?.current;
    const model = modelId ? modelChoice(modelId, metadata?.modelName, modelSetting) : undefined;

    return {
      id: session.id,
      cwd: session.cwd,
      workspace: session.workspace || basename(session.cwd) || session.cwd,
      working: session.state === "working",
      metadataAvailable: metadata !== undefined,
      writableSettings: entry?.settings.map((setting) => setting.id) ?? [],
      ...(model ? { model } : {}),
      models: modelSetting?.choices ?? [],
      ...(metadata?.effortLevel ?? effortSetting?.current ? { effort: metadata?.effortLevel ?? effortSetting?.current } : {}),
      effortLevels: effortSetting?.choices.map((choice) => choice.value) ?? [],
      ...(metadata?.autopilot !== undefined
        ? { autopilot: metadata.autopilot }
        : autopilotSetting
          ? { autopilot: autopilotSetting.current === "on" }
          : {}),
      autopilotValues: autopilotSetting?.choices.map((choice) => choice.value) ?? [],
    };
  }

  metadata(id: string): IdeSessionMetadata | undefined {
    return this.entries.get(id)?.metadata;
  }

  clearConfigOptions(id?: string): void {
    if (id) {
      const entry = this.entries.get(id);
      if (entry) entry.settings = [];
      return;
    }
    for (const entry of this.entries.values()) entry.settings = [];
  }

  /** Accepts only select options parsed by the same validator deck-owned sessions use. */
  applyConfigOptions(id: string, raw: unknown): boolean {
    const entry = this.entries.get(id);
    const settings = parseSettings(raw);
    if (!entry || settings.length === 0) return false;
    entry.settings = settings;
    this.updateMetadataFromSettings(entry);
    return true;
  }

  setCurrent(id: string, configId: string, value: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const setting = entry.settings.find((candidate) => candidate.id === configId);
    if (setting) setting.current = value;
    if (configId === "model") entry.metadata.modelId = value;
    if (configId === "effortLevel") entry.metadata.effortLevel = value;
    if (configId === "autopilot") entry.metadata.autopilot = value === "on";
  }

  private async read(sessionId: string, workspace: string): Promise<IdeSessionMetadata | undefined> {
    if (!SESSION_ID.test(sessionId) || !workspace) return undefined;
    try {
      const root = await realpath(workspace);
      const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
      const handle = await open(join(this.sessionsDir, hash, sessionId, "session.json"), "r");
      try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > MAX_SESSION_BYTES) return undefined;
        const parsed = JSON.parse(await handle.readFile("utf8")) as Record<string, unknown>;
        if (!parsed || typeof parsed !== "object" || parsed.id !== sessionId) return undefined;
        const roots = [...stringArray(parsed.workspacePaths), ...stringArray(parsed.rootPaths)];
        if (roots.length > 0 && !roots.includes(root)) return undefined;
        const display = parsed.contextSnapshotModelDisplay as Record<string, unknown> | undefined;
        return {
          ...(text(parsed.modelId) ? { modelId: text(parsed.modelId) } : {}),
          ...(text(display?.display) ? { modelName: text(display?.display) } : {}),
          ...(text(parsed.effortLevel) ? { effortLevel: text(parsed.effortLevel) } : {}),
          ...(typeof parsed.autopilot === "boolean" ? { autopilot: parsed.autopilot } : {}),
          ...(text(parsed.agentMode) ? { agentMode: text(parsed.agentMode) } : {}),
        };
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }

  private updateMetadataFromSettings(entry: Entry): void {
    for (const setting of entry.settings) {
      if (setting.id === "model") entry.metadata.modelId = setting.current;
      if (setting.id === "effortLevel") entry.metadata.effortLevel = setting.current;
      if (setting.id === "autopilot") entry.metadata.autopilot = setting.current === "on";
    }
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function modelChoice(id: string, name: string | undefined, setting: Setting | undefined): Choice {
  return setting?.choices.find((choice) => choice.value === id) ?? { value: id, name: name ?? id };
}

function sameMetadata(left: IdeSessionMetadata, right: IdeSessionMetadata): boolean {
  return (
    left.modelId === right.modelId &&
    left.modelName === right.modelName &&
    left.effortLevel === right.effortLevel &&
    left.autopilot === right.autopilot &&
    left.agentMode === right.agentMode
  );
}
