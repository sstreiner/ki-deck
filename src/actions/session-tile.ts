import {
  action,
  type DialDownEvent,
  type DialRotateEvent,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type KeyUpEvent,
  SingletonAction,
  type TouchTapEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { Bridge, ClearResult } from "../bridge";
import { shortModelName } from "../bridge/deck";
import type { Session } from "../bridge/sessions";
import { renderSessionDial, renderSessionTile, SPINNER_FRAME_MS, svgDataUrl, tileModel, type FeedbackKind, type TileModel } from "../render/tiles";
import { Flash } from "./flash";
import { PressTracker } from "./press";

type SessionTileSettings = {
  /** Which session to show (0 = first). Without it, tiles fill in key order. */
  slot?: number;
};

interface TileKey {
  settings: SessionTileSettings;
  deviceId: string;
  row: number;
  column: number;
  dial: boolean;
  /** Dials: the selected position in the session list (rotate to change). */
  index: number;
  image?: string;
  sessionId?: string;
}

const CLEARED: Record<ClearResult, { kind: FeedbackKind; detail: string }> = {
  acknowledged: { kind: "seen", detail: "" },
  dismissed: { kind: "removed", detail: "until it is active" },
  busy: { kind: "nope", detail: "still working" },
  gone: { kind: "nope", detail: "no session" },
};

/**
 * Shows one Kiro session: workspace, state, current tool and a timer.
 * Key press: focus its window (deck sessions: make it the target of the deck keys and open its
 * transcript). Hold: mark a finished turn as seen; with nothing to mark, remove the session from
 * the deck until its next activity, which closes a deck session (refused while it works or waits on you).
 * Dial (Stream Deck +): rotate to pick a session, push or tap to focus it, touch and hold to clear it.
 */
@action({ UUID: "net.streiner.ki-deck.session" })
export class SessionTile extends SingletonAction<SessionTileSettings> {
  private readonly keys = new Map<string, TileKey>();
  private readonly presses = new PressTracker();
  private readonly flash = new Flash((id) => {
    const key = this.keys.get(id);
    if (key) key.image = undefined;
    void this.renderAll();
  });

  private rendering = false;
  private renderAgain = false;
  /** A key or dial shows the Working spinner, so frames come at the spinner's rate. */
  private animating = false;

  constructor(private readonly bridge: Bridge) {
    super();
    bridge.on("changed", () => void this.renderAll());
    this.tick();
  }

  /**
   * Keeps timers and the Working spinner current: a redraw on every spinner frame while a
   * session works, else once a second. Each lands just after a frame or second boundary, so the
   * spinner steps evenly. An image is only sent when it changed.
   */
  private tick(): void {
    void this.renderAll().then(() => {
      const period = this.animating ? SPINNER_FRAME_MS : 1000;
      setTimeout(() => this.tick(), period - (Date.now() % period) + 5).unref();
    });
  }

  override async onWillAppear(ev: WillAppearEvent<SessionTileSettings>): Promise<void> {
    const at = ev.action.coordinates ?? { row: 0, column: 0 };
    this.keys.set(ev.action.id, {
      settings: ev.payload.settings,
      deviceId: ev.action.device.id,
      row: at.row,
      column: at.column,
      dial: ev.action.isDial(),
      index: 0,
    });
    await this.renderAll();
  }

  override async onWillDisappear(ev: WillDisappearEvent<SessionTileSettings>): Promise<void> {
    this.keys.delete(ev.action.id);
    await this.renderAll();
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SessionTileSettings>): Promise<void> {
    const key = this.keys.get(ev.action.id);
    if (key) key.settings = ev.payload.settings;
    await this.renderAll();
  }

  override onKeyDown(ev: KeyDownEvent<SessionTileSettings>): void {
    this.presses.down(ev.action.id);
  }

  override async onKeyUp(ev: KeyUpEvent<SessionTileSettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    const press = this.presses.up(ev.action.id);
    const sessionId = this.keys.get(ev.action.id)?.sessionId;
    if (!press || !sessionId) {
      await this.flash.show(ev.action, "nope", "no session");
      return;
    }
    if (press === "long") {
      const cleared = CLEARED[this.bridge.clear(sessionId)];
      await this.flash.show(ev.action, cleared.kind, cleared.detail);
    } else if (!(await this.bridge.focus(sessionId))) {
      await this.flash.show(ev.action, "nope", "could not focus");
    } else if (this.bridge.registry.get(sessionId)?.surface === "deck") {
      await this.flash.show(ev.action, "opened", "transcript; deck keys follow");
    }
  }

  override async onDialRotate(ev: DialRotateEvent<SessionTileSettings>): Promise<void> {
    const key = this.keys.get(ev.action.id);
    if (!key) return;
    const count = this.bridge.registry.all().length;
    key.index = Math.max(0, Math.min(Math.max(0, count - 1), key.index + Math.sign(ev.payload.ticks)));
    key.image = undefined;
    await this.renderAll();
  }

  override async onDialDown(ev: DialDownEvent<SessionTileSettings>): Promise<void> {
    const sessionId = this.keys.get(ev.action.id)?.sessionId;
    if (!sessionId || !(await this.bridge.focus(sessionId))) await ev.action.showAlert();
  }

  override async onTouchTap(ev: TouchTapEvent<SessionTileSettings>): Promise<void> {
    const sessionId = this.keys.get(ev.action.id)?.sessionId;
    if (!sessionId) return ev.action.showAlert();
    if (ev.payload.hold) {
      const result = this.bridge.clear(sessionId);
      if (result === "busy" || result === "gone") await ev.action.showAlert();
    } else if (!(await this.bridge.focus(sessionId))) {
      await ev.action.showAlert();
    }
  }

  private slotOf(id: string, key: TileKey): number {
    if (key.dial) return key.index;
    if (typeof key.settings.slot === "number" && key.settings.slot >= 0) return key.settings.slot;
    const automatic = [...this.keys.entries()]
      .filter(([, k]) => !k.dial && k.deviceId === key.deviceId && typeof k.settings.slot !== "number")
      .sort(([, a], [, b]) => a.row - b.row || a.column - b.column);
    return automatic.findIndex(([otherId]) => otherId === id);
  }

  private model(session: Session, now: number): TileModel {
    const deck = session.surface === "deck" ? this.bridge.deck.get(session.id) : undefined;
    const info = deck && { model: deck.model && shortModelName(deck.model.name), credits: deck.lastTurnCredits, context: deck.contextPercent };
    return tileModel(session, this.bridge.attention(session), now, this.bridge.settings.presentationMode, info);
  }

  /**
   * One redraw at a time, so frames reach a key in order; a request meanwhile redraws once more.
   * Never rejects: a key that went away mid-redraw is simply drawn again on the next frame.
   */
  private async renderAll(): Promise<void> {
    if (this.rendering) {
      this.renderAgain = true;
      return;
    }
    this.rendering = true;
    try {
      do {
        this.renderAgain = false;
        await this.draw().catch(() => undefined);
      } while (this.renderAgain);
    } finally {
      this.rendering = false;
    }
  }

  private async draw(): Promise<void> {
    const now = Date.now();
    const count = this.bridge.registry.all().length;
    let animating = false;
    for (const a of this.actions) {
      const key = this.keys.get(a.id);
      if (!key || this.flash.active(a.id)) continue;
      if (key.dial) key.index = Math.min(key.index, Math.max(0, count - 1));
      const session = this.bridge.sessionAt(this.slotOf(a.id, key));
      key.sessionId = session?.id;
      const model = session && this.model(session, now);
      if (model?.state === "working") animating = true;
      if (a.isDial()) {
        const image = svgDataUrl(renderSessionDial(model, key.index, count, now));
        if (image === key.image) continue;
        key.image = image;
        await a.setFeedback({ canvas: image });
      } else if (a.isKey()) {
        const image = svgDataUrl(renderSessionTile(model, now));
        if (image === key.image) continue;
        key.image = image;
        await a.setImage(image);
      }
    }
    this.animating = animating;
  }
}
