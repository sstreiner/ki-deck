import {
  action,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { Bridge } from "../bridge";
import { isGateCategory, type GateCategory } from "../bridge/tools";
import { renderGate, svgDataUrl } from "../render/tiles";
import { Flash } from "./flash";

const LABEL: Record<GateCategory, string> = { shell: "Shell", write: "Write", mcp: "MCP" };

type GateSettings = {
  /** Which gate this key switches. Default: shell. */
  category?: GateCategory;
};

const categoryOf = (settings: GateSettings): GateCategory => (isGateCategory(settings.category) ? settings.category : "shell");

/**
 * Turns a gate on or off, as `ki-deck gate <category> on|off` does. Each press toggles.
 * On: calls in the category wait for Allow or Deny on the deck. Off: Kiro decides as usual,
 * and calls still waiting go to Kiro's own prompt.
 */
@action({ UUID: "net.streiner.ki-deck.gate" })
export class GateKey extends SingletonAction<GateSettings> {
  private readonly images = new Map<string, string>();
  private readonly categories = new Map<string, GateCategory>();
  private readonly flash = new Flash((id) => {
    this.images.delete(id);
    void this.renderAll();
  });

  constructor(private readonly bridge: Bridge) {
    super();
    bridge.on("changed", () => void this.renderAll());
  }

  override async onWillAppear(ev: WillAppearEvent<GateSettings>): Promise<void> {
    this.categories.set(ev.action.id, categoryOf(ev.payload.settings));
    this.images.delete(ev.action.id);
    await this.renderAll();
  }

  override onWillDisappear(ev: WillDisappearEvent<GateSettings>): void {
    this.categories.delete(ev.action.id);
    this.images.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<GateSettings>): Promise<void> {
    this.categories.set(ev.action.id, categoryOf(ev.payload.settings));
    this.images.delete(ev.action.id);
    await this.renderAll();
  }

  override async onKeyDown(ev: KeyDownEvent<GateSettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    const category = categoryOf(ev.payload.settings);
    const on = !this.bridge.isGated(category);
    try {
      await this.bridge.setGate(category, on);
      await this.flash.show(ev.action, on ? "gate-on" : "gate-off", LABEL[category]);
    } catch {
      await this.flash.show(ev.action, "nope", "could not switch");
    }
  }

  private async renderAll(): Promise<void> {
    for (const a of this.actions) {
      const category = this.categories.get(a.id);
      if (!a.isKey() || !category || this.flash.active(a.id)) continue;
      const on = this.bridge.isGated(category);
      const image = svgDataUrl(renderGate(category, on, this.bridge.lockdown));
      if (this.images.get(a.id) === image) continue;
      this.images.set(a.id, image);
      await a.setState(on ? 1 : 0);
      await a.setImage(image);
    }
  }
}
