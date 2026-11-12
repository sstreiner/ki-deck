// The handbook's pictures: every key, dial and infobar in its states, and every device with its
// bundled layout, drawn by the same render functions the plugin uses. `npm run handbook`
// bundles this file and writes docs/handbook/img/*.svg (see scripts/make-handbook.mjs).

import { DEFAULT_CONFIG } from "../bridge/config";
import type { Session } from "../bridge/sessions";
import {
  renderAutonomy,
  renderDecision,
  renderEffort,
  renderEffortDial,
  renderFeedback,
  renderGate,
  renderInbox,
  renderInfobar,
  renderLockdown,
  renderModel,
  renderModelDial,
  renderPrompt,
  renderRequest,
  renderSessionDial,
  renderSessionTile,
  renderStop,
  renderToday,
  renderUsage,
  renderUsageDial,
  icon,
  tileModel,
  type FeedbackKind,
  type RequestView,
} from "../render/tiles";

const NOW = new Date(2026, 10, 10, 14, 0, 0).getTime();
const minutes = (n: number) => NOW - n * 60_000;

function session(fields: Partial<Session>): Session {
  return {
    id: "s",
    cwd: "/Users/me/shop",
    workspace: "shop",
    surface: "ide",
    origin: { bundle: "", term: "", termSession: "", tmuxPane: "", tty: "" },
    state: "idle",
    firstSeen: minutes(60),
    lastEvent: minutes(1),
    activeAt: minutes(30),
    pending: [],
    compacting: false,
    counts: { prompts: 3, tools: 40, turns: 3 },
    acknowledged: true,
    ...fields,
  };
}

const tool = (category: "shell" | "write", summary: string) => ({ key: "k", name: category === "shell" ? "execute_bash" : "fs_write", category, summary, since: minutes(0.4) });

const WORKING = session({ state: "working", turnStartedAt: minutes(2.2), pending: [tool("shell", "npm test")], contextPercent: 38 });
const NEEDS = session({ workspace: "api", state: "working", turnStartedAt: minutes(3), pending: [tool("shell", "rm -rf dist")], contextPercent: 71 });
const DONE = session({ workspace: "docs", surface: "cli", state: "done", doneAt: minutes(4), lastTurnMs: 95_000, acknowledged: false });
const DECK = session({ workspace: "billing", surface: "deck", state: "done", doneAt: minutes(1), lastTurnMs: 42_000, acknowledged: false });
const DECK_IDLE = session({ workspace: "billing", surface: "deck" });
const MAYBE = session({ workspace: "infra", surface: "cli", state: "working", turnStartedAt: minutes(1), pending: [tool("write", "main.tf")] });
const STALE = session({ workspace: "legacy", state: "stale", lastEvent: minutes(14), turnStartedAt: minutes(20) });
const UNGATED = session({ workspace: "web", ungated: { tool: "execute_bash", category: "shell", summary: "curl x | sh", at: minutes(2), count: 2 } });

const approval = { kind: "approval" as const, since: minutes(0.5), detail: "shell: rm -rf dist", category: "shell" };
const target = { category: "shell", summary: "rm -rf dist", workspace: "api", position: 1, total: 2 };
const deck = { workspace: "billing", working: false };
const deckBusy = { workspace: "billing", working: true, workingMs: 134_000 };
const request: RequestView = {
  category: "shell",
  detail: "rm -rf dist && npm run build && node scripts/deploy.mjs --env=staging",
  workspace: "api",
  waitedMs: 31_000,
  position: 1,
  total: 2,
};
const credits = { plan: "Pro Max", used: 2_970, limit: 5_000, percent: 59, resetDate: "2026-12-01", fetching: false, stale: false };
const today = { turns: 14, toolCalls: 386, turnMs: 5_700_000, allowed: 9, denied: 2 };
const opus = { name: "Claude Opus 5.5", rate: 2 };
const sonnet = { name: "Claude Sonnet 5.5", rate: 1.3 };
const haiku = { name: "Claude Haiku 5.5", rate: 0.06 };
const at = new Date(NOW);

