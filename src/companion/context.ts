// How full each chat's context window is, for the Session keys. Kiro pushes context usage only
// to clients subscribed to a chat, and its hub subscribes any client that sends a request naming
// the chat. The companion's main connection stays a pure observer, so each poll opens a
// short-lived connection, asks `_kiro/session/context` ("show", read-only) for the chats due, and
// closes it again, which ends those subscriptions.
//
// A chat is due `settleMs` after its roster status changes (a turn starts or ends), and every
// `workingMs` while it works. A chat waiting on the user is not asked: no model call happens
// while it waits, so its context cannot change.

/** One short-lived hub connection. */
export interface ContextSource {
  contextOf(sessionId: string): Promise<number | undefined>;
  close(): void;
}

export interface ContextPollerOptions {
  /** Opens a connection to the window's hub; undefined when there is none yet. */
  open: () => Promise<ContextSource | undefined>;
  /** Hands a value to the bridge. False when the bridge does not know the chat (yet). */
  report: (sessionId: string, percent: number) => Promise<boolean>;
  /** False while no bridge listens: nothing is asked, and `resend()` catches up later. */
  active?: () => boolean;
  /** Asks a working chat again this often; also the retry delay when the hub cannot be reached. */
  workingMs?: number;
  /** Waits this long after a status change, so the turn's last usage is in. */
  settleMs?: number;
}

const WORKING_MS = 30_000;
const SETTLE_MS = 1_500;

export class ContextPoller {
  private readonly status = new Map<string, string>();
  /** When each chat is due next. */
  private readonly due = new Map<string, number>();
  /** What the bridge last accepted, so unchanged values are not sent again. */
  private readonly reported = new Map<string, number>();
  private nextWorkingAt = Infinity;
  private timer?: ReturnType<typeof setTimeout>;
  private timerAt = Infinity;
  private polling = false;
  private stopped = false;

  constructor(private readonly options: ContextPollerOptions) {}

  private get settleMs(): number {
    return this.options.settleMs ?? SETTLE_MS;
  }

  private get workingMs(): number {
    return this.options.workingMs ?? WORKING_MS;
  }

  /** A roster update from the hub: "in_progress", "idle", "waiting_on_user", or "deleted". */
  changed(sessionId: string, status: string): void {
    if (status === "deleted") return this.forget(sessionId);
    this.status.set(sessionId, status);
    if (status === "waiting_on_user") return;
    // Sent again at every turn boundary: the bridge may have dropped and re-created the session.
    this.reported.delete(sessionId);
    this.due.set(sessionId, Date.now() + this.settleMs);
    if (status === "in_progress" && this.nextWorkingAt === Infinity) this.nextWorkingAt = Date.now() + this.workingMs;
    this.arm();
  }

  /** Asks for one chat soon, e.g. one the roster has not mentioned since this window loaded. */
  refresh(sessionId: string): void {
    this.reported.delete(sessionId);
    this.due.set(sessionId, Date.now() + this.settleMs);
    this.arm();
  }

  /** The bridge (re)connected and knows nothing yet: send every chat again. */
  resend(): void {
    this.reported.clear();
    for (const [id, status] of this.status) if (status !== "waiting_on_user") this.due.set(id, Date.now() + this.settleMs);
    this.arm();
  }

  /** The observer connection dropped: statuses may be stale, so wait for fresh roster updates. */
  resetStatuses(): void {
    this.status.clear();
    this.nextWorkingAt = Infinity;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private forget(sessionId: string): void {
    this.status.delete(sessionId);
    this.due.delete(sessionId);
    this.reported.delete(sessionId);
  }

  private working(): string[] {
    return [...this.status].filter(([, s]) => s === "in_progress").map(([id]) => id);
  }

  /** Sets the timer for the earliest due chat, or the next round over working chats. */
  private arm(): void {
    if (this.stopped || this.polling) return; // a running poll arms when it ends
    if (this.working().length === 0) this.nextWorkingAt = Infinity;
    const at = Math.min(this.nextWorkingAt, ...this.due.values());
    if (at === this.timerAt) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = at;
    if (at === Infinity) return;
    this.timer = setTimeout(() => void this.poll(), Math.max(0, at - Date.now()));
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    this.timer = undefined;
    this.timerAt = Infinity;
    this.polling = true;
    const now = Date.now();
    try {
      const ids = new Set<string>();
      for (const [id, at] of this.due) if (at <= now) ids.add(id);
      if (now >= this.nextWorkingAt) {
        for (const id of this.working()) ids.add(id);
        this.nextWorkingAt = now + this.workingMs;
      }
      for (const id of ids) this.due.delete(id);
      if (ids.size === 0) return;
      if (this.options.active && !this.options.active()) return; // resend() asks again once a bridge is back
      if (!(await this.ask([...ids]))) {
        // No hub connection: try those chats again later (working ones come back on their own).
        for (const id of ids) if (!this.due.has(id) && this.status.get(id) !== "in_progress") this.due.set(id, now + this.workingMs);
      }
    } finally {
      this.polling = false;
      this.arm();
    }
  }

  /** False when no hub connection opened. */
  private async ask(ids: string[]): Promise<boolean> {
    const source = await this.options.open().catch(() => undefined);
    if (!source) return false;
    try {
      for (const id of ids) {
        const percent = await source.contextOf(id).catch(() => undefined);
        if (percent === undefined || this.reported.get(id) === percent) continue;
        if (await this.options.report(id, percent).catch(() => false)) this.reported.set(id, percent);
      }
    } finally {
      source.close();
    }
    return true;
  }
}
