// The activity report: one self-contained HTML page built from the event ledger
// (~/.ki-deck/data/events-YYYY-MM-DD.jsonl), written to ~/.ki-deck/reports/ and
// opened in the default browser. No scripts and no external resources. It shows counts, times and
// workspace names only (names hidden in presentation mode), never commands or file names, even
// when the ledger stores them (`ledger.storeRaw`).

import { formatDuration } from "./notify";

/** One day's ledger file, oldest first. `date` is the local date (YYYY-MM-DD). */
export interface ReportDay {
  date: string;
  text: string;
}

export interface ReportCredits {
  plan?: string;
  used?: number;
  limit?: number;
  percent?: number;
  resetDate?: string;
}

export interface ReportInput {
  /** From `ReportBuilder` (or `summarize`); its `perDay` is the period, oldest first. */
  stats: ReportStats;
  now: Date;
  presentation: boolean;
  version: string;
  credits?: ReportCredits;
}

interface Bucket {
  turns: number;
  turnMs: number;
  toolCalls: number;
  credits: number;
}

export interface WorkspaceStats extends Bucket {
  name: string;
  sessions: number;
  denied: number;
}

export interface ReportStats {
  sessions: number;
  prompts: number;
  turns: number;
  turnMs: number;
  toolCalls: number;
  credits: number; // deck sessions only: credits their turns used
  allowed: number;
  denied: number;
  handed: number; // "Decide in Kiro", timeouts, gates turned off
  ungated: number;
  waitMs: number[]; // how long each call waited for its answer
  perDay: Array<{ date: string } & Bucket>;
  workspaces: WorkspaceStats[]; // most agent time first
  categories: Array<{ name: string; count: number }>; // most calls first
  surfaces: Array<{ name: string; turns: number }>;
  hours: number[]; // prompts per local hour of day
  answeredBy: Array<{ name: string; count: number }>;
}

interface Entry {
  ts?: unknown;
  event?: unknown;
  session?: unknown;
  surface?: unknown;
  workspace?: unknown;
  category?: unknown;
  turnMs?: unknown;
  decision?: unknown;
  by?: unknown;
  waitMs?: unknown;
  credits?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

const SURFACE_NAME: Record<string, string> = { ide: "Kiro IDE", cli: "kiro-cli", deck: "Deck sessions" };

/** Answers someone gave on a device; the rest (timeouts, lockdown, a gate turned off) answered themselves. */
const byPerson = (by: string) => by === "mobile" || /^device-\d+$/.test(by);

/**
 * Counts ledger lines one day at a time, so a long period never holds more than one day's file.
 * Lines that are not JSON are skipped.
 */
export class ReportBuilder {
  private readonly sessions = new Set<string>();
  private readonly workspaces = new Map<string, WorkspaceStats & { ids: Set<string> }>();
  private readonly categories = new Map<string, number>();
  private readonly surfaces = new Map<string, number>();
  private readonly answeredBy = new Map<string, number>();
  private readonly stats: ReportStats = {
    sessions: 0, prompts: 0, turns: 0, turnMs: 0, toolCalls: 0, credits: 0,
    allowed: 0, denied: 0, handed: 0, ungated: 0, waitMs: [],
    perDay: [], workspaces: [], categories: [], surfaces: [], hours: Array.from({ length: 24 }, () => 0), answeredBy: [],
  };

  private workspaceOf(name: string): WorkspaceStats & { ids: Set<string> } {
    let w = this.workspaces.get(name);
    if (!w) {
      w = { name, sessions: 0, turns: 0, turnMs: 0, toolCalls: 0, credits: 0, denied: 0, ids: new Set() };
      this.workspaces.set(name, w);
    }
    return w;
  }

