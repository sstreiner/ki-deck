// Pending approvals: one per gated tool call, held until a key decides, the timeout passes,
// or Kiro stops waiting (kd-hook's connection closes). Oldest first.

import { randomUUID } from "node:crypto";

export type DecisionKind = "allow" | "deny" | "ask";

export interface Decision {
  kind: DecisionKind;
  /** Text for the agent (deny) or for Kiro's prompt (ask). */
  reason?: string;
  /** Who decided: a device type name, "timeout", "lockdown", "cancelled". */
  by: string;
}

export interface Approval {
  id: string;
  sessionId: string;
  workspace: string;
  category: string;
  toolName: string;
  summary: string; // one short line, for single keys
  detail: string; // the whole request, redacted, for the request banner
  createdAt: number;
  /** Where it comes from: a gate hook (undefined), a native IDE prompt, or a deck session. */
  source?: "companion" | "deck";
}

export interface RequestOptions {
  timeoutMs: number;
  onTimeout: () => Decision;
  signal?: AbortSignal;
}

interface Entry {
  approval: Approval;
  resolve: (decision: Decision) => void;
  timer: NodeJS.Timeout;
}

export class ApprovalQueue {
  private readonly entries = new Map<string, Entry>(); // Map keeps insertion order: oldest first

  constructor(private readonly onChange: (approval: Approval, decision?: Decision) => void) {}

  /** Adds a pending approval. The promise always resolves, never rejects. */
  request(fields: Omit<Approval, "id">, options: RequestOptions): { approval: Approval; decision: Promise<Decision> } {
    const approval: Approval = { id: randomUUID(), ...fields };
    const decision = new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => this.settle(approval.id, options.onTimeout()), options.timeoutMs);
      this.entries.set(approval.id, { approval, resolve, timer });
    });
    if (options.signal?.aborted) this.settle(approval.id, { kind: "ask", by: "cancelled" });
    options.signal?.addEventListener("abort", () => this.settle(approval.id, { kind: "ask", by: "cancelled" }), { once: true });
    this.onChange(approval);
    return { approval, decision };
  }

  /** Resolves one approval. False if it was already decided or never existed. */
  settle(id: string, decision: Decision): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(id);
    entry.resolve(decision);
    this.onChange(entry.approval, decision);
    return true;
  }

  settleAll(decision: Decision): number {
    const ids = [...this.entries.keys()];
    for (const id of ids) this.settle(id, decision);
    return ids.length;
  }

  pending(): Approval[] {
    return [...this.entries.values()].map((e) => e.approval);
  }

  get(id: string): Approval | undefined {
    return this.entries.get(id)?.approval;
  }

  forSession(sessionId: string): Approval[] {
    return this.pending().filter((a) => a.sessionId === sessionId);
  }
}
