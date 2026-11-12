// Session setting keys: Model, Effort and Autonomy target the last selected IDE or deck session.
// Stop and Prompt remain deck-owned controls. Every press shows what it did; unavailable IDE
// metadata stays blank, and unconfirmed/offline hub settings stay visible but read-only.

import {
  action,
  type DialAction,
  type DialDownEvent,
  type DialRotateEvent,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type TouchTapEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { Bridge } from "../bridge";
import { shortModelName, type SessionSettingsView } from "../bridge/deck";
import {
  renderAutonomy,
  renderEffort,
  renderEffortDial,
  renderModel,
  renderModelDial,
  renderPrompt,
  renderStop,
  svgDataUrl,
  type DeckKeyTarget,
  type FeedbackKind,
} from "../render/tiles";
import { Flash } from "./flash";

/** The settings type Stream Deck actions take (the SDK does not export its name). */
type JsonObject = SingletonAction extends SingletonAction<infer T> ? T : never;

/** What a press did. */
type Outcome = { kind: FeedbackKind; detail?: string };

const NO_SESSION: Outcome = { kind: "nope", detail: "no deck session" };

/** Redraws every visible key of an action when the bridge changes (and every second, for timers). */
abstract class DeckKey<S extends JsonObject> extends SingletonAction<S> {
  protected readonly images = new Map<string, string>();
  private readonly settings = new Map<string, S>();
  private readonly flash = new Flash((id) => {
    this.images.delete(id);
    void this.renderAll();
  });

  constructor(protected readonly bridge: Bridge) {
    super();
    bridge.on("changed", () => void this.renderAll());
    setInterval(() => void this.renderAll(), 1000).unref();
  }

  /** The key image, and the state for two-state actions. */
  protected abstract render(settings: S, target: SessionSettingsView | undefined): { image: string; state?: number };

  /** The press. Rejecting shows "nothing to do" with the error. */
  protected abstract press(settings: S, target: SessionSettingsView | undefined): Promise<Outcome> | Outcome;

  /** The touch-strip image for dials; undefined for actions without one. */
  protected dial(_settings: S, _target: SessionSettingsView | undefined, _actionId: string): string | undefined {
    return undefined;
  }

  /** Stop and Prompt keep the deck-owned target; setting actions override this. */
  protected target(): SessionSettingsView | undefined {
    return this.bridge.deckTarget();
  }

  override async onWillAppear(ev: WillAppearEvent<S>): Promise<void> {
    this.settings.set(ev.action.id, ev.payload.settings);
    this.images.delete(ev.action.id);
    await this.renderAll();
  }

  override onWillDisappear(ev: WillDisappearEvent<S>): void {
    this.settings.delete(ev.action.id);
    this.images.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<S>): Promise<void> {
    this.settings.set(ev.action.id, ev.payload.settings);
    this.images.delete(ev.action.id);
    await this.renderAll();
  }

  override async onKeyDown(ev: KeyDownEvent<S>): Promise<void> {
    if (!ev.action.isKey()) return;
    let outcome: Outcome;
    try {
      outcome = await this.press(ev.payload.settings, this.target());
    } catch (err) {
      outcome = { kind: "nope", detail: shortError(err) };
    }
    await this.flash.show(ev.action as KeyAction<S>, outcome.kind, outcome.detail);
  }

  protected keyTarget(target: SessionSettingsView | undefined, setting?: string): DeckKeyTarget | undefined {
    if (!target) return undefined;
    const startedAt = this.bridge.registry.get(target.id)?.turnStartedAt;
    return {
      workspace: target.workspace,
      working: target.working,
      metadataAvailable: target.metadataAvailable,
      enabled: setting === undefined || target.writableSettings.includes(setting),
      ...(target.working && startedAt !== undefined ? { workingMs: Date.now() - startedAt } : {}),
    };
  }

  protected get presentation(): boolean {
    return this.bridge.settings.presentationMode;
  }

  protected async renderAll(): Promise<void> {
    const target = this.target();
    for (const a of this.actions) {
      if (this.flash.active(a.id)) continue;
      const settings = this.settings.get(a.id) ?? ({} as S);
      if (a.isDial()) {
        const image = this.dial(settings, target, a.id);
        if (!image || this.images.get(a.id) === image) continue;
        this.images.set(a.id, image);
        await (a as DialAction<S>).setFeedback({ canvas: image });
        continue;
      }
      if (!a.isKey()) continue;
      const { image, state } = this.render(settings, target);
      const url = svgDataUrl(image);
      if (this.images.get(a.id) === url) continue;
      this.images.set(a.id, url);
      if (state !== undefined) await (a as KeyAction<S>).setState(state);
      await a.setImage(url);
    }
  }
}

function shortError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/lockdown/i.test(message)) return "lockdown is on";
  if (/no deck session/i.test(message)) return "no deck session";
  if (/is not a/i.test(message)) return "not offered";
  return "did not work";
}

type ModelSettings = {
  /** Model keys: the n-th model of config.json `deck.models` (else Kiro's list); press applies it. */
  slot?: number;
};

