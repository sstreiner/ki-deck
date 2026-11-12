// Press feedback: after a press a key shows what happened ("Allowed", "Model: Sonnet 5.5",
// "Nothing waiting") for a moment, as a short two-frame pop, then its live image returns.
// Replaces Stream Deck's generic check mark and warning triangle.

import type { KeyAction } from "@elgato/streamdeck";
import { renderFeedback, svgDataUrl, type FeedbackKind } from "../render/tiles";

/** How long the feedback stays, and when the second (full size) frame follows the first. */
export const FLASH_MS = 1100;
const POP_MS = 90;

// The SDK's settings constraint is not exported under a usable name; any key action will do.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKey = KeyAction<any>;

export class Flash {
  private readonly until = new Map<string, NodeJS.Timeout>();

  /** `restore` redraws a key's live image once its feedback is over. */
  constructor(private readonly restore: (actionId: string) => void) {}

  /** True while a key shows feedback; renderers leave it alone until then. */
  active(actionId: string): boolean {
    return this.until.has(actionId);
  }

  async show(action: AnyKey, kind: FeedbackKind, detail = ""): Promise<void> {
    clearTimeout(this.until.get(action.id));
    this.until.set(
      action.id,
      setTimeout(() => {
        this.until.delete(action.id);
        this.restore(action.id);
      }, FLASH_MS),
    );
    await action.setImage(svgDataUrl(renderFeedback(kind, detail, 0.72)));
    setTimeout(() => {
      if (this.active(action.id)) void action.setImage(svgDataUrl(renderFeedback(kind, detail, 1)));
    }, POP_MS).unref();
  }
}