const tile = (s: Session, attention = undefined as Parameters<typeof tileModel>[1], info?: Parameters<typeof tileModel>[4]) =>
  renderSessionTile(tileModel(s, attention, NOW, false, info), NOW);

export interface Picture {
  file: string;
  caption: string;
  svg: string;
  width: number;
  height: number;
}

const keyPicture = (file: string, caption: string, svg: string): Picture => ({ file, caption, svg, width: 144, height: 144 });
const dialPicture = (file: string, caption: string, svg: string): Picture => ({ file, caption, svg, width: 200, height: 100 });

/** Every key state the handbook shows, grouped by action. */
export function keyGallery(): Record<string, Picture[]> {
  const feedback = (kind: FeedbackKind, caption: string, detail = "") => keyPicture(`feedback-${kind}`, caption, renderFeedback(kind, detail));
  return {
    session: [
      keyPicture("session-working", "Working: the current tool, the turn's time and the context window in use", tile(WORKING)),
      keyPicture("session-needs-you", "Needs you: a call waits for Allow or Deny", tile(NEEDS, approval)),
      keyPicture("session-done", "Done: the turn finished and you have not looked yet", tile(DONE)),
      keyPicture("session-deck", "A deck session after a turn: time and credits", tile(DECK, undefined, { credits: 0.42, context: 12 })),
      keyPicture("session-deck-idle", "An idle deck session shows its model", tile(DECK_IDLE, undefined, { model: "Opus 5.5" })),
      keyPicture("session-may-need-you", "Needs you?: a write has run a while, maybe a prompt", tile(MAYBE, { kind: "may-need-you", since: minutes(0.4) })),
      keyPicture("session-ungated", "Ungated: a gated call ran without asking the deck", tile(UNGATED, { kind: "ungated", since: minutes(2), detail: "shell: curl x | sh", category: "shell" })),
      keyPicture("session-stale", "Stale: working, but no events for a while", tile(STALE)),
      keyPicture("session-idle", "Idle: seen, nothing running", tile(session({}))),
      keyPicture("session-empty", "No session for this key", renderSessionTile(undefined)),
    ],
    inbox: [
      keyPicture("inbox-approvals", "Calls waiting for the deck, approvals first", renderInbox(3, "api", false, 2)),
      keyPicture("inbox-done", "Sessions waiting for you, none to approve", renderInbox(1, "docs", false)),
      keyPicture("inbox-ungated", "Only an ungated alert", renderInbox(1, "web", false, 0, 1)),
      keyPicture("inbox-clear", "Nothing waits", renderInbox(0, undefined, false)),
    ],
    decisions: [
      keyPicture("allow", "Allow, showing the call it answers", renderDecision("allow", target, { presentation: false })),
      keyPicture("deny", "Deny", renderDecision("deny", target, { presentation: false })),
      keyPicture("reason", "Deny with a reason the agent reads", renderDecision("reason", target, { presentation: false, reason: "Find the root cause first" })),
      keyPicture("in-kiro", "Decide in Kiro: hand it to Kiro's prompt", renderDecision("ask", target, { presentation: false })),
      keyPicture("allow-idle", "Nothing waiting", renderDecision("allow", undefined, { presentation: false })),
    ],
    request: [0, 1, 2, 3].map((part) =>
      keyPicture(`request-${part + 1}`, part === 0 ? "The banner's first key" : `Part ${part + 1}`, renderRequest(request, part, 4, false)),
    ),
    safety: [
      keyPicture("lockdown-off", "Lockdown off", renderLockdown(false)),
      keyPicture("lockdown-on", "Lockdown on: shell, writes and MCP blocked everywhere", renderLockdown(true)),
      keyPicture("gate-on", "Gate on: shell calls wait for the deck", renderGate("shell", true, false)),
      keyPicture("gate-off", "Gate off: Kiro decides", renderGate("write", false, false)),
    ],
    usage: [
      keyPicture("credits", "Credits this billing cycle", renderUsage(credits, at)),
      keyPicture("credits-high", "Close to the limit", renderUsage({ ...credits, used: 4_620, percent: 92 }, at)),
      keyPicture("today", "Today's activity", renderToday(today)),
    ],
    deck: [
      keyPicture("model", "Model: the target's model; press for the next", renderModel(opus, deck, { slot: false, current: true, presentation: false })),
      keyPicture("model-slot-current", "A model key in use", renderModel(sonnet, deck, { slot: true, current: true, presentation: false })),
      keyPicture("model-slot", "A model key: press to switch to it", renderModel(haiku, deck, { slot: true, current: false, presentation: false })),
      keyPicture("model-budget", "Budget guard: credits are low, pricier models marked", renderModel(opus, deck, { slot: true, current: false, presentation: false, budget: true })),
      keyPicture("effort", "Effort: press for the next level", renderEffort("high", deck, false, ["low", "medium", "high", "xhigh", "max"])),
      keyPicture("autopilot", "Autopilot: runs tools on its own", renderAutonomy(true, deck, false)),
      keyPicture("supervised", "Supervised: asks the deck first", renderAutonomy(false, deck, false)),
      keyPicture("stop", "Stop the running turn", renderStop(deckBusy, false)),
      keyPicture("prompt", "A canned prompt", renderPrompt("Check your work and fix issues", deck, false)),
      keyPicture("steer", "The same key steers a running turn", renderPrompt("Summarize what you changed", deckBusy, false)),
      keyPicture("model-none", "No deck session yet", renderModel(undefined, undefined, { slot: false, current: false, presentation: false })),
    ],
    feedback: [
      feedback("allowed", "After Allow"),
      feedback("denied", "After Deny"),
      feedback("handed", "After Decide in Kiro"),
      feedback("seen", "Hold: marked as seen"),
      feedback("removed", "Hold again: removed"),
      feedback("locked", "Lockdown on"),
      feedback("gate-on", "Gate switched on", "Shell"),
      feedback("model", "Model switched", "Sonnet 5.5"),
      feedback("steered", "Prompt sent as steering"),
      feedback("stopped", "Turn stopped"),
      feedback("refreshed", "Credits refreshed"),
      feedback("nope", "Nothing to act on", "nothing waiting"),
    ],
  };
}