  /** Adds one day's ledger file. Call oldest first. */
  add(day: ReportDay): void {
    const { stats, sessions, categories, surfaces, answeredBy } = this;
    const hours = stats.hours;
    const bucket = { date: day.date, turns: 0, turnMs: 0, toolCalls: 0, credits: 0 };
    stats.perDay.push(bucket);
    for (const line of day.text.split("\n")) {
      if (!line.trim()) continue;
      let e: Entry;
      try {
        e = JSON.parse(line) as Entry;
      } catch {
        continue;
      }
      if (typeof e !== "object" || e === null) continue;
      const event = str(e.event);
      const session = str(e.session);
      const w = this.workspaceOf(str(e.workspace) || "(no workspace)");
      if (session && event !== "Decision") {
        sessions.add(session);
        w.ids.add(session);
      }
      switch (event) {
        case "UserPromptSubmit": {
          stats.prompts++;
          const at = new Date(str(e.ts));
          if (!Number.isNaN(at.getTime())) hours[at.getHours()]!++;
          break;
        }
        case "Stop": {
          const ms = num(e.turnMs);
          const credits = num(e.credits);
          stats.turns++;
          stats.turnMs += ms;
          stats.credits += credits;
          bucket.turns++;
          bucket.turnMs += ms;
          bucket.credits += credits;
          w.turns++;
          w.turnMs += ms;
          w.credits += credits;
          const surface = str(e.surface) || "ide";
          surfaces.set(surface, (surfaces.get(surface) ?? 0) + 1);
          break;
        }
        case "PreToolUse": {
          stats.toolCalls++;
          bucket.toolCalls++;
          w.toolCalls++;
          const category = str(e.category) || "other";
          categories.set(category, (categories.get(category) ?? 0) + 1);
          break;
        }
        case "Ungated":
          stats.ungated++;
          break;
        case "Decision": {
          const decision = str(e.decision);
          if (decision === "allow") stats.allowed++;
          else if (decision === "deny") {
            stats.denied++;
            w.denied++;
          } else stats.handed++;
          const by = str(e.by) || "unknown";
          answeredBy.set(by, (answeredBy.get(by) ?? 0) + 1);
          // "How fast you answered" counts only answers a person gave, not timeouts or lockdown.
          if (typeof e.waitMs === "number" && byPerson(by)) stats.waitMs.push(num(e.waitMs));
          break;
        }
      }
    }
  }

