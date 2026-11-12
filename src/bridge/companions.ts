// Companion extensions connected to the bridge, one per Kiro window. Each holds a stream open
// (`POST /v1/companion/connect`) that the bridge writes commands to, one JSON object per line.
// A command goes to the window that owns the session: the one that reported the session's context,
// else the one whose workspace folder contains the session's folder.

import { randomUUID } from "node:crypto";
import { ideRootFor } from "./focus";

export type ConfigId = "model" | "effortLevel" | "autopilot";

/** What a window does when the bridge sends it a command. */
export type CompanionCommand =
  | { kind: "focus"; sessionId: string }
  | { kind: "terminal"; tty: string }
  | { kind: "set_config"; requestId: string; sessionId: string; configId: ConfigId; value: string };

export interface CompanionConfigResult {
  ok: boolean;
  configOptions?: unknown;
  error?: string;
}

export interface CompanionInfo {
  pid: number;
  version: string;
  folders: string[];
}

interface Link {
  info: CompanionInfo;
  write: (line: string) => void;
  sessions: Set<string>;
}

interface PendingConfig {
  link: Link;
  sessionId: string;
  resolve: (result: CompanionConfigResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const MAX_FOLDERS = 64;
const CONFIG_TIMEOUT_MS = 12_000;

/** Reads the hello a companion sends when it opens its stream. Undefined when unusable. */
export function parseCompanionInfo(value: unknown): CompanionInfo | undefined {
  const v = value as { pid?: unknown; version?: unknown; folders?: unknown } | null;
  if (typeof v !== "object" || v === null) return undefined;
  if (typeof v.pid !== "number" || !Number.isInteger(v.pid) || v.pid <= 1) return undefined;
  const folders = Array.isArray(v.folders) ? v.folders.filter((f): f is string => typeof f === "string" && f.startsWith("/")).slice(0, MAX_FOLDERS) : [];
  return { pid: v.pid, version: typeof v.version === "string" ? v.version.slice(0, 32) : "", folders };
}

export class Companions {
  private readonly links = new Set<Link>();
  private readonly pendingConfig = new Map<string, PendingConfig>();
  private readonly ownerGenerations = new Map<string, number>();

  /** A companion opened its stream. Returns what to call when the stream closes. */
  add(info: CompanionInfo, write: (line: string) => void): () => void {
    const link: Link = { info, write, sessions: new Set() };
    this.links.add(link);
    return () => {
      this.links.delete(link);
      for (const sessionId of link.sessions) this.bumpGeneration(sessionId);
      for (const [id, pending] of this.pendingConfig) {
        if (pending.link !== link) continue;
        clearTimeout(pending.timer);
        this.pendingConfig.delete(id);
        pending.reject(new Error("Kiro companion disconnected"));
      }
    };
  }

  /** The companion in process `pid` reported this session. True when its owner changed. */
  claim(pid: number, sessionId: string): boolean {
    const owner = [...this.links].reverse().find((link) => link.info.pid === pid);
    if (!owner) return false;
    const previous = this.claimedOwner(sessionId);
    if (previous === owner) return false;
    for (const link of this.links) {
      if (link === owner) link.sessions.add(sessionId);
      else link.sessions.delete(sessionId);
    }
    this.bumpGeneration(sessionId);
    for (const [id, pending] of this.pendingConfig) {
      if (pending.sessionId === sessionId && pending.link !== owner) this.rejectPending(id, pending, "Kiro session moved to another window");
    }
    return true;
  }

  /** Sends a command to the window that owns the session. False when no companion has it. */
  send(sessionId: string, cwd: string, command: CompanionCommand): boolean {
    const link = this.owner(sessionId, cwd);
    if (!link) return false;
    link.write(`${JSON.stringify(command)}\n`);
    return true;
  }

  /** Sends one session-scoped setting request and waits for that same window's result. */
  requestConfig(sessionId: string, configId: ConfigId, value: string): Promise<CompanionConfigResult> {
    const link = this.claimedOwner(sessionId);
    if (!link) return Promise.reject(new Error("no Kiro companion has claimed this session"));
    const requestId = `config-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingConfig.delete(requestId);
        reject(new Error("Kiro did not answer the setting request"));
      }, CONFIG_TIMEOUT_MS);
      timer.unref();
      this.pendingConfig.set(requestId, { link, sessionId, resolve, reject, timer });
      try {
        link.write(`${JSON.stringify({ kind: "set_config", requestId, sessionId, configId, value } satisfies CompanionCommand)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pendingConfig.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Rejects setting requests for a session that left the registry. */
  forgetSession(sessionId: string): void {
    this.bumpGeneration(sessionId);
    for (const [id, pending] of this.pendingConfig) {
      if (pending.sessionId !== sessionId) continue;
      this.rejectPending(id, pending, "the selected session ended");
    }
    for (const link of this.links) link.sessions.delete(sessionId);
  }

  /** Completes a setting request only when the result came from the window that received it. */
  settleConfig(pid: number, requestId: string, result: CompanionConfigResult): boolean {
    const pending = this.pendingConfig.get(requestId);
    if (!pending || pending.link.info.pid !== pid || this.claimedOwner(pending.sessionId) !== pending.link) return false;
    clearTimeout(pending.timer);
    this.pendingConfig.delete(requestId);
    if (result.ok) pending.resolve(result);
    else pending.reject(new Error(result.error || "Kiro rejected the setting"));
    return true;
  }

  /** Monotonic token for invalidating work queued under a former owner. */
  generation(sessionId: string): number {
    return this.ownerGenerations.get(sessionId) ?? 0;
  }

  /** Whether a connected companion has explicitly reported this session from its window. */
  claims(sessionId: string): boolean {
    return this.claimedOwner(sessionId) !== undefined;
  }

  /** Best matching workspace root of the window that owns this session. */
  rootFor(sessionId: string, cwd: string): string | undefined {
    const link = this.owner(sessionId, cwd);
    if (!link) return undefined;
    return ideRootFor(cwd, link.info.folders) ?? (link.info.folders.length === 1 ? link.info.folders[0] : undefined);
  }

  sessionsFor(pid: number): string[] {
    const link = [...this.links].reverse().find((candidate) => candidate.info.pid === pid);
    return link ? [...link.sessions] : [];
  }

  list(): CompanionInfo[] {
    return [...this.links].map((link) => link.info);
  }

  private bumpGeneration(sessionId: string): void {
    this.ownerGenerations.set(sessionId, this.generation(sessionId) + 1);
  }

  private rejectPending(id: string, pending: PendingConfig, message: string): void {
    clearTimeout(pending.timer);
    this.pendingConfig.delete(id);
    pending.reject(new Error(message));
  }

  private claimedOwner(sessionId: string): Link | undefined {
    return [...this.links].reverse().find((link) => link.sessions.has(sessionId));
  }

  private owner(sessionId: string, cwd: string): Link | undefined {
    const links = [...this.links].reverse(); // after a window reload, its newest stream wins
    const claimed = this.claimedOwner(sessionId);
    if (claimed || !cwd) return claimed;
    let best: { link: Link; length: number } | undefined;
    for (const link of links) {
      const root = ideRootFor(cwd, link.info.folders);
      if (root && root.length > (best?.length ?? -1)) best = { link, length: root.length };
    }
    return best?.link;
  }
}
