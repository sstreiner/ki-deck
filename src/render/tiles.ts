// Key images as SVG (drawn on 144 x 144, Stream Deck's @2x key size), touch-strip images for
// Stream Deck + dials (200 x 100) and the Neo infobar (232 x 50). Every image declares twice its
// drawing size, so Stream Deck rasterizes it sharp for large keys too (Stream Deck Mobile on a
// phone shows keys bigger than 144 px) and scales it down for small ones.
//
// Design rules:
// - State is always color, an icon and a word, never color alone.
// - Every key has the same three zones: a label at the top, the main thing in the middle,
//   where a press goes (or the detail) at the bottom.
// - Only SVG features every renderer handles: paths, circles, rects, text, linear gradients,
//   opacity and transforms (no patterns, filters, clip paths, CSS or currentColor).

import { formatDuration } from "../bridge/notify";
import type { Attention, Session } from "../bridge/sessions";

export type DisplayState = "needs-you" | "ungated" | "working" | "may-need-you" | "done" | "idle" | "stale";

export interface TileModel {
  title: string;
  badge: string;
  state: DisplayState;
  detail: string;
  timer: string;
  /** How full the context window is, in percent, when Kiro reports it. */
  context?: number;
}

// ---- Palette and primitives ----------------------------------------------------------------

export const COLORS = {
  red: "#d1242f",
  purple: "#8250df",
  blue: "#1f6feb",
  amber: "#d29922",
  green: "#1a7f37",
  teal: "#0f8577",
  slate: "#2d333b",
  dim: "#1c2128",
  night: "#0d1117",
  white: "#ffffff",
  ink: "#1b1f24",
} as const;

/** Declared size over drawing size: 144 x 144 keys say 288 x 288 (see the top of this file). */
export const RASTER_SCALE = 2;

/** Frames of the Working spinner, and how long each shows: session keys redraw this often while one works. */
export const SPINNER_FRAMES = 8;
export const SPINNER_FRAME_MS = 125;

/** The spinner frame for a moment in time, so every key and dial turns in step. */
export function spinnerPhase(now: number): number {
  return Math.floor(now / SPINNER_FRAME_MS) % SPINNER_FRAMES;
}

const FONT = "Helvetica Neue, Helvetica, Arial, sans-serif";
const MONO = "Menlo, Monaco, monospace";

interface Look {
  bg: string;
  fg: string;
  icon: IconName;
  word: string;
}

const LOOK: Record<DisplayState, Look> = {
  "needs-you": { bg: COLORS.red, fg: COLORS.white, icon: "hand", word: "Needs you" },
  ungated: { bg: COLORS.purple, fg: COLORS.white, icon: "alert", word: "Ungated" },
  working: { bg: COLORS.blue, fg: COLORS.white, icon: "spinner", word: "Working" },
  "may-need-you": { bg: COLORS.amber, fg: COLORS.ink, icon: "hourglass", word: "Needs you?" },
  done: { bg: COLORS.green, fg: COLORS.white, icon: "check", word: "Done" },
  idle: { bg: COLORS.slate, fg: "#e6edf3", icon: "moon", word: "Idle" },
  stale: { bg: COLORS.slate, fg: "#e6edf3", icon: "hourglass", word: "Stale" },
};