/** A dial's model choice before it is applied, and when it falls back to the current model. */
interface PendingModel {
  sessionId: string;
  value: string;
  timer: NodeJS.Timeout;
}

/** How long a model chosen on the dial waits for a push before the dial shows the current one again. */
const MODEL_DIAL_RESET_MS = 6000;

/**
 * Without `slot`: the target's model, press steps to the next. With `slot`: one model, press
 * applies it. As a dial: rotate to choose, push or tap to apply.
 */
@action({ UUID: "net.streiner.ki-deck.model" })
export class ModelKey extends DeckKey<ModelSettings> {
  private readonly pending = new Map<string, PendingModel>();

  protected override target(): SessionSettingsView | undefined {
    return this.bridge.settingsTarget();
  }

  protected render(settings: ModelSettings, target: SessionSettingsView | undefined) {
    const slot = typeof settings.slot === "number" && settings.slot >= 0 ? settings.slot : undefined;
    const model = slot === undefined ? target?.model : this.bridge.settingsModels()[slot];
    const current = model !== undefined && model.value === target?.model?.value;
    return {
      image: renderModel(model, this.keyTarget(target, "model"), { slot: slot !== undefined, current, presentation: this.presentation, budget: this.bridge.budgetLow() }),
    };
  }

  protected async press(settings: ModelSettings, target: SessionSettingsView | undefined): Promise<Outcome> {
    if (!target) return NO_SESSION;
    if (!target.writableSettings.includes("model")) return { kind: "nope", detail: "read only" };
    const view =
      typeof settings.slot === "number"
        ? await this.apply(this.bridge.settingsModels()[settings.slot]?.value, target)
        : await this.bridge.settingsCycle("model", target.id);
    return { kind: "model", detail: view?.model ? shortModelName(view.model.name) : "" };
  }

  protected override dial(_settings: ModelSettings, target: SessionSettingsView | undefined, actionId: string): string | undefined {
    const models = this.bridge.settingsModels();
    if (!target) return svgDataUrl(renderModelDial(undefined, { pending: false, index: 0, count: 0 }));
    if (models.length === 0) {
      return svgDataUrl(
        renderModelDial(target.model, {
          pending: false,
          workspace: this.presentation ? undefined : target.workspace,
          index: 0,
          count: target.model ? 1 : 0,
          available: target.metadataAvailable,
          enabled: false,
        }),
      );
    }
    const current = Math.max(0, models.findIndex((model) => model.value === target.model?.value));
    const pending = this.pending.get(actionId);
    const pendingIndex = pending?.sessionId === target.id ? models.findIndex((model) => model.value === pending.value) : -1;
    const chosen = pendingIndex >= 0 ? pendingIndex : current;
    const enabled = target.writableSettings.includes("model");
    return svgDataUrl(
      renderModelDial(models[chosen] ?? target.model, {
        pending: chosen !== current,
        workspace: this.presentation ? undefined : target.workspace,
        index: chosen,
        count: models.length,
        budget: this.bridge.budgetLow(),
        available: target.metadataAvailable,
        enabled,
      }),
    );
  }

  override async onDialRotate(ev: DialRotateEvent<ModelSettings>): Promise<void> {
    const models = this.bridge.settingsModels();
    const target = this.target();
    if (!target || !target.writableSettings.includes("model") || models.length === 0) return ev.action.showAlert();
    const current = Math.max(0, models.findIndex((model) => model.value === target.model?.value));
    const before = this.pending.get(ev.action.id);
    clearTimeout(before?.timer);
    const beforeIndex = before?.sessionId === target.id ? models.findIndex((model) => model.value === before.value) : -1;
    const index = Math.max(0, Math.min(models.length - 1, (beforeIndex >= 0 ? beforeIndex : current) + Math.sign(ev.payload.ticks)));
    const timer = setTimeout(() => {
      this.pending.delete(ev.action.id);
      this.images.delete(ev.action.id);
      void this.renderAll();
    }, MODEL_DIAL_RESET_MS);
    this.pending.set(ev.action.id, { sessionId: target.id, value: models[index]!.value, timer });
    await this.renderAll();
  }

  override async onDialDown(ev: DialDownEvent<ModelSettings>): Promise<void> {
    await this.applyPending(ev.action);
  }

  override async onTouchTap(ev: TouchTapEvent<ModelSettings>): Promise<void> {
    await this.applyPending(ev.action);
  }

  private async applyPending(dial: DialAction<ModelSettings>): Promise<void> {
    const chosen = this.pending.get(dial.id);
    const target = this.target();
    if (!chosen || !target || chosen.sessionId !== target.id || !target.writableSettings.includes("model")) return dial.showAlert();
    clearTimeout(chosen.timer);
    this.pending.delete(dial.id);
    try {
      await this.apply(chosen.value, target);
    } catch {
      await dial.showAlert();
    }
    this.images.delete(dial.id);
    await this.renderAll();
  }

  private apply(model: string | undefined, target: SessionSettingsView): Promise<SessionSettingsView | undefined> {
    if (!model) return Promise.reject(new Error("no session model"));
    return this.bridge.settingsSet("model", model, target.id);
  }
}

