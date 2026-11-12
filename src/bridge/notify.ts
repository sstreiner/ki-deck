// macOS notifications. Uses terminal-notifier when installed (a click brings the session's
// app forward), otherwise AppleScript's display notification. With `notifications.push` set,
// the same moments also go to the phone (push.ts), with less detail: never a command or file.

import type { Approval } from "./approvals";
import type { Config } from "./config";
import { inQuietHours } from "./config";
import { appBundleFor } from "./focus";
import type { PushEvent, Pusher } from "./push";
import type { Session, ToolCall } from "./sessions";
import type { Executables, Runner } from "./system";

const DISPLAY_NOTIFICATION = `on run argv
  display notification (item 2 of argv) with title (item 1 of argv) sound name (item 3 of argv)
end run`;

export class Notifier {
  constructor(
    private readonly config: () => Config,
    private readonly bins: Executables,
    private readonly run: Runner,
    private readonly now: () => Date = () => new Date(),
    private readonly pusher?: Pusher,
  ) {}

  async turnFinished(s: Session, turnMs: number): Promise<void> {
    const text = `Finished after ${formatDuration(turnMs)}. Waiting for you.`;
    await Promise.all([this.send(s, text), this.push(s, "finished", text)]);
  }

  /** Once per session until the user has seen it. */
  async ungated(s: Session, call: ToolCall): Promise<void> {
    const what = this.config().presentationMode ? call.category : `${call.category}: ${call.summary}`;
    await Promise.all([
      this.send(s, `Ran ${what} without asking Stream Deck. Its gate hook may not be loaded.`),
      this.push(s, "ungated", `Ran ${call.category} without asking Stream Deck.`),
    ]);
  }

  mayNeedYou(s: Session): Promise<void> {
    const tool = s.pending[0];
    return this.send(s, `Waiting on ${tool ? tool.category : "a tool"} for a while. It may need your approval.`);
  }

  /**
   * Sent even during quiet hours: the agent is blocked until someone answers. The Mac is told at
   * once; the phone only if the call still waits after `approvalDelaySeconds` (push.ts).
   */
  async approvalWaiting(s: Session, approval: Approval): Promise<void> {
    const what = this.config().presentationMode ? approval.category : `${approval.category}: ${approval.summary}`;
    this.pusher?.schedule(
      { event: "approval", title: this.pushTitle(s), message: `Wants to run ${approval.category}. Approve on Stream Deck.`, urgent: true },
      approvalKey(approval),
    );
    await this.send(s, `Wants to run ${what}. Approve on Stream Deck.`, true);
  }

  /** The approval was answered, handed to Kiro, or gone: its delayed push is dropped. */
  approvalSettled(approval: Approval): void {
    this.pusher?.cancel(approvalKey(approval));
  }

  /**
   * The phone gets the category only, never the command or file. `key` limits repeats to one a
   * minute: per session for finished turns and ungated calls, per call for approvals (each one
   * blocks the agent until someone answers).
   */
  private async push(s: Session, event: PushEvent, message: string, urgent = false, key = `${event}:${s.id}`): Promise<void> {
    if (!this.pusher) return;
    await this.pusher.send({ event, title: this.pushTitle(s), message, urgent }, key);
  }

  private pushTitle(s: Session): string {
    return this.config().presentationMode ? "Kiro" : `Kiro: ${s.workspace || "session"}`;
  }

  private async send(s: Session, message: string, urgent = false): Promise<void> {
    const cfg = this.config();
    if (!cfg.notifications.macos) return;
    if (!urgent && inQuietHours(cfg.notifications.quietHours, this.now())) return;
    const title = cfg.presentationMode ? "Kiro" : `Kiro: ${s.workspace || "session"}`;
    const sound = cfg.notifications.sound || "default";

    if (this.bins.terminalNotifier) {
      const result = await this.run(this.bins.terminalNotifier, [
        "-title", title,
        "-message", message,
        "-group", `ki-deck-${s.id}`,
        "-activate", appBundleFor(s),
        "-sound", sound,
      ]);
      if (result.ok) return;
    }
    await this.run("/usr/bin/osascript", ["-e", DISPLAY_NOTIFICATION, title, message, sound]);
  }
}

/** Per call: each approval blocks the agent until someone answers. */
const approvalKey = (approval: Approval) => `approval:${approval.id}`;

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}