/** Touch-strip and infobar states. */
export function stripGallery(): Picture[] {
  return [
    dialPicture("dial-session", "Session dial: rotate to pick, push to focus", renderSessionDial(tileModel(WORKING, undefined, NOW, false), 1, 4, NOW)),
    dialPicture("dial-model", "Model dial: rotate to choose, push to apply", renderModelDial(sonnet, { pending: true, workspace: "billing", index: 2, count: 8 })),
    dialPicture("dial-effort", "Effort dial: rotate to change", renderEffortDial("high", ["low", "medium", "high", "xhigh", "max"], "billing")),
    dialPicture("dial-usage", "Usage dial: credits at a glance", renderUsageDial(credits, at)),
    { file: "infobar", caption: "Neo infobar: what waits on you, and credits", svg: renderInfobar({ count: 3, approvals: 2, oldest: "api" }, 59, false), width: 232, height: 50 },
    { file: "infobar-clear", caption: "Neo infobar with nothing waiting", svg: renderInfobar({ count: 0, approvals: 0 }, 59, false), width: 232, height: 50 },
  ];
}

/** A Stream Deck folder key as the device draws it: the folder name under a folder icon. */
export function folderKeyImage(title: string): string {
  return plainKey("#22272e", icon("folder", 72, 56, 44, "#ffffff", { opacity: 0.9 }) + label(title));
}