/** Lighter or darker shade of a #rrggbb color (`amount` -1 .. 1). */
export function shade(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => {
    const c = (n >> shift) & 0xff;
    const v = amount >= 0 ? c + (255 - c) * amount : c * (1 + amount);
    return Math.round(Math.max(0, Math.min(255, v)))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

/**
 * A canvas with a soft top-to-bottom gradient of `color`. The gradient's ID comes from the
 * color, so the same state always gives the same markup (keys are only redrawn when it
 * changes) and keys placed side by side in one document cannot clash.
 */
function canvas(width: number, height: number, color: string, body: string): string {
  const id = `bg${color.slice(1)}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * RASTER_SCALE}" height="${height * RASTER_SCALE}" viewBox="0 0 ${width} ${height}">` +
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${shade(color, 0.14)}"/><stop offset="1" stop-color="${shade(color, -0.22)}"/>` +
    `</linearGradient></defs><rect width="${width}" height="${height}" fill="url(#${id})"/>${body}</svg>`
  );
}

const key = (color: string, body: string) => canvas(144, 144, color, body);

function text(
  x: number,
  y: number,
  value: string,
  size: number,
  fill: string,
  anchor: "start" | "middle" | "end" = "middle",
  weight: "normal" | "bold" = "normal",
  opacity = 1,
): string {
  if (!value) return "";
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" fill-opacity="${opacity}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
}

/** Monospaced text, kept as typed (xml:space preserve keeps runs of spaces). */
function mono(x: number, y: number, value: string, size: number, fill: string): string {
  if (!value) return "";
  return `<text x="${x}" y="${y}" font-family="${MONO}" font-size="${size}" fill="${fill}" xml:space="preserve">${escapeXml(value)}</text>`;
}

/** The small label at the top of a key. */
function label(value: string, fg: string, x = 72, anchor: "start" | "middle" = "middle"): string {
  return text(x, 25, value.toUpperCase(), 13, fg, anchor, "bold", 0.78);
}

/** Rough width of `value` in Helvetica at `size` px, for centering an icon next to a word. */
function textWidth(value: string, size: number, bold = true): number {
  return [...value].length * size * (bold ? 0.58 : 0.54);
}

/** A rounded pill with a word, e.g. the IDE / CLI / DECK badge. Right-aligned at `right`. */
function pill(right: number, y: number, value: string, bg: string, fg: string): string {
  const w = Math.round([...value].length * 11 * 0.68 + 12); // bold capitals run wider than text

  return (
    `<rect x="${right - w}" y="${y}" width="${w}" height="17" rx="8.5" fill="${bg}" fill-opacity="0.9"/>` +
    text(right - w / 2, y + 12.5, value, 11, fg, "middle", "bold")
  );
}

/** Diagonal stripes over the whole canvas (stale sessions, lockdown). */
function stripes(width: number, height: number, color = "#000000", opacity = 0.16): string {
  let d = "";
  for (let x = -height; x < width; x += 18) d += `M${x} ${height}L${x + height} 0`;
  return `<path d="${d}" stroke="${color}" stroke-width="7" stroke-opacity="${opacity}"/>`;
}

// ---- Icons ---------------------------------------------------------------------------------
// Drawn on a 24 x 24 grid with 2 px round strokes, scaled to the size asked for.

const ICONS = {
  check: "M5 12.5l4.5 4.5L19 7",
  x: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  alert: "M12 3.8L21.5 20H2.5Z M12 10v4.2 M12 17.2v.3",
  hand: "M8 12.5V6.8a1.4 1.4 0 0 1 2.8 0V11 M10.8 11V5.2a1.4 1.4 0 0 1 2.8 0V11 M13.6 11V6.2a1.4 1.4 0 0 1 2.8 0V12 M16.4 12V9a1.4 1.4 0 0 1 2.8 0v4.5c0 4-2.6 7-6.6 7-2.6 0-4.2-1.2-5.6-3.2l-2.6-3.7a1.4 1.4 0 0 1 2.3-1.6L8 13.5",
  hourglass: "M7 3h10M7 21h10M8 3c0 4.5 8 5 8 9s-8 4.5-8 9M16 3c0 4.5-8 5-8 9s8 4.5 8 9",
  moon: "M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z",
  bolt: "M13.5 2.5L4.5 14h7l-1 7.5 9-11.5h-7Z",
  inbox: "M3 13.5l3-8h12l3 8V20H3Z M3 13.5h5l1.5 2.5h5l1.5-2.5h5",
  lock: "M6 11h12v10H6Z M8.5 11V7.8a3.5 3.5 0 0 1 7 0V11",
  unlock: "M6 11h12v10H6Z M8.5 11V7.8a3.5 3.5 0 0 1 6.8-1.2",
  shield: "M12 2.8l7.5 2.8v5.8c0 4.8-3.2 8.3-7.5 9.8-4.3-1.5-7.5-5-7.5-9.8V5.6Z",
  shieldCheck: "M12 2.8l7.5 2.8v5.8c0 4.8-3.2 8.3-7.5 9.8-4.3-1.5-7.5-5-7.5-9.8V5.6Z M8.6 12.2l2.4 2.4 4.4-4.6",
  chip: "M7 7h10v10H7Z M10 3.5V7M14 3.5V7M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5",
  bars: "M5 20v-3M9.5 20v-6M14 20v-9M18.5 20V5",
  plane: "M21.5 2.5L10.5 13.5 M21.5 2.5l-7 19-4-8-8-4Z",
  eye: "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6Z",
  stop: "M6.5 6.5h11v11h-11Z",
  chat: "M4 4.5h16v11.5H10l-6 4.5Z",
  steer: "M4 4.5h16v11.5H10l-6 4.5Z M8.5 10.2h7 M12.5 7.2l3 3-3 3",
  arrow: "M4 12h15 M13 6l6 6-6 6",
  refresh: "M20 12a8 8 0 1 1-2.4-5.7 M20 4v5h-5",
  sparkle: "M12 2.5l2.1 7.4L21.5 12l-7.4 2.1L12 21.5l-2.1-7.4L2.5 12l7.4-2.1Z",
  folder: "M3 6.5h6.5l2 2.5H21v10.5H3Z",
  clock: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z M12 7.5V12l3 2",
  gauge: "M4 16.5a8 8 0 1 1 16 0 M12 16.5l4-5",
  review: "M6 2.5h8l4.5 4.5V21.5H6Z M14 2.5V7h4.5 M9 14l2.2 2.2 4-4.2",
  sessions: "M3.5 5h17v14h-17Z M3.5 9.5h17 M7 7.2h.01",
  terminal: "M3.5 5h17v14h-17Z M7 10l3 2.5-3 2.5 M12.5 15.5h4.5",
  back: "M10 6l-6 6 6 6 M4 12h16",
  spinner: "",
} as const;

export type IconName = keyof typeof ICONS;

/** A stroked icon centered on (cx, cy), `size` px wide. `filled` also fills it. */
export function icon(name: IconName, cx: number, cy: number, size: number, color: string, options: { filled?: boolean; phase?: number; opacity?: number } = {}): string {
  const s = size / 24;
  const x = cx - size / 2;
  const y = cy - size / 2;
  const opacity = options.opacity ?? 1;
  if (name === "spinner") {
    // Spokes that fade behind the brightest one; `phase` (0..7) moves it a spoke on. An activity
    // indicator steps by design, so eight frames a second look smooth, where a turning arc
    // would need far more redraws to stop looking jerky.
    const head = (options.phase ?? 0) % SPINNER_FRAMES;
    const inner = size * 0.2;
    const outer = size * 0.47;
    let spokes = "";
    for (let i = 0; i < SPINNER_FRAMES; i++) {
      const behind = (head - i + SPINNER_FRAMES) % SPINNER_FRAMES; // 0: the leading spoke
      const rad = (i * 2 * Math.PI) / SPINNER_FRAMES - Math.PI / 2;
      const [dx, dy] = [Math.cos(rad), Math.sin(rad)];
      spokes +=
        `<path d="M${(cx + inner * dx).toFixed(2)} ${(cy + inner * dy).toFixed(2)}L${(cx + outer * dx).toFixed(2)} ${(cy + outer * dy).toFixed(2)}" ` +
        `stroke="${color}" stroke-width="${(size * 0.13).toFixed(2)}" stroke-linecap="round" stroke-opacity="${(opacity * (1 - behind * 0.11)).toFixed(2)}"/>`;
    }
    return spokes;
  }
  const fill = options.filled ? color : "none";
  return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${s.toFixed(3)})"><path d="${ICONS[name]}" fill="${fill}" fill-opacity="${opacity}" stroke="${color}" stroke-opacity="${opacity}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>`;
}

/** SVG arc path on a circle, angles in degrees clockwise from 12 o'clock. */
function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  const point = (deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return `${(cx + r * Math.cos(rad)).toFixed(2)} ${(cy + r * Math.sin(rad)).toFixed(2)}`;
  };
  const sweep = Math.max(0.01, Math.min(359.99, to - from));
  return `M${point(from)}A${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${point(from + sweep)}`;
}

/** A progress ring: track plus a filled share (0..1). */
function ring(cx: number, cy: number, r: number, width: number, share: number, color: string, track = "#ffffff", trackOpacity = 0.14): string {
  const clamped = Math.max(0, Math.min(1, share));
  return (
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${track}" stroke-opacity="${trackOpacity}" stroke-width="${width}"/>` +
    (clamped > 0 ? `<path d="${arc(cx, cy, r, 0, clamped * 360)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>` : "")
  );
}

/** An icon and a word as one centered group. */
function iconWord(name: IconName, word: string, cy: number, size: number, iconSize: number, color: string, options: { phase?: number; filled?: boolean } = {}): string {
  const gap = 7;
  const width = iconSize + gap + textWidth(word, size);
  const left = 72 - width / 2;
  return icon(name, left + iconSize / 2, cy, iconSize, color, options) + text(left + iconSize + gap, cy + size * 0.36, word, size, color, "start", "bold");
}

// ---- Session tile --------------------------------------------------------------------------

/** Deck sessions only: the model (shown while idle), the credits of the last turn, and context use. */
export interface DeckTileInfo {
  model?: string;
  credits?: number;
  context?: number;
}

const BADGE: Record<Session["surface"], string> = { ide: "IDE", cli: "CLI", deck: "DECK" };

