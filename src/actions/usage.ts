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
import type { Bridge } from "../bridge";
import { renderToday, renderUsage, renderUsageDial, svgDataUrl, type UsageView } from "../render/tiles";
import { Flash } from "./flash";
import { PressTracker } from "./press";

type UsageSettings = {
  /** "credits" (default): account credits from Kiro. "today": local activity from the ledger. */
  view?: "credits" | "today";
};

const viewOf = (settings: UsageSettings) => (settings.view === "today" ? "today" : "credits");

/**
 * Shows Kiro credits used this billing cycle, or today's activity.
 * Credits: press to refresh, hold to open the activity report. Today: press to open the report.
 * Credits come from kiro-cli (no model call), every `usage.refreshMinutes` while a key shows them.
 * As a dial (Stream Deck +) it shows credits on the touch strip; push or tap refreshes, touch and
 * hold opens the report.
 */
@action({ UUID: "net.streiner.ki-deck.usage" })
export class UsageKey extends SingletonAction<UsageSettings> {
  private readonly presses = new PressTracker();
  private readonly images = new Map<string, string>();
  private readonly views = new Map<string, "credits" | "today" | "dial">();
  private readonly flash = new Flash((id) => {
    this.images.delete(id);
    void this.renderAll();
  });

  constructor(private readonly bridge: Bridge) {
    super();
    // Today's counts change with every hook event, credits with every fetch: both emit "changed".
    bridge.on("changed", () => void this.renderAll());
    setInterval(() => void this.renderAll(), 30_000).unref(); // "old" markers, the date after midnight
  }

  override async onWillAppear(ev: WillAppearEvent<UsageSettings>): Promise<void> {
    this.setView(ev.action.id, ev.action.isDial() ? "dial" : viewOf(ev.payload.settings));
    this.images.delete(ev.action.id);
    await this.renderAll();
  }

  override onWillDisappear(ev: WillDisappearEvent<UsageSettings>): void {
    this.setView(ev.action.id, undefined);
    this.images.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<UsageSettings>): Promise<void> {
    if (!ev.action.isDial()) this.setView(ev.action.id, viewOf(ev.payload.settings));
    this.images.delete(ev.action.id);
    await this.renderAll();
  }

  override async onKeyDown(ev: KeyDownEvent<UsageSettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    if (viewOf(ev.payload.settings) === "today") {
      // Today counts live, so a press has nothing to refresh: it opens the full report instead.
      await this.report(ev.action);
      return;
    }
    this.presses.down(ev.action.id); // a hold opens the report as well
    if (await this.bridge.usage.refresh()) await this.flash.show(ev.action, "refreshed", "credits");
    else await this.flash.show(ev.action, "nope", "kiro-cli unavailable");
  }

  override async onKeyUp(ev: KeyUpEvent<UsageSettings>): Promise<void> {
    if (ev.action.isKey() && this.presses.up(ev.action.id) === "long") await this.report(ev.action);
  }

  override async onDialDown(ev: DialDownEvent<UsageSettings>): Promise<void> {
    if (!(await this.bridge.usage.refresh())) await ev.action.showAlert();
  }

  /** Tap refreshes the credits; touch and hold opens the report. */
  override async onTouchTap(ev: TouchTapEvent<UsageSettings>): Promise<void> {
    if (ev.payload.hold) {
      await this.bridge.openReport().catch(() => ev.action.showAlert());
      return;
    }
    if (!(await this.bridge.usage.refresh())) await ev.action.showAlert();
  }

  /** Writes the activity report and opens it in the browser on the Mac. */
  private async report(key: Parameters<Flash["show"]>[0]): Promise<void> {
    try {
      await this.bridge.openReport();
      await this.flash.show(key, "opened", "report on the Mac");
    } catch {
      await this.flash.show(key, "nope", "report failed");
    }
  }

  override onDialRotate(_ev: DialRotateEvent<UsageSettings>): void {
    // Nothing to turn; the dial only shows credits.
  }

  /** Keeps the usage monitor running exactly while at least one key or dial shows credits. */
  private setView(id: string, view: "credits" | "today" | "dial" | undefined): void {
    const before = this.views.get(id);
    if (before === view) return;
    const watches = (v: string | undefined) => v === "credits" || v === "dial";
    if (watches(before)) this.bridge.usage.unwatch();
    if (watches(view)) this.bridge.usage.watch();
    if (view) this.views.set(id, view);
    else this.views.delete(id);
  }

  private async renderAll(): Promise<void> {
    const views = new Set(this.views.values());
    const view = this.usageView();
    const now = new Date();
    const credits = views.has("credits") ? svgDataUrl(renderUsage(view, now)) : "";
    const today = views.has("today") ? svgDataUrl(renderToday(this.bridge.today.value)) : "";
    const dial = views.has("dial") ? svgDataUrl(renderUsageDial(view, now)) : "";
    for (const a of this.actions) {
      const kind = this.views.get(a.id);
      if (!kind || this.flash.active(a.id)) continue;
      const image = kind === "today" ? today : kind === "dial" ? dial : credits;
      if (this.images.get(a.id) === image) continue;
      this.images.set(a.id, image);
      if (a.isDial()) await a.setFeedback({ canvas: image });
      else if (a.isKey()) await a.setImage(image);
    }
  }

  private usageView(): UsageView {
    const { snapshot, fetchedAt, error, fetching } = this.bridge.usage.state;
    const refreshMs = this.bridge.usageTiming().idleMs;
    const c = snapshot?.credits;
    return {
      plan: snapshot?.plan,
      used: c?.used,
      limit: c?.limit,
      percent: c?.percent,
      resetDate: snapshot?.resetDate,
      overageCharges: c?.overageCharges,
      currency: c?.currency,
      error,
      fetching,
      stale: fetchedAt !== undefined && Date.now() - fetchedAt > 2 * refreshMs,
    };
  }
}
