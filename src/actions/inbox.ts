import { action, type KeyDownEvent, type KeyUpEvent, SingletonAction, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import type { Bridge } from "../bridge";
import type { Setup } from "../bridge/setup";
import { renderInbox, renderInfobar, renderSetup, svgDataUrl } from "../render/tiles";
import { Flash } from "./flash";
import { PressTracker } from "./press";

/**
 * Counts sessions that are waiting on you: approvals first, then tools that may need
 * approval, then finished turns. Press: focus the first one. Hold: mark all finished turns as seen.
 * On the Stream Deck Neo infobar it shows the same count next to the credits used.
 * A packaged plugin whose Kiro side is missing shows "Set up" here instead; a press offers it.
 */
@action({ UUID: "net.streiner.ki-deck.inbox" })
export class InboxKey extends SingletonAction {
  private readonly images = new Map<string, string>();
  private readonly presses = new PressTracker();
  private readonly flash = new Flash((id) => {
    this.images.delete(id);
    void this.renderAll();
  });
  private readonly infobars = new Set<string>();

  constructor(
    private readonly bridge: Bridge,
    private readonly setup?: Setup,
  ) {
    super();
    bridge.on("changed", () => void this.renderAll());
    setup?.on("changed", () => void this.renderAll());
  }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    this.images.delete(ev.action.id);
    // The infobar shows credits too, so it keeps them fresh while it is visible.
    if (ev.action.isNeoInfobar() && !this.infobars.has(ev.action.id)) {
      this.infobars.add(ev.action.id);
      this.bridge.usage.watch();
      await ev.action.setFeedbackLayout("layouts/infobar.json"); // one full-size image, drawn like the keys
    }
    await this.renderAll();
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.images.delete(ev.action.id);
    if (this.infobars.delete(ev.action.id)) this.bridge.usage.unwatch();
  }

  override onKeyDown(ev: KeyDownEvent): void {
    this.presses.down(ev.action.id);
  }

  override async onKeyUp(ev: KeyUpEvent): Promise<void> {
    if (!ev.action.isKey()) return;
    const press = this.presses.up(ev.action.id);
    if (this.setupShown()) {
      if (!this.setup?.running) void this.setup?.offer(true); // the dialog waits for a click on the Mac
      return;
    }
    if (press === "long") {
      this.bridge.acknowledgeAll();
      await this.flash.show(ev.action, "seen", "all finished turns");
      return;
    }
    const oldest = this.bridge.inbox()[0];
    if (!press || !oldest) await this.flash.show(ev.action, "nope", "all clear");
    else if (!(await this.bridge.focus(oldest.session.id))) await this.flash.show(ev.action, "nope", "could not focus");
  }

  /**
   * The key offers the setup only while nothing reports to the deck (no hooks installed yet), or
   * while the installer runs. An update is offered by the dialog alone: the hooks still work,
   * and the Inbox must keep showing what waits.
   */
  private setupShown(): boolean {
    return this.setup !== undefined && (this.setup.running || this.setup.need() === "install");
  }

  private async renderAll(): Promise<void> {
    const inbox = this.bridge.inbox();
    const approvals = this.bridge.approvals.pending().length;
    const ungated = inbox.filter((i) => i.attention.kind === "ungated").length;
    const presentation = this.bridge.settings.presentationMode;
    const oldest = inbox[0]?.session.workspace;
    const keyImage = svgDataUrl(
      this.setupShown() ? renderSetup(this.setup?.running === true) : renderInbox(inbox.length, oldest, presentation, approvals, ungated),
    );
    const credits = this.bridge.usage.state.snapshot?.credits?.percent;
    const barImage = svgDataUrl(renderInfobar({ count: inbox.length, approvals, oldest }, credits, presentation));
    for (const a of this.actions) {
      if (this.flash.active(a.id)) continue;
      const image = a.isNeoInfobar() ? barImage : keyImage;
      if (this.images.get(a.id) === image) continue;
      this.images.set(a.id, image);
      if (a.isNeoInfobar()) await a.setFeedback({ canvas: image });
      else if (a.isKey()) await a.setImage(image);
    }
  }
}