export function tileModel(
  s: Session,
  attention: Attention | undefined,
  now: number,
  presentation: boolean,
  deck?: DeckTileInfo,
): TileModel {
  const fromAttention: Partial<Record<Attention["kind"], DisplayState>> = {
    approval: "needs-you",
    ungated: "ungated",
    "may-need-you": "may-need-you",
  };
  const state: DisplayState =
    (attention && fromAttention[attention.kind]) ?? (s.state === "done" && s.acknowledged ? "idle" : s.state);
  const tool = s.pending[s.pending.length - 1];
  const toolText = tool ? (presentation ? tool.category : `${tool.category}: ${tool.summary}`) : "";

  let detail = "";
  let timer = "";
  switch (state) {
    case "needs-you":
      detail = presentation ? (attention?.category ?? "") : (attention?.detail ?? "");
      timer = attention ? `waiting ${formatDuration(now - attention.since)}` : "";
      break;
    case "ungated": {
      const count = s.ungated && s.ungated.count > 1 ? `${s.ungated.count}× ` : "";
      detail = presentation ? (attention?.category ?? "") : (attention?.detail ?? "");
      timer = attention ? `${count}${formatDuration(now - attention.since)} ago` : "";
      break;
    }
    case "working":
      detail = s.compacting ? "compacting" : toolText || "thinking";
      timer = s.turnStartedAt !== undefined ? formatDuration(now - s.turnStartedAt) : "";
      break;
    case "may-need-you":
      detail = toolText;
      timer = attention ? `waiting ${formatDuration(now - attention.since)}` : "";
      break;
    case "done":
      detail = s.lastTurnMs !== undefined ? `took ${formatDuration(s.lastTurnMs)}` : "";
      if (deck?.credits !== undefined) detail = `${s.lastTurnMs !== undefined ? `${formatDuration(s.lastTurnMs)} · ` : ""}${formatCredits(deck.credits)}`;
      timer = s.doneAt !== undefined ? `idle ${formatDuration(now - s.doneAt)}` : "";
      break;
    case "stale":
      detail = "no events";
      timer = formatDuration(now - s.lastEvent);
      break;
    case "idle":
      detail = s.counts.turns === 1 ? "1 turn" : `${s.counts.turns} turns`;
      if (deck?.model) [detail, timer] = [deck.model, detail];
      break;
  }
  const context = s.contextPercent ?? deck?.context;
  return {
    title: presentation ? "Session" : s.workspace || "session",
    badge: BADGE[s.surface],
    state,
    detail,
    timer,
    ...(context !== undefined ? { context } : {}),
  };
}

/** "62%"; below 1 % (a fresh chat) "<1%", so the gauge never reads as empty. */
export function formatContext(percent: number): string {
  return percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}

/**
 * The context gauge in a session key's top-left corner: a small ring that fills with the share
 * of the model's context window in use, and the number. Kiro summarizes ("compacts") a chat
 * when it runs full, so a nearly full ring says a compaction is coming.
 */
function contextGauge(percent: number, fg: string): string {
  return ring(19, 17, 7, 3.2, percent / 100, fg, fg, 0.28) + text(31, 22, `CTX ${formatContext(percent)}`, 12, fg, "start", "bold", 0.85);
}

/**
 * One session: workspace and surface badge, state as icon and word, then what it does and for
 * how long. `now` turns the Working spinner, so each redraw animates it a step.
 */
export function renderSessionTile(m: TileModel | undefined, now = 0): string {
  if (!m) {
    return key(
      COLORS.night,
      icon("sessions", 72, 62, 34, "#8b949e", { opacity: 0.55 }) + text(72, 106, "No session", 16, "#8b949e", "middle", "normal", 0.8),
    );
  }
  const look = LOOK[m.state];
  const badgeBg = m.badge === "DECK" ? COLORS.teal : shade(look.bg, -0.45);
  const phase = spinnerPhase(now);
  return key(
    look.bg,
    (m.state === "stale" ? stripes(144, 144) : "") +
      (m.context !== undefined ? contextGauge(m.context, look.fg) : "") +
      pill(136, 8, m.badge, badgeBg, COLORS.white) +
      text(10, 46, truncate(m.title, 10), 21, look.fg, "start", "bold") +
      iconWord(look.icon, look.word, 76, look.word.length > 7 ? 18 : 21, 24, look.fg, { phase }) +
      text(72, 110, truncate(m.detail, 14), 16, look.fg, "middle", "normal", 0.95) +
      text(72, 132, truncate(m.timer, 14), 15, look.fg, "middle", "normal", 0.78),
  );
}

// ---- Inbox ---------------------------------------------------------------------------------

/** How many sessions wait on you. Red while something does, purple for an ungated alert alone. */
export function renderInbox(count: number, oldest: string | undefined, presentation: boolean, approvals = 0, ungated = 0): string {
  const fg = COLORS.white;
  if (count === 0) {
    return key(COLORS.slate, label("Inbox", fg) + icon("check", 72, 70, 44, fg) + text(72, 120, "all clear", 16, fg, "middle", "normal", 0.85));
  }
  const color = approvals > 0 || ungated < count ? COLORS.red : COLORS.purple;
  const what = approvals > 0 ? `${approvals} to approve` : ungated > 0 ? "ungated" : "need you";
  return key(
    color,
    label("Inbox", fg) +
      `<circle cx="72" cy="64" r="29" fill="#ffffff" fill-opacity="0.16"/>` +
      text(72, 81, String(count), count > 9 ? 38 : 46, fg, "middle", "bold") +
      (ungated > 0 && approvals === 0 ? iconWord("alert", what, 112, 16, 16, fg) : text(72, 116, what, 16, fg, "middle", "bold")) +
      (oldest && !presentation ? text(72, 136, truncate(oldest, 15), 14, fg, "middle", "normal", 0.8) : ""),
  );
}

/**
 * The Inbox key of a packaged plugin whose Kiro side is not installed yet: a press opens the
 * setup dialog on the Mac. `running` while the installer works.
 */
export function renderSetup(running: boolean): string {
  const fg = COLORS.white;
  if (running) {
    return key(COLORS.blue, label("ki-deck", fg) + icon("spinner", 72, 64, 38, fg) + text(72, 112, "Setting up…", 17, fg, "middle", "bold"));
  }
  return key(
    COLORS.teal,
    label("ki-deck", fg) + icon("sparkle", 72, 58, 34, fg) + text(72, 100, "Set up", 21, fg, "middle", "bold") + text(72, 122, "press to start", 13, fg, "middle", "normal", 0.85),
  );
}

// ---- Allow, Deny, deny with a reason, Decide in Kiro ---------------------------------------

export type DecisionKind = "allow" | "deny" | "reason" | "ask";

export interface DecisionTarget {
  category: string;
  summary: string;
  workspace: string;
  position: number; // 1-based among waiting approvals
  total: number;
}

