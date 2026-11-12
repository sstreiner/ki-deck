import {
  action,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { Bridge } from "../bridge";
import type { Approval } from "../bridge/approvals";
import { renderDecision, svgDataUrl, type DecisionKind, type DecisionTarget, type FeedbackKind } from "../render/tiles";
import { Flash } from "./flash";

/** Stream Deck Mobile (DeviceType.StreamDeckMobile). */
const MOBILE_DEVICE_TYPE = 3;

type DecisionSettings = {
  /** Deny keys only: deny with config.json denyReasons[reasonIndex]; without it a plain deny. */
  reasonIndex?: number;
};

type Key = KeyAction<DecisionSettings>;

const deviceName = (key: Key) => (key.device.type === MOBILE_DEVICE_TYPE ? "mobile" : `device-${key.device.type}`);

/** What a press did: the feedback to show, and a line under it. */
type Outcome = { kind: FeedbackKind; detail?: string };

/**
 * Shared behavior of the keys that answer the oldest waiting approval. A press acts at once,
 * on key-down, on the call the key shows, and the key confirms what it did.
 */
abstract class DecisionKey extends SingletonAction<DecisionSettings> {
  private readonly images = new Map<string, string>();
  private readonly settings = new Map<string, DecisionSettings>();
  /** The approval each key currently shows. */
  private readonly shown = new Map<string, string | undefined>();
  private readonly flash = new Flash((id) => {
    this.images.delete(id);
    void this.renderAll();
  });

  constructor(protected readonly bridge: Bridge) {
    super();
    bridge.on("changed", () => void this.renderAll());
  }

  protected abstract kind(settings: DecisionSettings): DecisionKind;

  /** Answers the approval. Undefined when nothing happened. */
  protected abstract decide(approval: Approval, settings: DecisionSettings, key: Key): Outcome | undefined;

  override async onWillAppear(ev: WillAppearEvent<DecisionSettings>): Promise<void> {
    this.settings.set(ev.action.id, ev.payload.settings);
    this.images.delete(ev.action.id);
    await this.renderAll();
  }

  override onWillDisappear(ev: WillDisappearEvent<DecisionSettings>): void {
    this.settings.delete(ev.action.id);
    this.images.delete(ev.action.id);
    this.shown.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<DecisionSettings>): Promise<void> {
    this.settings.set(ev.action.id, ev.payload.settings);
    this.images.delete(ev.action.id);
    await this.renderAll();
  }

  override async onKeyDown(ev: KeyDownEvent<DecisionSettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    const id = this.shown.get(ev.action.id) ?? this.bridge.targetApproval()?.id;
    const approval = id ? this.bridge.approvals.get(id) : undefined;
    const outcome = approval ? this.decide(approval, ev.payload.settings, ev.action) : undefined;
    await this.flash.show(ev.action, outcome?.kind ?? "nope", outcome?.detail ?? (approval ? "not possible here" : "nothing waiting"));
  }

  private async renderAll(): Promise<void> {
    const pending = this.bridge.approvals.pending();
    const approval = pending[0];
    const presentation = this.bridge.settings.presentationMode;
    const target: DecisionTarget | undefined = approval && {
      category: approval.category,
      summary: approval.summary,
      workspace: approval.workspace,
      position: 1,
      total: pending.length,
    };
    for (const a of this.actions) {
      if (!a.isKey() || this.flash.active(a.id)) continue;
      const settings = this.settings.get(a.id) ?? {};
      this.shown.set(a.id, approval?.id);
      const kind = this.kind(settings);
      const reason = kind === "reason" ? this.bridge.settings.denyReasons[settings.reasonIndex ?? -1] : undefined;
      const image = svgDataUrl(renderDecision(kind, target, { reason, presentation }));
      if (this.images.get(a.id) === image) continue;
      this.images.set(a.id, image);
      await a.setImage(image);
    }
  }
}

const what = (approval: Approval, presentation: boolean) => (presentation ? approval.category : approval.summary);

/** Allows the oldest waiting call. */
@action({ UUID: "net.streiner.ki-deck.allow" })
export class AllowKey extends DecisionKey {
  protected kind(): DecisionKind {
    return "allow";
  }

  protected decide(approval: Approval, _settings: DecisionSettings, key: Key): Outcome | undefined {
    if (!this.bridge.decide(approval.id, "allow", { by: deviceName(key) })) return undefined;
    return { kind: "allowed", detail: what(approval, this.bridge.settings.presentationMode) };
  }
}

/** Denies the oldest waiting call, plainly or with a preset reason that the agent sees. */
@action({ UUID: "net.streiner.ki-deck.deny" })
export class DenyKey extends DecisionKey {
  protected kind(settings: DecisionSettings): DecisionKind {
    return typeof settings.reasonIndex === "number" ? "reason" : "deny";
  }

  protected decide(approval: Approval, settings: DecisionSettings, key: Key): Outcome | undefined {
    const reasonIndex = typeof settings.reasonIndex === "number" ? settings.reasonIndex : undefined;
    if (!this.bridge.decide(approval.id, "deny", { by: deviceName(key), reasonIndex })) return undefined;
    const reason = reasonIndex !== undefined ? this.bridge.settings.denyReasons[reasonIndex] : undefined;
    return { kind: "denied", detail: reason ?? what(approval, this.bridge.settings.presentationMode) };
  }
}

/** Hands the oldest waiting call to Kiro's own prompt and brings its window forward. */
@action({ UUID: "net.streiner.ki-deck.decide-in-kiro" })
export class DecideInKiroKey extends DecisionKey {
  protected kind(): DecisionKind {
    return "ask";
  }

  protected decide(approval: Approval, _settings: DecisionSettings, key: Key): Outcome | undefined {
    if (approval.source === "deck") return { kind: "nope", detail: "deck session: use Allow or Deny" };
    return this.bridge.decide(approval.id, "ask", { by: deviceName(key) }) ? { kind: "handed" } : undefined;
  }
}
