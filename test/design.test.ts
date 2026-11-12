// The M5 design: press feedback, dials, the Neo infobar, the budget guard, and the rules every
// image follows (deterministic markup, only SVG features Stream Deck renders).

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Flash, FLASH_MS } from "../src/actions/flash";
import { compareVersions, newerInstalled } from "../src/companion/update";
import { cellImage, controlImage, keyGallery, stripGallery } from "../src/docs/gallery";
import {
  formatContext,
  RASTER_SCALE,
  renderEffortDial,
  renderFeedback,
  renderInfobar,
  renderModel,
  renderModelDial,
  renderRequest,
  renderSessionDial,
  renderSessionTile,
  renderUsageDial,
  shade,
  SPINNER_FRAME_MS,
  SPINNER_FRAMES,
  spinnerPhase,
  tileModel,
} from "../src/render/tiles";
import type { Session } from "../src/bridge/sessions";

const s: Session = {
  id: "s",
  cwd: "/x/shop",
  workspace: "shop",
  surface: "ide",
  origin: { bundle: "", term: "", termSession: "", tmuxPane: "", tty: "" },
  state: "working",
  firstSeen: 0,
  lastEvent: 0,
  activeAt: 0,
  turnStartedAt: 0,
  pending: [],
  compacting: false,
  counts: { prompts: 1, tools: 0, turns: 0 },
  acknowledged: false,
};