/** The target's effort level; press steps through the levels its model offers. Dial: rotate to change. */
@action({ UUID: "net.streiner.ki-deck.effort" })
export class EffortKey extends DeckKey<JsonObject> {
  protected override target(): SessionSettingsView | undefined {
    return this.bridge.settingsTarget();
  }

  protected render(_settings: JsonObject, target: SessionSettingsView | undefined) {
    return { image: renderEffort(target?.effort, this.keyTarget(target, "effortLevel"), this.presentation, target?.effortLevels ?? []) };
  }

  protected async press(_settings: JsonObject, target: SessionSettingsView | undefined): Promise<Outcome> {
    if (!target) return NO_SESSION;
    if (!target.effort) return { kind: "nope", detail: target.metadataAvailable ? "this model has none" : "no value" };
    if (!target.writableSettings.includes("effortLevel")) return { kind: "nope", detail: "read only" };
    const view = await this.bridge.settingsCycle("effortLevel", target.id);
    return { kind: "effort", detail: view.effort ?? "" };
  }

  protected override dial(_settings: JsonObject, target: SessionSettingsView | undefined): string {
    return svgDataUrl(
      renderEffortDial(target?.effort, target?.effortLevels ?? [], target?.workspace, {
        available: target?.metadataAvailable,
        enabled: target?.writableSettings.includes("effortLevel") ?? false,
      }),
    );
  }

  override async onDialRotate(ev: DialRotateEvent<JsonObject>): Promise<void> {
    const target = this.target();
    const levels = target?.effortLevels ?? [];
    if (!target?.effort || !target.writableSettings.includes("effortLevel") || levels.length === 0) return ev.action.showAlert();
    const index = Math.max(0, Math.min(levels.length - 1, levels.indexOf(target.effort) + Math.sign(ev.payload.ticks)));
    if (levels[index] === target.effort) return;
    try {
      await this.bridge.settingsSet("effortLevel", levels[index]!, target.id);
    } catch {
      await ev.action.showAlert();
    }
  }
}

/** Autopilot or Supervised for the target; each press switches. */
@action({ UUID: "net.streiner.ki-deck.autonomy" })
export class AutonomyKey extends DeckKey<JsonObject> {
  protected override target(): SessionSettingsView | undefined {
    return this.bridge.settingsTarget();
  }

  protected render(_settings: JsonObject, target: SessionSettingsView | undefined) {
    const keyTarget = this.keyTarget(target, "autopilot");
    if (keyTarget) keyTarget.enabled = this.nextValue(target) !== undefined;
    return { image: renderAutonomy(target?.autopilot, keyTarget, this.presentation), state: target?.autopilot ? 1 : 0 };
  }

  protected async press(_settings: JsonObject, target: SessionSettingsView | undefined): Promise<Outcome> {
    if (target?.autopilot === undefined) return NO_SESSION;
    const next = this.nextValue(target);
    if (!next) return { kind: "nope", detail: "read only" };
    const view = await this.bridge.settingsSet("autopilot", next, target.id);
    return view.autopilot ? { kind: "autopilot", detail: "runs tools" } : { kind: "supervised", detail: "asks first" };
  }

  private nextValue(target: SessionSettingsView | undefined): "on" | "off" | undefined {
    if (target?.autopilot === undefined || !target.writableSettings.includes("autopilot")) return undefined;
    const next = target.autopilot ? "off" : "on";
    return target.autopilotValues.includes(next) ? next : undefined;
  }
}

/** Stops the target's running turn. */
@action({ UUID: "net.streiner.ki-deck.stop" })
export class StopKey extends DeckKey<JsonObject> {
  protected render(_settings: JsonObject, target: SessionSettingsView | undefined) {
    return { image: renderStop(this.keyTarget(target), this.presentation) };
  }

  protected press(_settings: JsonObject, target: SessionSettingsView | undefined): Outcome {
    if (!target) return NO_SESSION;
    return this.bridge.deckStop(target.id) ? { kind: "stopped", detail: target.workspace } : { kind: "nope", detail: "not running" };
  }
}

type PromptSettings = {
  /** Which config.json `cannedPrompts` entry to send. Default 0. */
  promptIndex?: number;
};

/** Sends a canned prompt to the target: a new turn when idle, steering while it works. */
@action({ UUID: "net.streiner.ki-deck.prompt" })
export class PromptKey extends DeckKey<PromptSettings> {
  private promptOf(settings: PromptSettings): string | undefined {
    const index = typeof settings.promptIndex === "number" ? settings.promptIndex : 0;
    return this.bridge.settings.cannedPrompts[index];
  }

  protected render(settings: PromptSettings, target: SessionSettingsView | undefined) {
    return { image: renderPrompt(this.promptOf(settings), this.keyTarget(target), this.presentation) };
  }

  protected async press(settings: PromptSettings, target: SessionSettingsView | undefined): Promise<Outcome> {
    const prompt = this.promptOf(settings);
    if (!target) return NO_SESSION;
    if (!prompt) return { kind: "nope", detail: "no prompt set" };
    const result = await this.bridge.deckPrompt(prompt, target.id);
    return { kind: result === "started" ? "sent" : "steered", detail: target.workspace };
  }
}