const DECISION_LOOK: Record<DecisionKind, { bg: string; word: string; icon: IconName }> = {
  allow: { bg: COLORS.green, word: "Allow", icon: "check" },
  deny: { bg: COLORS.red, word: "Deny", icon: "x" },
  reason: { bg: "#a40e26", word: "Deny", icon: "chat" },
  ask: { bg: COLORS.blue, word: "In Kiro", icon: "arrow" },
};

/**
 * Allow, Deny, deny-with-reason and Decide-in-Kiro keys. With a target they show what a press
 * acts on; without one they are dimmed. `reason` is the preset text of a deny-with-reason key.
 */
export function renderDecision(kind: DecisionKind, target: DecisionTarget | undefined, options: { reason?: string; presentation: boolean }): string {
  const look = DECISION_LOOK[kind];
  const fg = COLORS.white;
  const active = target !== undefined;
  const dim = active ? 1 : 0.45;

  if (kind === "reason") {
    const lines = wrap(options.reason ?? "(no reason set)", 12, 3);
    return key(
      active ? look.bg : COLORS.dim,
      iconWord("x", "Deny", 26, 15, 14, fg) +
        lines.map((line, i) => text(72, 62 + i * 21, line, 17, fg, "middle", "normal", dim)).join("") +
        (active ? text(72, 134, footer(target, options.presentation), 13, fg, "middle", "normal", 0.85) : ""),
    );
  }
  if (!active) {
    return key(COLORS.dim, icon(look.icon, 72, 54, 40, fg, { opacity: 0.4 }) + text(72, 96, look.word, 20, fg, "middle", "bold", 0.45) + text(72, 120, "nothing waiting", 14, fg, "middle", "normal", 0.4));
  }
  const what = options.presentation ? target.category : target.summary;
  return key(
    look.bg,
    iconWord(look.icon, look.word, 30, 20, 22, fg) +
      text(72, 70, truncate(`${target.category}${options.presentation ? "" : ":"}`, 14), 16, fg, "middle", "bold", 0.85) +
      (options.presentation ? "" : wrap(what, 13, 2).map((l, i) => text(72, 92 + i * 19, l, 16, fg, "middle")).join("")) +
      text(72, 136, footer(target, options.presentation), 13, fg, "middle", "normal", 0.85),
  );
}

function footer(target: DecisionTarget, presentation: boolean): string {
  const where = presentation ? "" : truncate(target.workspace, 10);
  const count = target.total > 1 ? `${target.position}/${target.total}` : "";
  return [where, count].filter(Boolean).join(" · ");
}

// ---- Lockdown and gates --------------------------------------------------------------------

export function renderLockdown(on: boolean): string {
  const fg = COLORS.white;
  return on
    ? key(
        COLORS.red,
        stripes(144, 144, "#000000", 0.2) +
          icon("lock", 72, 50, 40, fg) +
          text(72, 98, "LOCKED", 24, fg, "middle", "bold") +
          text(72, 120, "shell · write · mcp", 13, fg, "middle", "normal", 0.9) +
          text(72, 137, "press to unlock", 12, fg, "middle", "normal", 0.8),
      )
    : key(
        COLORS.slate,
        icon("unlock", 72, 50, 40, fg, { opacity: 0.9 }) +
          text(72, 98, "Lockdown", 21, fg, "middle", "bold") +
          text(72, 122, "press to lock", 14, fg, "middle", "normal", 0.75),
      );
}

const GATE_LABEL: Record<string, string> = { shell: "Shell", write: "Write", mcp: "MCP" };

/** A gate switch: on means calls in this category wait for the deck. */
export function renderGate(category: string, on: boolean, lockdown: boolean): string {
  const fg = COLORS.white;
  const hint = lockdown ? "lockdown on" : on ? "deck approves" : "Kiro decides";
  return key(
    on ? "#0969da" : COLORS.slate,
    label("Gate", fg) +
      icon(on ? "shieldCheck" : "shield", 72, 58, 36, fg, { opacity: on ? 1 : 0.75 }) +
      text(72, 100, GATE_LABEL[category] ?? category, 21, fg, "middle", "bold") +
      `<rect x="${on ? 56 : 54}" y="108" width="${on ? 32 : 36}" height="15" rx="7.5" fill="${on ? "#ffffff" : "#000000"}" fill-opacity="${on ? 0.95 : 0.3}"/>` +
      text(72, 119.5, on ? "ON" : "off", 11, on ? "#0969da" : fg, "middle", "bold") +
      text(72, 138, hint, 12, fg, "middle", "normal", 0.8),
  );
}

// ---- Request banner ------------------------------------------------------------------------

export interface RequestView {
  category: string;
  detail: string; // the whole request, redacted
  workspace: string;
  waitedMs: number;
  position: number; // 1-based among waiting approvals
  total: number;
}

const BANNER = { width: 13, rows: 6 }; // Menlo 16 on a 144 px key
const SINGLE = { width: 14, rows: 4 }; // Menlo 15, below a header

const CATEGORY_ICON: Record<string, IconName> = { shell: "terminal", write: "folder", mcp: "chip", review: "review" };

/**
 * One key of the request banner: the oldest waiting call spread over `parts` keys in a row.
 * The first key is the header (category, workspace, waiting time); the others show the whole
 * request in columns, read key by key. A single key shows both, shortened.
 */
export function renderRequest(view: RequestView | undefined, part: number, parts: number, presentation: boolean): string {
  const fg = COLORS.white;
  if (!view) {
    return key(COLORS.dim, part === 0 ? icon("inbox", 72, 58, 34, fg, { opacity: 0.35 }) + text(72, 100, "No request", 16, fg, "middle", "normal", 0.5) : "");
  }
  const category = view.category.toUpperCase();
  const waited = `waiting ${formatDuration(view.waitedMs)}`;
  const count = view.total > 1 ? `${view.position}/${view.total}` : "";
  const body = presentation ? view.category : view.detail;
  const glyph = CATEGORY_ICON[view.category] ?? "hand";

  if (parts <= 1) {
    const lines = flow(body, SINGLE.width, SINGLE.rows, 1)[0] ?? [];
    return key(
      COLORS.red,
      icon(glyph, 20, 20, 18, fg) +
        text(34, 26, category, 16, fg, "start", "bold") +
        text(136, 26, count, 13, fg, "end", "normal", 0.85) +
        lines.map((l, i) => mono(10, 54 + i * 20, l, 15, fg)).join("") +
        text(72, 137, waited, 13, fg, "middle", "normal", 0.85),
    );
  }
  if (part === 0) {
    return key(
      COLORS.red,
      icon(glyph, 72, 32, 28, fg) +
        text(72, 72, category, 22, fg, "middle", "bold") +
        text(72, 96, presentation ? "" : truncate(view.workspace, 12), 16, fg, "middle") +
        text(72, 118, waited, 14, fg, "middle", "normal", 0.9) +
        text(72, 137, count, 13, fg, "middle", "normal", 0.8),
    );
  }
  const column = flow(body, BANNER.width, BANNER.rows, parts - 1)[part - 1] ?? [];
  // A short request leaves the last keys of the banner empty; they go quiet instead of red.
  if (column.length === 0) return key(COLORS.dim, "");
  return key(shade(COLORS.red, -0.12), column.map((l, i) => mono(8, 26 + i * 21, l, 16, fg)).join(""));
}

