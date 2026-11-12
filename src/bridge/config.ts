// Reads ~/.ki-deck/config.json and fills in defaults for anything missing, so
// older config files keep working when new settings are added.

import { readFileSync, unwatchFile, watchFile } from "node:fs";
import type { Logger } from "./logger";

export interface Config {
  gate: { timeoutSeconds: number; onTimeout: "ask" | "deny" };
  denyReasons: string[];
  cannedPrompts: string[];
  notifications: {
    macos: boolean;
    sound: string;
    push: unknown;
    quietHours: string;
    minTurnSeconds: number; // notify when a turn of at least this length finishes
    mayNeedYou: boolean; // also notify for the "may need you" heuristic
  };
  attention: { mayNeedYouSeconds: number };
  usage: {
    activeSeconds: number; // credits refresh while an agent is working
    refreshMinutes: number; // credits refresh otherwise
  };
  staleAfterMinutes: number;
  idleExpiryHours: number;
  presentationMode: boolean;
  ledger: { storeRaw: boolean };
  deck: {
    autopilot: boolean; // deck sessions start in Autopilot (true) or Supervised (false)
    models: string[]; // model IDs for the model keys, in order; empty: Kiro's advertised order
  };
  budget: {
    warnPercent: number; // from this share of the cycle's credits, model keys mark models above 1x (0: off)
  };
}

export const DEFAULT_CONFIG: Config = {
  gate: { timeoutSeconds: 590, onTimeout: "ask" },
  // Language- and tool-neutral on purpose: they steer how the agent solves a problem, whether it
  // writes TypeScript, Terraform or an Ansible playbook. Project rules belong in config.json.
  denyReasons: ["Explain your plan first", "Find the root cause first", "Keep the change minimal", "Do a dry run first"],
  cannedPrompts: ["Continue", "Check your work and fix issues", "Summarize what you changed"],
  notifications: { macos: true, sound: "Glass", push: null, quietHours: "22:00-07:00", minTurnSeconds: 30, mayNeedYou: false },
  attention: { mayNeedYouSeconds: 10 },
  usage: { activeSeconds: 15, refreshMinutes: 10 },
  staleAfterMinutes: 10,
  idleExpiryHours: 8,
  presentationMode: false,
  ledger: { storeRaw: false },
  deck: { autopilot: false, models: [] },
  budget: { warnPercent: 85 },
};

/** Recursively overlays `value` on `base`, keeping base types where the file has the wrong type. */
export function mergeConfig<T>(base: T, value: unknown): T {
  if (Array.isArray(base)) return (Array.isArray(value) ? value : base) as T;
  if (typeof base === "object" && base !== null) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return base;
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, baseValue] of Object.entries(base as Record<string, unknown>)) {
      if (key in value) out[key] = mergeConfig(baseValue, (value as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  if (base === null) return (value ?? null) as T;
  return (typeof value === typeof base ? value : base) as T;
}

/** True when `date` falls inside a "HH:MM-HH:MM" window (which may wrap past midnight). */
export function inQuietHours(window: string, date: Date): boolean {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(window.trim());
  if (!m) return false;
  const [start, end] = [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])];
  const now = date.getHours() * 60 + date.getMinutes();
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

export class ConfigStore {
  private current: Config = DEFAULT_CONFIG;

  constructor(
    private readonly path: string,
    private readonly log: Logger,
  ) {}

  get value(): Config {
    return this.current;
  }

  load(): void {
    try {
      this.current = mergeConfig(DEFAULT_CONFIG, JSON.parse(readFileSync(this.path, "utf8")));
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      if (!missing) this.log.warn(`config: ${this.path} is not valid JSON, using defaults`);
      this.current = DEFAULT_CONFIG;
    }
  }

  watch(): void {
    watchFile(this.path, { interval: 2000 }, () => {
      this.load();
      this.log.info("config reloaded");
    });
  }

  unwatch(): void {
    unwatchFile(this.path);
  }
}
