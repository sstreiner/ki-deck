// Today's local Kiro activity. Read from the day's ledger file once at start, then counted in
// memory as the ledger records each event, so the Today view never re-reads the file.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface TodayStats {
  sessions: number;
  prompts: number;
  turns: number;
  toolCalls: number;
  turnMs: number; // total time agents spent working on turns
  allowed: number;
  denied: number;
}

export const EMPTY_TODAY: TodayStats = { sessions: 0, prompts: 0, turns: 0, toolCalls: 0, turnMs: 0, allowed: 0, denied: 0 };

/** The ledger fields that count. */
export interface CountedEntry {
  event?: string;
  session?: string;
  turnMs?: number;
  decision?: string;
}

export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function ledgerFile(dir: string, date: Date): string {
  return join(dir, `events-${localDate(date)}.jsonl`);
}

function count(stats: TodayStats, sessions: Set<string>, e: CountedEntry): void {
  if (typeof e.session === "string" && e.event !== "Decision") {
    sessions.add(e.session);
    stats.sessions = sessions.size;
  }
  switch (e.event) {
    case "UserPromptSubmit":
      stats.prompts++;
      break;
    case "Stop":
      stats.turns++;
      if (typeof e.turnMs === "number") stats.turnMs += e.turnMs;
      break;
    case "PreToolUse":
      stats.toolCalls++;
      break;
    case "Decision":
      if (e.decision === "allow") stats.allowed++;
      else if (e.decision === "deny") stats.denied++;
      break;
  }
}

function eachEntry(text: string, fn: (e: CountedEntry) => void): void {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      fn(JSON.parse(line));
    } catch {
      // not a ledger line
    }
  }
}

/** Counts one day's ledger lines. Lines that are not valid JSON are skipped. */
export function summarizeLedger(text: string): TodayStats {
  const stats = { ...EMPTY_TODAY };
  const sessions = new Set<string>();
  eachEntry(text, (e) => count(stats, sessions, e));
  return stats;
}

/** Today's counts. Starts over at local midnight. */
export class Today {
  private day = "";
  private stats = { ...EMPTY_TODAY };
  private sessions = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly now: () => number,
  ) {}

  get value(): TodayStats {
    this.rollOver(new Date(this.now()));
    return this.stats;
  }

  /** Reads today's ledger file. Call before events arrive, or they are counted twice. */
  async load(): Promise<void> {
    const date = new Date(this.now());
    this.reset(localDate(date));
    let text = "";
    try {
      text = await readFile(ledgerFile(this.dir, date), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    eachEntry(text, (e) => count(this.stats, this.sessions, e));
  }

  /** Counts an entry the ledger just recorded. */
  add(entry: CountedEntry, at: Date): void {
    this.rollOver(at);
    count(this.stats, this.sessions, entry);
  }

  private rollOver(at: Date): void {
    const day = localDate(at);
    if (day !== this.day) this.reset(day);
  }

  private reset(day: string): void {
    this.day = day;
    this.stats = { ...EMPTY_TODAY };
    this.sessions = new Set();
  }
}