/**
 * Wraps text into `columns` columns of `rows` lines of at most `width` characters. Long words
 * (paths, URLs) are split rather than cut off. What does not fit ends in "…".
 */
export function flow(value: string, width: number, rows: number, columns: number): string[][] {
  const lines: string[] = [];
  let line: string[] = [];
  const flush = () => {
    if (line.length) lines.push(line.join(""));
    line = [];
  };
  for (const word of value.split(/\s+/).filter(Boolean)) {
    let chars = [...word];
    if (line.length && line.length + 1 + chars.length <= width) {
      line.push(" ", ...chars);
      continue;
    }
    if (chars.length <= width) {
      flush();
      line = chars;
      continue;
    }
    if (line.length && line.length + 2 <= width) line.push(" ");
    else flush();
    while (chars.length) {
      const room = width - line.length;
      line.push(...chars.slice(0, room));
      chars = chars.slice(room);
      if (line.length >= width) flush();
    }
  }
  flush();
  const max = rows * columns;
  if (lines.length > max) {
    const last = [...lines[max - 1]!];
    lines.length = max;
    lines[max - 1] = `${(last.length >= width ? last.slice(0, width - 1) : last).join("")}…`;
  }
  return Array.from({ length: columns }, (_, c) => lines.slice(c * rows, (c + 1) * rows));
}

// ---- Usage: credits and today --------------------------------------------------------------

export interface UsageView {
  plan?: string;
  used?: number;
  limit?: number;
  percent?: number;
  resetDate?: string; // YYYY-MM-DD
  overageCharges?: number;
  currency?: string;
  error?: string;
  fetching: boolean;
  stale: boolean; // the numbers are older than two refresh intervals
}

/** Green below 70 %, amber below 90 %, red from 90 %. */
export function usageColor(percent: number): string {
  return percent >= 90 ? COLORS.red : percent >= 70 ? COLORS.amber : COLORS.green;
}

/** Credits used this billing cycle as a ring, with used of limit and the reset date. */
export function renderUsage(v: UsageView, now: Date): string {
  const fg = COLORS.white;
  if (v.percent === undefined || v.used === undefined) {
    const status = v.fetching ? "loading…" : v.error ? "unavailable" : "no data";
    return key(
      COLORS.slate,
      label("Credits", fg) +
        // A fetch takes well under a second and this key redraws rarely: a still spinner says "loading".
        (v.fetching ? icon("spinner", 72, 66, 40, fg) : icon("gauge", 72, 66, 40, fg, { opacity: 0.6 })) +
        text(72, 112, status, 16, fg, "middle", "bold", 0.9) +
        (v.error && !v.fetching ? text(72, 133, "press to retry", 13, fg, "middle", "normal", 0.75) : ""),
    );
  }
  const pct = Math.round(v.percent);
  const over = v.overageCharges && v.overageCharges > 0 ? `+${formatMoney(v.overageCharges, v.currency)}` : "";
  const reset = v.resetDate ? `resets ${formatResetDate(v.resetDate, now)}` : "";
  return key(
    COLORS.night,
    text(12, 23, "CREDITS", 12, fg, "start", "bold", 0.75) +
      text(132, 23, v.stale ? "old" : (v.plan ?? ""), 12, fg, "end", "normal", 0.65) +
      ring(72, 66, 31, 9, v.percent / 100, usageColor(v.percent)) +
      text(72, 74, `${pct}%`, pct >= 100 ? 21 : 24, fg, "middle", "bold") +
      text(72, 117, v.limit ? `${formatCount(v.used)} / ${formatCount(v.limit)}` : formatCount(v.used), 15, fg, "middle") +
      text(72, 136, over || reset, 13, over ? "#ffa198" : fg, "middle", "normal", 0.8),
  );
}

export interface TodayView {
  turns: number;
  toolCalls: number;
  turnMs: number;
  allowed: number;
  denied: number;
}

/** Today's local activity from the event ledger. */
export function renderToday(t: TodayView): string {
  const fg = COLORS.white;
  const row = (y: number, name: IconName, value: string) => icon(name, 24, y - 5, 16, fg, { opacity: 0.8 }) + text(38, y, value, 16, fg, "start");
  const decided = t.allowed + t.denied;
  return key(
    COLORS.night,
    // Laid out like the Credits key; a press opens the activity report.
    text(12, 23, "TODAY", 12, fg, "start", "bold", 0.75) +
      text(132, 23, "report ›", 12, fg, "end", "normal", 0.65) +
      row(52, "chat", `${t.turns} ${t.turns === 1 ? "turn" : "turns"}`) +
      row(76, "bolt", `${formatCount(t.toolCalls)} tools`) +
      row(100, "clock", `${formatDuration(t.turnMs)} working`) +
      (decided
        ? icon("check", 30, 125, 15, "#56d364") + text(42, 130, String(t.allowed), 15, fg, "start", "bold") +
          icon("x", 86, 125, 15, "#ff7b72") + text(98, 130, String(t.denied), 15, fg, "start", "bold")
        : ""),
  );
}

// ---- Session setting keys and deck-only execution keys ---------------------------------------

/** The selected session as setting/deck keys show it. Undefined: no eligible session. */
export interface DeckKeyTarget {
  workspace: string;
  working: boolean;
  workingMs?: number;
  /** False when Kiro's session.json could not be read. */
  metadataAvailable?: boolean;
  /** False when the selected session can only be observed. */
  enabled?: boolean;
}

/** The bottom line of a deck key: where a press goes. */
function targetLine(t: DeckKeyTarget, presentation: boolean, fg: string): string {
  return text(72, 136, presentation ? "deck session" : truncate(t.workspace, 14), 13, fg, "middle", "normal", 0.8);
}

function noDeckSession(title: string, glyph: IconName): string {
  const fg = COLORS.white;
  return key(
    COLORS.dim,
    label(title, fg) + icon(glyph, 72, 64, 34, fg, { opacity: 0.3 }) + text(72, 108, "no deck", 15, fg, "middle", "normal", 0.45) + text(72, 126, "session", 15, fg, "middle", "normal", 0.45),
  );
}

/**
 * A model key. `slot` keys show one model and apply it; the plain key shows the target's model
 * and steps to the next one. `current`: the model is the target's. `budget`: credits are low,
 * so models above 1x are marked.
 */
