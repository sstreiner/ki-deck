import { action, type KeyDownEvent, SingletonAction, type WillAppearEvent } from "@elgato/streamdeck";
import type { Bridge } from "../bridge";
import { renderLockdown, svgDataUrl } from "../render/tiles";
import { Flash } from "./flash";

/**
 * Blocks shell, writes and MCP in every Kiro session (the `lockdown` file kd-hook checks), and
 * stops every running deck turn. Each press toggles it.
 */
@action({ UUID: "net.streiner.ki-deck.lockdown" })
export class LockdownKey extends SingletonAction {
  private readonly images = new Map<string, string>();
  private readonly flash = new Flash((id) => {
    this.images.delete(id);
    void this.renderAll();
  });

  constructor(private readonly bridge: Bridge) {
    super();
    bridge.on("changed", () => void this.renderAll());
  }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    this.images.delete(ev.action.id);
    await this.renderAll();
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    if (!ev.action.isKey()) return;
    const on = !this.bridge.lockdown;
    try {
      await this.bridge.setLockdown(on);
      await this.flash.show(ev.action, on ? "locked" : "unlocked", on ? "every session" : "");
    } catch {
      await this.flash.show(ev.action, "nope", "could not switch");
    }
  }

  private async renderAll(): Promise<void> {
    const on = this.bridge.lockdown;
    const image = svgDataUrl(renderLockdown(on));
    for (const a of this.actions) {
      if (!a.isKey() || this.flash.active(a.id) || this.images.get(a.id) === image) continue;
      this.images.set(a.id, image);
      await a.setState(on ? 1 : 0);
      await a.setImage(image);
    }
  }
}
