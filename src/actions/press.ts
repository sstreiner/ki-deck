/**
 * Holding Session, Inbox or Credits at least this long does their second action (clear, mark all
 * as seen, open the report). Their first action still happens on key-down or a short press.
 */
export const LONG_PRESS_MS = 500;

/** Distinguishes short and long presses per key (Stream Deck only reports down and up). */
export class PressTracker {
  private readonly downAt = new Map<string, number>();

  down(actionId: string, now = Date.now()): void {
    this.downAt.set(actionId, now);
  }

  /** "long", "short", or undefined when no matching key-down was seen. */
  up(actionId: string, now = Date.now()): "long" | "short" | undefined {
    const start = this.downAt.get(actionId);
    this.downAt.delete(actionId);
    if (start === undefined) return undefined;
    return now - start >= LONG_PRESS_MS ? "long" : "short";
  }
}