export function renderModel(
  model: { name: string; rate?: number } | undefined,
  target: DeckKeyTarget | undefined,
  options: { slot: boolean; current: boolean; presentation: boolean; budget?: boolean },
): string {
  const fg = COLORS.white;
  if (!model) {
    if (!target) return options.slot ? key(COLORS.dim, icon("chip", 72, 66, 30, fg, { opacity: 0.25 }) + text(72, 112, "no model", 14, fg, "middle", "normal", 0.4)) : noDeckSession("Model", "chip");
    return key(COLORS.dim, label("Model", fg) + icon("chip", 72, 68, 34, fg, { opacity: 0.25 }) + targetLine(target, options.presentation, fg));
  }
  const available = target !== undefined && target.metadataAvailable !== false;
  const enabled = available && target?.enabled !== false;
  const pricey = options.budget === true && (model.rate ?? 1) > 1;
  const bg = !enabled ? COLORS.dim : options.slot && options.current ? "#0969da" : options.slot ? COLORS.slate : "#253041";
  const lines = wrap(model.name.replace(/^Claude\s+/i, ""), 10, 2);
  const rate = model.rate !== undefined ? `${Number(model.rate.toFixed(2))}x credits` : "";
  return key(
    bg,
    icon("chip", 21, 21, 18, fg, { opacity: enabled ? 0.85 : 0.4 }) +
      (pricey
        ? pill(136, 12, "OVER BUDGET", COLORS.amber, COLORS.ink)
        : text(36, 26, options.slot ? (options.current ? "IN USE" : "MODEL") : "MODEL", 12, fg, "start", "bold", enabled ? 0.78 : 0.45)) +
      lines.map((line, index) => text(72, (lines.length === 1 ? 74 : 62) + index * 25, line, 23, fg, "middle", "bold", available ? (enabled ? 1 : 0.62) : 0.35)).join("") +
      text(72, 114, rate, 14, pricey ? "#f2cc60" : fg, "middle", "normal", enabled ? 0.9 : 0.4) +
      (target ? targetLine(target, options.presentation, fg) : ""),
  );
}

/** Effort of the target's model as filled bars; a press steps through the levels Kiro offers. */
export function renderEffort(effort: string | undefined, target: DeckKeyTarget | undefined, presentation: boolean, levels: string[] = []): string {
  const fg = COLORS.white;
  if (!target) return noDeckSession("Effort", "bars");
  if (target.metadataAvailable === false) {
    return key(COLORS.dim, label("Effort", fg) + icon("bars", 72, 68, 34, fg, { opacity: 0.25 }) + targetLine(target, presentation, fg));
  }
  if (!effort) {
    return key(COLORS.slate, label("Effort", fg) + icon("bars", 72, 62, 34, fg, { opacity: 0.35 }) + text(72, 104, "n/a", 20, fg, "middle", "bold", 0.6) + text(72, 121, "this model", 13, fg, "middle", "normal", 0.7) + targetLine(target, presentation, fg));
  }
  const all = levels.length ? levels : [effort];
  const index = Math.max(0, all.indexOf(effort));
  const count = all.length;
  const barWidth = Math.min(16, Math.floor(96 / count) - 4);
  const left = 72 - (count * (barWidth + 4) - 4) / 2;
  const enabled = target.enabled !== false;
  const bars = all
    .map((_, barIndex) => {
      const height = 10 + (barIndex + 1) * (34 / count);
      return `<rect x="${(left + barIndex * (barWidth + 4)).toFixed(1)}" y="${(80 - height).toFixed(1)}" width="${barWidth}" height="${height.toFixed(1)}" rx="3" fill="#ffffff" fill-opacity="${barIndex <= index ? (enabled ? 0.95 : 0.55) : 0.2}"/>`;
    })
    .join("");
  return key(enabled ? "#253041" : COLORS.dim, label("Effort", fg) + bars + text(72, 108, effort, 21, fg, "middle", "bold", enabled ? 1 : 0.62) + targetLine(target, presentation, fg));
}

/** Autopilot (tools run without asking) or Supervised (writes and commands wait for Allow). */
export function renderAutonomy(autopilot: boolean | undefined, target: DeckKeyTarget | undefined, presentation: boolean): string {
  const fg = COLORS.white;
  if (!target) return noDeckSession("Autonomy", "plane");
  if (autopilot === undefined || target.metadataAvailable === false) {
    return key(COLORS.dim, label("Autonomy", fg) + icon("plane", 72, 68, 34, fg, { opacity: 0.25 }) + targetLine(target, presentation, fg));
  }
  const enabled = target.enabled !== false;
  return key(
    enabled ? (autopilot ? COLORS.green : "#9a6700") : COLORS.dim,
    icon(autopilot ? "plane" : "eye", 72, 42, 34, fg, { opacity: enabled ? 1 : 0.55 }) +
      text(72, 86, autopilot ? "Autopilot" : "Supervised", 20, fg, "middle", "bold", enabled ? 1 : 0.62) +
      text(72, 108, autopilot ? "runs tools" : "asks first", 14, fg, "middle", "normal", enabled ? 0.85 : 0.5) +
      targetLine(target, presentation, fg),
  );
}

/** Stops the target's running turn. */
export function renderStop(target: DeckKeyTarget | undefined, presentation: boolean): string {
  const fg = COLORS.white;
  if (!target) return noDeckSession("Stop", "stop");
  if (!target.working) {
    return key(COLORS.dim, icon("stop", 72, 50, 34, fg, { filled: true, opacity: 0.3 }) + text(72, 94, "Stop", 20, fg, "middle", "bold", 0.45) + text(72, 114, "not running", 14, fg, "middle", "normal", 0.45) + targetLine(target, presentation, fg));
  }
  return key(
    COLORS.red,
    `<circle cx="72" cy="46" r="27" fill="#ffffff" fill-opacity="0.16"/>` +
      icon("stop", 72, 46, 30, fg, { filled: true }) +
      text(72, 94, "Stop", 22, fg, "middle", "bold") +
      text(72, 114, target.workingMs !== undefined ? `working ${formatDuration(target.workingMs)}` : "working", 14, fg, "middle", "normal", 0.9) +
      targetLine(target, presentation, fg),
  );
}

/** A canned prompt from config.json: a new turn when the target is idle, steering while it works. */
export function renderPrompt(prompt: string | undefined, target: DeckKeyTarget | undefined, presentation: boolean): string {
  const fg = COLORS.white;
  const lines = wrap(prompt ?? "(no prompt set)", 12, 3);
  const active = target !== undefined && prompt !== undefined;
  const steer = target?.working === true;
  return key(
    !active ? COLORS.dim : steer ? "#1a4b8c" : "#253041",
    icon(steer ? "steer" : "chat", 21, 21, 18, fg, { opacity: active ? 0.9 : 0.4 }) +
      text(36, 26, steer ? "STEER" : "PROMPT", 12, fg, "start", "bold", active ? 0.78 : 0.4) +
      lines.map((l, i) => text(72, 58 + i * 21, l, 17, fg, "middle", "normal", active ? 1 : 0.5)).join("") +
      (target ? targetLine(target, presentation, fg) : text(72, 136, "no deck session", 13, fg, "middle", "normal", 0.45)),
  );
}

