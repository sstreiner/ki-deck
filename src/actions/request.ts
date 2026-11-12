import {
  action,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { Bridge } from "../bridge";
import { renderRequest, svgDataUrl, type RequestView } from "../render/tiles";
import { Flash } from "./flash";

type RequestSettings = {
  /** This key's place in the banner (0 = header). Without it, Request keys on a device fill in key order. */
  part?: number;
  /** How many keys the banner spans. Without it, the number of Request keys on the device. */
  parts?: number;
};

interface BannerKey {
  settings: RequestSettings;
  deviceId: string;
  row: number;
  column: number;
  image?: string;
}

/**
 * The request banner: the oldest call waiting for the deck, in full, across a row of keys
 * (the same call Allow and Deny act on). Press: bring that session's window forward.
 */
@action({ UUID: "net.streiner.ki-deck.request" })
export class RequestKey extends SingletonAction<RequestSettings> {
  private readonly keys = new Map<string, BannerKey>();
  private readonly flash = new Flash((id) => {
    const key = this.keys.get(id);
    if (key) key.image = undefined;
    void this.renderAll();
  });

  constructor(private readonly bridge: Bridge) {
    super();
    bridge.on("changed", () => void this.renderAll());
    setInterval(() => void this.renderAll(), 1000).unref(); // the waiting time
  }

  override async onWillAppear(ev: WillAppearEvent<RequestSettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    const at = ev.action.coordinates ?? { row: 0, column: 0 };
    this.keys.set(ev.action.id, { settings: ev.payload.settings, deviceId: ev.action.device.id, row: at.row, column: at.column });
    this.resetImages();
    await this.renderAll();
  }

  override async onWillDisappear(ev: WillDisappearEvent<RequestSettings>): Promise<void> {
    this.keys.delete(ev.action.id);
    this.resetImages();
    await this.renderAll();
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<RequestSettings>): Promise<void> {
    const key = this.keys.get(ev.action.id);
    if (key) key.settings = ev.payload.settings;
    this.resetImages();
    await this.renderAll();
  }

  override async onKeyDown(ev: KeyDownEvent<RequestSettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    const approval = this.bridge.targetApproval();
    if (!approval) await this.flash.show(ev.action, "nope", "nothing waiting");
    else if (!(await this.bridge.focus(approval.sessionId))) await this.flash.show(ev.action, "nope", "could not focus");
  }

  /** Adding or removing a key changes every key's place in the banner. */
  private resetImages(): void {
    for (const key of this.keys.values()) key.image = undefined;
  }

  /** This key's part and the banner's length on its device. */
  private placeOf(id: string, key: BannerKey): { part: number; parts: number } {
    const automatic = [...this.keys.entries()]
      .filter(([, k]) => k.deviceId === key.deviceId && typeof k.settings.part !== "number")
      .sort(([, a], [, b]) => a.row - b.row || a.column - b.column);
    if (typeof key.settings.part === "number") {
      const parts = typeof key.settings.parts === "number" ? key.settings.parts : key.settings.part + 1;
      return { part: key.settings.part, parts: Math.max(parts, key.settings.part + 1) };
    }
    return { part: automatic.findIndex(([otherId]) => otherId === id), parts: automatic.length };
  }

  private async renderAll(): Promise<void> {
    const pending = this.bridge.approvals.pending();
    const approval = pending[0];
    const view: RequestView | undefined = approval && {
      category: approval.category,
      detail: approval.detail,
      workspace: approval.workspace,
      waitedMs: Date.now() - approval.createdAt,
      position: 1,
      total: pending.length,
    };
    const presentation = this.bridge.settings.presentationMode;
    for (const a of this.actions) {
      const key = this.keys.get(a.id);
      if (!a.isKey() || !key || this.flash.active(a.id)) continue;
      const { part, parts } = this.placeOf(a.id, key);
      const image = svgDataUrl(renderRequest(view, part, parts, presentation));
      if (image === key.image) continue;
      key.image = image;
      await a.setImage(image);
    }
  }
}