describe("key images", () => {
  const all = [...Object.values(keyGallery()).flat(), ...stripGallery()];

  it("give the same markup for the same state, so unchanged keys are not redrawn", () => {
    const again = [...Object.values(keyGallery()).flat(), ...stripGallery()];
    expect(again.map((p) => p.svg)).toEqual(all.map((p) => p.svg));
  });

  it("use only SVG features Stream Deck renders, drawn at their surface's size and declared at twice it", () => {
    for (const p of all) {
      expect(p.svg).toMatch(new RegExp(`^<svg [^>]*width="${p.width * RASTER_SCALE}" height="${p.height * RASTER_SCALE}" viewBox="0 0 ${p.width} ${p.height}"`));
      expect(p.svg).not.toMatch(/<(pattern|filter|clipPath|mask|style|foreignObject|image)\b/);
      expect(p.svg).not.toContain("currentColor");
    }
  });

  it("keep their gradient IDs unique per color", () => {
    for (const p of all) {
      const ids = [...p.svg.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("turn the Working spinner a spoke per frame, the same on every key at the same moment", () => {
    const m = tileModel(s, undefined, 5_000, false);
    const frames = Array.from({ length: SPINNER_FRAMES }, (_, i) => renderSessionTile(m, i * SPINNER_FRAME_MS));
    expect(new Set(frames).size).toBe(SPINNER_FRAMES);
    expect(renderSessionTile(m, SPINNER_FRAMES * SPINNER_FRAME_MS)).toBe(frames[0]); // one turn, then it repeats
    expect(renderSessionTile(m, 10)).toBe(renderSessionTile(m, SPINNER_FRAME_MS - 10)); // within a frame nothing moves
    expect(spinnerPhase(3 * SPINNER_FRAME_MS + 1)).toBe(3);
    expect(renderSessionTile({ ...m, state: "idle" }, 0)).toBe(renderSessionTile({ ...m, state: "idle" }, SPINNER_FRAME_MS));
    expect(1000 / SPINNER_FRAME_MS).toBeGreaterThanOrEqual(8); // smooth enough on a key
  });

  it("show how full the context window is on session keys and dials", () => {
    const m = tileModel({ ...s, contextPercent: 38.4 }, undefined, 5_000, false);
    expect(m.context).toBe(38.4);
    expect(renderSessionTile(m, 0)).toContain(">CTX 38%<");
    expect(renderSessionDial(m, 0, 1)).toContain(">ctx 38%<");
    expect(renderSessionTile(tileModel(s, undefined, 5_000, false), 0)).not.toContain("CTX");
    expect(tileModel({ ...s, surface: "deck" }, undefined, 0, false, { context: 12 }).context).toBe(12);
    expect(formatContext(0.4)).toBe("<1%");
    expect(formatContext(0)).toBe("0%");
    expect(formatContext(99.6)).toBe("100%");
  });

  it("leave the empty end of a short request banner quiet", () => {
    const view = { category: "shell", detail: "ls", workspace: "shop", waitedMs: 0, position: 1, total: 1 };
    expect(renderRequest(view, 3, 4, false)).toContain('id="bg1c2128"');
    expect(renderRequest(view, 1, 4, false)).toContain(">ls<");
  });

  it("shade colors lighter and darker", () => {
    expect(shade("#000000", 0.5)).toBe("#808080");
    expect(shade("#ffffff", -0.5)).toBe("#808080");
    expect(shade("#d1242f", 0)).toBe("#d1242f");
  });
});

describe("press feedback", () => {
  it("says what happened, and why nothing did", () => {
    expect(renderFeedback("allowed", "npm test")).toContain(">Allowed<");
    expect(renderFeedback("allowed", "npm test")).toContain(">npm test<");
    const nope = renderFeedback("nope", "nothing waiting");
    expect(nope).toContain(">Nothing<");
    expect(nope).toContain(">waiting<");
    expect(nope).not.toContain("Nothing to do");
  });

  it("shows feedback for a moment, keeps renderers off the key, then restores it", async () => {
    vi.useFakeTimers();
    try {
      const restored: string[] = [];
      const images: string[] = [];
      const flash = new Flash((id) => restored.push(id));
      const key = { id: "k1", setImage: async (image: string) => void images.push(image) };
      await flash.show(key as never, "denied", "Do a dry run first");
      expect(flash.active("k1")).toBe(true);
      vi.advanceTimersByTime(100);
      expect(images).toHaveLength(2); // a small frame, then full size
      vi.advanceTimersByTime(FLASH_MS);
      expect(flash.active("k1")).toBe(false);
      expect(restored).toEqual(["k1"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dials and the infobar", () => {
  it("draw the touch strip at 200 x 100", () => {
    const m = tileModel(s, undefined, 65_000, false);
    expect(renderSessionDial(m, 1, 3)).toContain('viewBox="0 0 200 100"');
    expect(renderSessionDial(undefined, 0, 0)).toContain("No session");
    expect(renderModelDial({ name: "Claude Sonnet 5.5", rate: 1.3 }, { pending: true, index: 1, count: 4 })).toContain("PUSH TO APPLY");
    expect(renderModelDial(undefined, { pending: false, index: 0, count: 0 })).toContain("no deck session");
    expect(renderEffortDial("high", ["low", "medium", "high"])).toContain(">high<");
    expect(renderUsageDial({ used: 10, limit: 100, percent: 10, fetching: false, stale: false }, new Date())).toContain("10 / 100");
  });

  it("draw the Neo infobar at 232 x 50 with what waits and the credits", () => {
    const bar = renderInfobar({ count: 2, approvals: 1, oldest: "shop" }, 59, false);
    expect(bar).toContain('viewBox="0 0 232 50"');
    expect(bar).toContain("1 to approve");
    expect(bar).toContain("59%");
    expect(renderInfobar({ count: 0, approvals: 0 }, undefined, false)).toContain("all clear");
    expect(renderInfobar({ count: 1, approvals: 0, oldest: "shop" }, 59, true)).not.toContain("shop");
  });
});

describe("budget guard", () => {
  const target = { workspace: "shop", working: false };

  it("marks models above 1x once credits run low", () => {
    expect(renderModel({ name: "Claude Opus 5.5", rate: 2 }, target, { slot: true, current: false, presentation: false, budget: true })).toContain("OVER BUDGET");
    expect(renderModel({ name: "Claude Haiku 5.5", rate: 0.06 }, target, { slot: true, current: false, presentation: false, budget: true })).not.toContain("OVER BUDGET");
    expect(renderModel({ name: "Claude Opus 5.5", rate: 2 }, target, { slot: true, current: false, presentation: false, budget: false })).not.toContain("OVER BUDGET");
  });
});

describe("handbook pictures", () => {
  it("draw every action a layout can hold", () => {
    for (const action of ["session", "inbox", "request", "allow", "deny", "decide-in-kiro", "lockdown", "gate", "usage", "model", "effort", "autonomy", "stop", "prompt"]) {
      expect(cellImage({ action, settings: {} }), action).toBeDefined();
    }
    expect(controlImage({ action: "model", settings: {} }, "dial")).toContain("Sonnet 5.5");
    expect(controlImage({ action: "inbox", settings: {} }, "infobar")).toContain("to approve");
  });
});

describe("companion updates", () => {
  const ID = "sstreiner.ki-deck-companion";

  it("finds a newer installed copy, which an old window should reload for", () => {
    const folders = [`${ID}-0.1.0`, `${ID}-0.3.0`, `${ID}-0.2.0`, "other.extension-9.9.9", `${ID}-0.10.0-universal`];
    expect(newerInstalled(folders, ID, "0.2.0")).toBe("0.10.0");
    expect(newerInstalled([`${ID}-0.3.0`], ID, "0.3.0")).toBeUndefined();
    expect(newerInstalled([`${ID}-junk`], ID, "0.1.0")).toBeUndefined();
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
  });

  it("declares the same version in the extension's code and its package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../extension/package.json", import.meta.url), "utf8"));
    const source = readFileSync(new URL("../src/companion/extension.ts", import.meta.url), "utf8");
    expect(source).toContain(`export const VERSION = "${pkg.version}";`);
  });
});