// ---- Press feedback ------------------------------------------------------------------------

export type FeedbackKind =
  | "allowed"
  | "denied"
  | "handed"
  | "seen"
  | "removed"
  | "opened"
  | "locked"
  | "unlocked"
  | "gate-on"
  | "gate-off"
  | "refreshed"
  | "sent"
  | "steered"
  | "stopped"
  | "model"
  | "effort"
  | "autopilot"
  | "supervised"
  | "nope";

const FEEDBACK: Record<FeedbackKind, { bg: string; icon: IconName; word: string; filled?: boolean }> = {
  allowed: { bg: COLORS.green, icon: "check", word: "Allowed" },
  denied: { bg: COLORS.red, icon: "x", word: "Denied" },
  handed: { bg: COLORS.blue, icon: "arrow", word: "In Kiro" },
  seen: { bg: COLORS.green, icon: "eye", word: "Seen" },
  removed: { bg: COLORS.slate, icon: "check", word: "Removed" },
  opened: { bg: COLORS.blue, icon: "arrow", word: "Opened" },
  locked: { bg: COLORS.red, icon: "lock", word: "Locked" },
  unlocked: { bg: COLORS.green, icon: "unlock", word: "Unlocked" },
  "gate-on": { bg: "#0969da", icon: "shieldCheck", word: "Gate on" },
  "gate-off": { bg: COLORS.slate, icon: "shield", word: "Gate off" },
  refreshed: { bg: COLORS.blue, icon: "refresh", word: "Updated" },
  sent: { bg: COLORS.blue, icon: "chat", word: "Sent" },
  steered: { bg: "#1a4b8c", icon: "steer", word: "Steering" },
  stopped: { bg: COLORS.red, icon: "stop", word: "Stopped", filled: true },
  model: { bg: "#0969da", icon: "chip", word: "Model" },
  effort: { bg: "#0969da", icon: "bars", word: "Effort" },
  autopilot: { bg: COLORS.green, icon: "plane", word: "Autopilot" },
  supervised: { bg: "#9a6700", icon: "eye", word: "Supervised" },
  nope: { bg: COLORS.dim, icon: "x", word: "Nothing to do" },
};

/**
 * The image a key shows for a moment after a press: what just happened, as icon and word.
 * `detail` adds a line (the new model, the reason nothing happened); `scale` (0..1] grows the
 * icon in, so two or three frames make a short pop.
 */
export function renderFeedback(kind: FeedbackKind, detail = "", scale = 1): string {
  const f = FEEDBACK[kind];
  const fg = COLORS.white;
  const nope = kind === "nope";
  // "Nothing to do" says why in its own words: the reason is the message.
  const headline = nope && detail ? detail.charAt(0).toUpperCase() + detail.slice(1) : f.word;
  const titleLines = wrap(headline, 12, 2);
  const words = nope ? [] : wrap(detail, 13, 2);
  const titleY = titleLines.length > 1 ? 98 : words.length ? 100 : 112;
  const titleSize = titleLines.length > 1 || headline.length > 9 ? 17 : 21;
  return key(
    f.bg,
    `<circle cx="72" cy="${nope ? 46 : 50}" r="${(34 * scale).toFixed(1)}" fill="#ffffff" fill-opacity="${nope ? 0.07 : 0.18}"/>` +
      icon(f.icon, 72, nope ? 46 : 50, 50 * scale, fg, { filled: f.filled, opacity: nope ? 0.6 : 1 }) +
      titleLines.map((l, i) => text(72, titleY + i * 20, l, titleSize, fg, "middle", "bold", nope ? 0.8 : 1)).join("") +
      words.map((l, i) => text(72, 120 + i * 18, l, 15, fg, "middle", "normal", 0.9)).join(""),
  );
}

// ---- Stream Deck + touch strip (200 x 100 per dial) ----------------------------------------

const strip = (color: string, body: string) => canvas(200, 100, color, body);

/** Dots that show the position in a list (at most 9 drawn). */
function dots(cx: number, y: number, count: number, index: number, fg: string): string {
  const n = Math.min(count, 9);
  if (n <= 1) return "";
  const at = Math.min(index, n - 1);
  const left = cx - ((n - 1) * 10) / 2;
  return Array.from({ length: n }, (_, i) => `<circle cx="${left + i * 10}" cy="${y}" r="${i === at ? 3.2 : 2.2}" fill="${fg}" fill-opacity="${i === at ? 1 : 0.35}"/>`).join("");
}

/** The session dial: the selected session; rotate to pick another, push to focus it. */
export function renderSessionDial(m: TileModel | undefined, index: number, count: number, now = 0): string {
  if (!m) return strip(COLORS.night, icon("sessions", 100, 40, 28, "#8b949e", { opacity: 0.6 }) + text(100, 80, "No session", 15, "#8b949e"));
  const look = LOOK[m.state];
  const phase = spinnerPhase(now);
  return strip(
    look.bg,
    pill(192, 6, m.badge, m.badge === "DECK" ? COLORS.teal : shade(look.bg, -0.45), COLORS.white) +
      text(10, 22, truncate(m.title, 14), 16, look.fg, "start", "bold") +
      icon(look.icon, 22, 50, 22, look.fg, { phase }) +
      text(40, 57, look.word, 19, look.fg, "start", "bold") +
      text(10, 80, truncate([m.detail, m.timer].filter(Boolean).join(" · "), m.context !== undefined ? 17 : 24), 13, look.fg, "start", "normal", 0.85) +
      (m.context !== undefined ? text(190, 80, `ctx ${formatContext(m.context)}`, 13, look.fg, "end", "bold", 0.9) : "") +
      dots(100, 93, count, index, look.fg),
  );
}