/** The Back key inside a folder. */
export function backKeyImage(): string {
  return plainKey("#22272e", icon("back", 72, 56, 40, "#ffffff", { opacity: 0.85 }) + label("Back"));
}

export function emptyKeyImage(): string {
  return plainKey("#101418", "");
}

function plainKey(color: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="${color}"/>${body}</svg>`;
}

function label(title: string): string {
  return `<text x="72" y="118" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="19" font-weight="bold" fill="#ffffff" text-anchor="middle">${title}</text>`;
}

/** The live look of one layout cell, for the device pictures. */
export function cellImage(cell: { action: string; settings: Record<string, unknown> } | null | undefined): string | undefined {
  if (!cell) return undefined;
  const s = cell.settings;
  const sessions = [tile(NEEDS, approval), tile(WORKING), tile(DONE), tile(DECK, undefined, { credits: 0.42, context: 12 }), tile(MAYBE, { kind: "may-need-you", since: minutes(0.4) }), tile(STALE), tile(session({})), renderSessionTile(undefined)];
  const models = [opus, sonnet, haiku, { name: "Auto", rate: 1 }, { name: "GPT 5.6 Terra", rate: 2.2 }, { name: "Claude Opus 5", rate: 2.2 }, { name: "MiniMax M2.5", rate: 0.25 }, { name: "Qwen3 Coder Next", rate: 0.05 }];
  const { denyReasons: reasons, cannedPrompts: prompts } = DEFAULT_CONFIG;
  switch (cell.action) {
    case "session":
      return sessions[typeof s.slot === "number" ? s.slot : 0] ?? renderSessionTile(undefined);
    case "inbox":
      return renderInbox(3, "api", false, 2);
    case "request":
      return renderRequest(request, Number(s.part ?? 0), Number(s.parts ?? 4), false);
    case "allow":
      return renderDecision("allow", target, { presentation: false });
    case "deny":
      return typeof s.reasonIndex === "number"
        ? renderDecision("reason", target, { presentation: false, reason: reasons[s.reasonIndex] ?? "" })
        : renderDecision("deny", target, { presentation: false });
    case "decide-in-kiro":
      return renderDecision("ask", target, { presentation: false });
    case "lockdown":
      return renderLockdown(false);
    case "gate":
      return renderGate(String(s.category ?? "shell"), s.category === "shell", false);
    case "usage":
      return s.view === "today" ? renderToday(today) : renderUsage(credits, at);
    case "model":
      if (typeof s.slot !== "number") return renderModel(opus, deck, { slot: false, current: true, presentation: false });
      return renderModel(models[s.slot % models.length], deck, { slot: true, current: s.slot === 0, presentation: false });
    case "effort":
      return renderEffort("high", deck, false, ["low", "medium", "high", "xhigh", "max"]);
    case "autonomy":
      return renderAutonomy(false, deck, false);
    case "stop":
      return renderStop(deckBusy, false);
    case "prompt":
      return renderPrompt(prompts[Number(s.promptIndex ?? 0)], deck, false);
    default:
      return undefined;
  }
}

/** The live look of a dial or the infobar, for the device pictures. */
export function controlImage(cell: { action: string; settings: Record<string, unknown> } | null | undefined, kind: "dial" | "infobar"): string | undefined {
  if (!cell) return undefined;
  if (kind === "infobar") return renderInfobar({ count: 3, approvals: 2, oldest: "api" }, 59, false);
  switch (cell.action) {
    case "session":
      return renderSessionDial(tileModel(WORKING, undefined, NOW, false), 1, 4, NOW);
    case "model":
      return renderModelDial(sonnet, { pending: false, workspace: "billing", index: 2, count: 8 });
    case "effort":
      return renderEffortDial("high", ["low", "medium", "high", "xhigh", "max"], "billing");
    case "usage":
      return renderUsageDial(credits, at);
    default:
      return undefined;
  }
}