  /** The totals of every day added so far. */
  result(): ReportStats {
    const stats = { ...this.stats };
    stats.sessions = this.sessions.size;
    stats.workspaces = [...this.workspaces.values()]
      // Sessions that only started (no turn, tool or decision) say nothing about the work.
      .filter((w) => w.turns > 0 || w.toolCalls > 0 || w.denied > 0)
      .map(({ ids, ...w }) => ({ ...w, sessions: ids.size }))
      .sort((a, b) => b.turnMs - a.turnMs || b.toolCalls - a.toolCalls || a.name.localeCompare(b.name));
    stats.categories = [...this.categories].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    stats.surfaces = [...this.surfaces].map(([name, turns]) => ({ name: SURFACE_NAME[name] ?? name, turns })).sort((a, b) => b.turns - a.turns);
    stats.answeredBy = [...this.answeredBy].map(([name, count]) => ({ name: answerSource(name), count })).sort((a, b) => b.count - a.count);
    return stats;
  }
}

/** Counts the ledger lines of every day. */
export function summarize(days: ReportDay[]): ReportStats {
  const builder = new ReportBuilder();
  for (const day of days) builder.add(day);
  return builder.result();
}

const ANSWERED_BY: Record<string, string> = {
  mobile: "Stream Deck Mobile",
  timeout: "Nobody (timed out)",
  cancelled: "Kiro (cancelled)",
  lockdown: "Lockdown",
  "gate-off": "Gate turned off",
  shutdown: "Stream Deck closed",
};

/** Who answered: "mobile" -> "Stream Deck Mobile", "device-1" -> "Stream Deck (type 1)". */
function answerSource(by: string): string {
  const device = /^device-(\d+)$/.exec(by);
  if (device) return `Stream Deck (type ${device[1]})`;
  return ANSWERED_BY[by] ?? by;
}

export function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---- HTML ---------------------------------------------------------------------------------

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const count = (n: number) => Math.round(n).toLocaleString("en-US");

/** 3_600_000 -> "1h00", 90_000 -> "1m"; whole hours for big totals. */
function hours(ms: number): string {
  return ms >= 100 * 3_600_000 ? `${Math.round(ms / 3_600_000)}h` : formatDuration(ms);
}

function shortDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function card(label: string, value: string, note = ""): string {
  return `<div class="card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${note ? `<div class="note">${esc(note)}</div>` : ""}</div>`;
}

/** A label under bar `i` of `n`; the first and last align to the chart's edges so they are not cut off. */
function axisLabel(i: number, n: number, step: number, y: number, value: string): string {
  const [x, anchor] = i === 0 ? [0, "start"] : i === n - 1 ? [n * step, "end"] : [i * step + step / 2, "middle"];
  return `<text x="${x.toFixed(1)}" y="${y}" text-anchor="${anchor}" class="axis">${esc(value)}</text>`;
}

/** Agent time per day as bars; each bar's tooltip has the day's numbers. */
function dayChart(perDay: ReportStats["perDay"]): string {
  const w = 720;
  const h = 170;
  const top = 12;
  const bottom = 26;
  const n = Math.max(1, perDay.length);
  const step = w / n;
  const barW = Math.max(2, step * 0.7);
  const max = Math.max(1, ...perDay.map((d) => d.turnMs));
  const scale = (h - top - bottom) / max;
  const bars = perDay
    .map((d, i) => {
      const bh = d.turnMs * scale;
      const x = i * step + (step - barW) / 2;
      const tip = `${shortDate(d.date)}: ${d.turns} ${d.turns === 1 ? "turn" : "turns"}, ${hours(d.turnMs)} working, ${count(d.toolCalls)} tool calls${d.credits ? `, ${d.credits.toFixed(2)} deck credits` : ""}`;
      return `<rect x="${x.toFixed(1)}" y="${(h - bottom - bh).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(bh, d.turns ? 1.5 : 0).toFixed(1)}" rx="2" class="bar"><title>${esc(tip)}</title></rect>`;
    })
    .join("");
  const labelAt = new Set([0, Math.floor((n - 1) / 2), n - 1]);
  const labels = perDay.map((d, i) => (labelAt.has(i) ? axisLabel(i, n, step, h - 8, shortDate(d.date)) : "")).join("");
  const peak = `<text x="0" y="${top - 2}" class="axis">${esc(hours(max))} peak</text>`;
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Agent time per day" class="chart"><line x1="0" x2="${w}" y1="${h - bottom}" y2="${h - bottom}" class="base"/>${bars}${labels}${peak}</svg>`;
}

/** Prompts per hour of the day. */
function hourChart(values: number[]): string {
  const w = 720;
  const h = 110;
  const bottom = 22;
  const step = w / 24;
  const max = Math.max(1, ...values);
  const bars = values
    .map((v, i) => {
      const bh = (v / max) * (h - bottom - 6);
      return `<rect x="${(i * step + 3).toFixed(1)}" y="${(h - bottom - bh).toFixed(1)}" width="${(step - 6).toFixed(1)}" height="${bh.toFixed(1)}" rx="2" class="bar alt"><title>${i}:00 to ${i + 1}:00: ${v} ${v === 1 ? "prompt" : "prompts"}</title></rect>`;
    })
    .join("");
  const labels = [0, 6, 12, 18, 23].map((i) => axisLabel(i, 24, step, h - 6, `${i}:00`)).join("");
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Prompts per hour of the day" class="chart">${bars}${labels}</svg>`;
}

/** A list of names with a bar each, for shares. `unit` is singular; an "s" is added for other counts. */
function barList(items: Array<{ name: string; count: number }>, unit: string): string {
  if (!items.length) return `<p class="empty">None in this period.</p>`;
  const max = Math.max(1, ...items.map((i) => i.count));
  return `<ul class="bars">${items
    .map((i) => `<li><span class="name">${esc(i.name)}</span><span class="track"><span class="fill" style="width:${((i.count / max) * 100).toFixed(1)}%"></span></span><span class="num">${count(i.count)} ${esc(i.count === 1 ? unit : `${unit}s`)}</span></li>`)
    .join("")}</ul>`;
}

const STYLE = `
:root { color-scheme: light dark; --bg:#f6f8fa; --panel:#ffffff; --ink:#1f2328; --dim:#59636e; --line:#d1d9e0; --bar:#1f6feb; --alt:#0f8577; --good:#1a7f37; --bad:#d1242f; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --panel:#161b22; --ink:#e6edf3; --dim:#9198a1; --line:#30363d; --bar:#4493f8; --alt:#2fb39c; --good:#3fb950; --bad:#f85149; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 32px 24px 48px; }
h1 { margin: 0 0 4px; font-size: 28px; }
h2 { margin: 0 0 12px; font-size: 17px; }
.sub { color: var(--dim); margin: 0 0 24px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 12px; margin-bottom: 16px; }
.card, section { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
.card { padding: 14px 16px; }
.label { color: var(--dim); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.value { font-size: 26px; font-weight: 700; margin-top: 2px; }
.note { color: var(--dim); font-size: 13px; }
section { padding: 18px 20px; margin-top: 16px; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.two section { margin-top: 0; }
@media (max-width: 760px) { .two { grid-template-columns: 1fr; } }
.chart { width: 100%; height: auto; display: block; }
.bar { fill: var(--bar); } .bar.alt { fill: var(--alt); }
.base { stroke: var(--line); }
.axis { fill: var(--dim); font-size: 12px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 7px 8px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
th:first-child, td:first-child { text-align: left; white-space: normal; }
th { color: var(--dim); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
tr:last-child td { border-bottom: 0; }
.bars { list-style: none; margin: 0; padding: 0; }
.bars li { display: grid; grid-template-columns: 9em 1fr auto; gap: 10px; align-items: center; padding: 4px 0; }
.track { height: 10px; border-radius: 5px; background: var(--line); overflow: hidden; }
.fill { display: block; height: 100%; background: var(--bar); border-radius: 5px; }
.num { color: var(--dim); font-variant-numeric: tabular-nums; }
.empty { color: var(--dim); margin: 0; }
.good { color: var(--good); } .bad { color: var(--bad); }
footer { color: var(--dim); font-size: 13px; margin-top: 24px; }
@media print { body { background: #fff; } section, .card { break-inside: avoid; } }
`;

/** The whole report page. Pure: the same input gives the same page. */
export function renderReport(input: ReportInput): string {
  const s = input.stats;
  const dayCount = s.perDay.length;
  const first = s.perDay[0]?.date;
  const last = s.perDay[dayCount - 1]?.date;
  const period = first && last ? `${shortDate(first)} to ${shortDate(last)}` : "";
  const generated = input.now.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const decided = s.allowed + s.denied + s.handed;
  const wait = median(s.waitMs);

  // Presentation mode: workspaces keep their order and numbers, not their names.
  const names = input.presentation ? s.workspaces.map((_, i) => `Workspace ${i + 1}`) : s.workspaces.map((w) => w.name);
  const showCredits = s.credits > 0 || s.workspaces.some((w) => w.credits > 0);
  const workspaceRows = s.workspaces
    .map(
      (w, i) =>
        `<tr><td>${esc(names[i]!)}</td><td>${count(w.sessions)}</td><td>${count(w.turns)}</td><td>${esc(hours(w.turnMs))}</td><td>${count(w.toolCalls)}</td><td>${count(w.denied)}</td>${showCredits ? `<td>${w.credits ? w.credits.toFixed(2) : "–"}</td>` : ""}</tr>`,
    )
    .join("");

  const c = input.credits;
  const creditsCard =
    c && c.percent !== undefined && c.used !== undefined
      ? card("Credits this cycle", `${Math.round(c.percent)}%`, `${count(c.used)}${c.limit ? ` of ${count(c.limit)}` : ""}${c.resetDate ? `, resets ${shortDate(c.resetDate)}` : ""}`)
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Kiro activity, last ${dayCount} days</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Kiro activity</h1>
<p class="sub">Last ${dayCount} days${period ? `, ${esc(period)}` : ""}. Generated ${esc(generated)}${c?.plan ? `. Plan: ${esc(c.plan)}` : ""}.</p>
<div class="cards">
${card("Agent time", hours(s.turnMs), `${count(s.turns)} ${s.turns === 1 ? "turn" : "turns"}`)}
${card("Sessions", count(s.sessions), `${count(s.prompts)} prompts`)}
${card("Tool calls", count(s.toolCalls), s.turns ? `${count(s.toolCalls / s.turns)} per turn` : "")}
${card("Approvals", count(decided), decided ? `${s.allowed} allowed, ${s.denied} denied` : "none on the deck")}
${s.credits > 0 ? card("Deck credits", s.credits.toFixed(2), "used by deck sessions") : ""}
${creditsCard}
</div>
<section>
<h2>Agent time per day</h2>
${dayChart(s.perDay)}
</section>
<div class="two">
<section>
<h2>Workspaces</h2>
${s.workspaces.length ? `<table><thead><tr><th>Workspace</th><th>Sessions</th><th>Turns</th><th>Time</th><th>Tools</th><th>Denied</th>${showCredits ? "<th>Credits</th>" : ""}</tr></thead><tbody>${workspaceRows}</tbody></table>` : `<p class="empty">No activity in this period.</p>`}
</section>
<section>
<h2>Tool calls by kind</h2>
${barList(s.categories, "call")}
</section>
</div>
<section>
<h2>When you prompt</h2>
${hourChart(s.hours)}
</section>
<div class="two">
<section>
<h2>Where the turns ran</h2>
${barList(s.surfaces.map((x) => ({ name: x.name, count: x.turns })), "turn")}
</section>
<section>
<h2>Approvals</h2>
${
  decided
    ? `<p><span class="good">${s.allowed} allowed</span>, <span class="bad">${s.denied} denied</span>, ${s.handed} left to Kiro.${wait !== undefined ? ` Half were answered within ${esc(formatDuration(wait))}.` : ""}</p>${barList(s.answeredBy, "answer")}`
    : `<p class="empty">No calls waited for the deck in this period.</p>`
}
${s.ungated ? `<p class="bad">${s.ungated} gated ${s.ungated === 1 ? "call" : "calls"} ran without asking the deck (Ungated).</p>` : ""}
</section>
</div>
<footer>Built on this Mac from the ki-deck event ledger (~/.ki-deck/data). Nothing was sent anywhere. ki-deck ${esc(input.version)}.</footer>
</main>
</body>
</html>
`;
}