/** The model dial: rotate to choose (shown as "push to apply"), push to apply. */
export function renderModelDial(
  model: { name: string; rate?: number } | undefined,
  options: { pending: boolean; workspace?: string; index: number; count: number; budget?: boolean; available?: boolean; enabled?: boolean },
): string {
  const fg = COLORS.white;
  if (!model) {
    const unavailable = options.available === false;
    return strip(
      COLORS.dim,
      icon("chip", 100, 38, 26, fg, { opacity: 0.3 }) +
        (unavailable ? "" : text(100, 80, options.workspace ? "no model" : "no deck session", 14, fg, "middle", "normal", 0.5)),
    );
  }
  const enabled = options.enabled !== false;
  const pricey = options.budget === true && (model.rate ?? 1) > 1;
  return strip(
    enabled ? (options.pending ? "#0969da" : "#253041") : COLORS.dim,
    icon("chip", 18, 17, 16, fg, { opacity: enabled ? 0.85 : 0.4 }) +
      text(32, 22, enabled && options.pending ? "PUSH TO APPLY" : "MODEL", 11, fg, "start", "bold", enabled ? 0.8 : 0.45) +
      (pricey ? pill(192, 7, "BUDGET", COLORS.amber, COLORS.ink) : "") +
      text(100, 56, truncate(model.name.replace(/^Claude\s+/i, ""), 15), 22, fg, "middle", "bold", enabled ? 1 : 0.62) +
      text(100, 77, [model.rate !== undefined ? `${Number(model.rate.toFixed(2))}x credits` : "", options.workspace ? truncate(options.workspace, 12) : ""].filter(Boolean).join(" · "), 12, pricey ? "#f2cc60" : fg, "middle", "normal", enabled ? 0.85 : 0.5) +
      dots(100, 93, options.count, options.index, fg),
  );
}

/** The effort dial: bars for the levels, rotate to change. */
export function renderEffortDial(
  effort: string | undefined,
  levels: string[],
  workspace?: string,
  state: { available?: boolean; enabled?: boolean } = {},
): string {
  const fg = COLORS.white;
  if (!effort) {
    const unavailable = state.available === false;
    return strip(
      COLORS.dim,
      icon("bars", 100, 38, 26, fg, { opacity: 0.3 }) +
        (unavailable ? "" : text(100, 80, workspace ? "no effort for this model" : "no deck session", 13, fg, "middle", "normal", 0.5)),
    );
  }
  const count = Math.max(1, levels.length);
  const index = Math.max(0, levels.indexOf(effort));
  const barWidth = Math.min(20, Math.floor(150 / count) - 5);
  const left = 100 - (count * (barWidth + 5) - 5) / 2;
  const enabled = state.enabled !== false;
  const bars = levels
    .map((_, barIndex) => {
      const height = 6 + (barIndex + 1) * (26 / count);
      return `<rect x="${(left + barIndex * (barWidth + 5)).toFixed(1)}" y="${(64 - height).toFixed(1)}" width="${barWidth}" height="${height.toFixed(1)}" rx="3" fill="#ffffff" fill-opacity="${barIndex <= index ? (enabled ? 0.95 : 0.55) : 0.2}"/>`;
    })
    .join("");
  return strip(enabled ? "#253041" : COLORS.dim, text(10, 22, "EFFORT", 11, fg, "start", "bold", enabled ? 0.8 : 0.45) + bars + text(100, 88, effort, 17, fg, "middle", "bold", enabled ? 1 : 0.62));
}

/** The usage dial: credits as a ring and numbers. */
export function renderUsageDial(v: UsageView, now: Date): string {
  const fg = COLORS.white;
  if (v.percent === undefined || v.used === undefined) {
    return strip(COLORS.slate, icon("gauge", 40, 50, 30, fg, { opacity: 0.6 }) + text(70, 56, v.fetching ? "loading credits…" : "credits unavailable", 14, fg, "start", "normal", 0.85));
  }
  return strip(
    COLORS.night,
    ring(44, 50, 30, 8, v.percent / 100, usageColor(v.percent)) +
      text(44, 57, `${Math.round(v.percent)}%`, 18, fg, "middle", "bold") +
      text(90, 34, "CREDITS", 11, fg, "start", "bold", 0.75) +
      text(90, 56, v.limit ? `${formatCount(v.used)} / ${formatCount(v.limit)}` : formatCount(v.used), 15, fg, "start", "bold") +
      text(90, 76, v.resetDate ? `resets ${formatResetDate(v.resetDate, now)}` : (v.plan ?? ""), 12, fg, "start", "normal", 0.75),
  );
}

// ---- Stream Deck Neo infobar (232 x 50) ----------------------------------------------------

/** The Neo infobar: what waits on you, and credits. */
export function renderInfobar(inbox: { count: number; approvals: number; oldest?: string }, credits: number | undefined, presentation: boolean): string {
  const fg = COLORS.white;
  const busy = inbox.count > 0;
  const left = busy
    ? icon("hand", 18, 25, 20, fg) +
      text(34, 22, inbox.approvals > 0 ? `${inbox.approvals} to approve` : `${inbox.count} need${inbox.count === 1 ? "s" : ""} you`, 14, fg, "start", "bold") +
      text(34, 40, presentation ? "" : truncate(inbox.oldest ?? "", 16), 12, fg, "start", "normal", 0.8)
    : icon("check", 18, 25, 20, fg) + text(34, 30, "all clear", 15, fg, "start", "bold");
  const right =
    credits === undefined
      ? ""
      : `<rect x="164" y="30" width="58" height="7" rx="3.5" fill="#ffffff" fill-opacity="0.2"/>` +
        `<rect x="164" y="30" width="${(Math.max(0, Math.min(1, credits / 100)) * 58).toFixed(1)}" height="7" rx="3.5" fill="${usageColor(credits)}"/>` +
        text(222, 22, `${Math.round(credits)}%`, 14, fg, "end", "bold");
  return canvas(232, 50, busy ? COLORS.red : COLORS.night, left + right);
}

// ---- Helpers ---------------------------------------------------------------------------------

/** Credits of a turn: 0.0298 -> "0.03 cr", 1.5 -> "1.5 cr", 12.25 -> "12 cr". */
export function formatCredits(credits: number): string {
  const value = credits >= 10 ? Math.round(credits).toString() : credits >= 1 ? Number(credits.toFixed(1)).toString() : credits.toFixed(2);
  return `${value} cr`;
}

/** 2826.17 -> "2,826", 12400 -> "12.4k". */
export function formatCount(n: number): string {
  if (n >= 10_000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return Math.round(n).toLocaleString("en-US");
}

function formatMoney(amount: number, currency = "USD"): string {
  return currency === "USD" ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`;
}

/** "2026-12-01" -> "Dec 1", or "in 3 days" within a week. */
export function formatResetDate(isoDate: string, now: Date): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((date.getTime() - today.getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days > 1 && days < 7) return `in ${days} days`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Greedy word wrap into at most `maxLines` lines of `width` characters; the last line is truncated. */
export function wrap(value: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of value.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if ([...candidate].length <= width || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines.map((l) => truncate(l, width));
  return [...lines.slice(0, maxLines - 1), truncate(lines.slice(maxLines - 1).join(" "), width)].map((l) => truncate(l, width));
}

/** Stream Deck accepts images as data URLs. */
export function svgDataUrl(markup: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(markup, "utf8").toString("base64")}`;
}

export function truncate(value: string, max: number): string {
  const chars = [...value];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : value;
}

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}
