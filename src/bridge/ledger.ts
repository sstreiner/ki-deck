// Append-only event log, one JSON object per line and one file per day:
// ~/.ki-deck/data/events-YYYY-MM-DD.jsonl (mode 0600). Tool inputs are stored as a
// hash; the redacted summary is added only with ledger.storeRaw.

import { appendFile, mkdir } from "node:fs/promises";
import type { Approval, Decision } from "./approvals";
import type { Logger } from "./logger";
import type { HookMeta, Session, ToolCall } from "./sessions";
import { ledgerFile } from "./today";

export interface LedgerEntry {
  ts: string;
  event: string; // a hook event name, "Decision" for an approval outcome, "Ungated" for a call that skipped its gate
  session: string;
  surface?: HookMeta["surface"];
  workspace: string;
  tool?: string;
  category?: string;
  input?: string; // toolKey hash
  summary?: string; // only with storeRaw
  turnMs?: number;
  decision?: Decision["kind"];
  by?: string;
  waitMs?: number;
  credits?: number; // deck sessions: credits the turn used (on Stop)
}

export class Ledger {
  private warned = false;

  constructor(
    private readonly dir: string,
    private readonly log: Logger,
    /** Sees every entry as it is recorded, even if writing it fails. */
    private readonly onEntry: (entry: LedgerEntry, at: Date) => void = () => undefined,
  ) {}

  record(event: string, s: Session, storeRaw: boolean, now: Date, credits?: number): Promise<void> {
    const tool = event === "PreToolUse" ? s.lastTool : undefined;
    return this.append(now, {
      ts: now.toISOString(),
      event,
      session: s.id,
      surface: s.surface,
      workspace: s.workspace,
      ...(tool ? { tool: tool.name, category: tool.category, input: tool.key.split(":")[1] } : {}),
      ...(tool && storeRaw ? { summary: tool.summary } : {}),
      ...(event === "Stop" && s.lastTurnMs !== undefined ? { turnMs: s.lastTurnMs } : {}),
      ...(credits !== undefined ? { credits } : {}),
    });
  }

  /** A call in a gated category that ran without asking the deck. */
  ungated(s: Session, call: ToolCall, storeRaw: boolean, now: Date): Promise<void> {
    return this.append(now, {
      ts: now.toISOString(),
      event: "Ungated",
      session: s.id,
      surface: s.surface,
      workspace: s.workspace,
      tool: call.name,
      category: call.category,
      input: call.key.split(":")[1],
      ...(storeRaw ? { summary: call.summary } : {}),
    });
  }

  /** The audit trail: one line per approval outcome. */
  decision(approval: Approval, decision: Decision, storeRaw: boolean, now: Date): Promise<void> {
    return this.append(now, {
      ts: now.toISOString(),
      event: "Decision",
      session: approval.sessionId,
      workspace: approval.workspace,
      tool: approval.toolName,
      category: approval.category,
      ...(storeRaw ? { summary: approval.summary } : {}),
      decision: decision.kind,
      by: decision.by,
      waitMs: now.getTime() - approval.createdAt,
    });
  }

  private async append(now: Date, entry: LedgerEntry): Promise<void> {
    this.onEntry(entry, now);
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await appendFile(ledgerFile(this.dir, now), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (err) {
      if (!this.warned) this.log.warn(`ledger: cannot write to ${this.dir}: ${(err as Error).message}`);
      this.warned = true;
    }
  }
}
