// What Kiro's agent asks its clients: `session/request_permission` (ACP), as Kiro IDE 1.4.121
// sends it through its agent hub. Everything here is untrusted input.

export interface PermissionOption {
  optionId: string;
  kind: string; // "allow_once" | "allow_always" | "reject_once" | "reject_always"
  name: string;
}

export interface PermissionAsk {
  sessionId: string;
  toolCallId: string;
  consentRound?: number; // with toolCallId, identifies the ask (a call can be asked again)
  title: string; // "Write File", or the command itself for run_command
  toolId?: string; // Kiro's tool, e.g. "fs_write", "run_command"
  capability?: string; // what Kiro asks for: "fs_write", "shell", ...
  resource?: string; // what it acts on: the file path or the command
  command?: string; // shell commands
  workspaceRoot?: string;
  paths: string[]; // files the call touches
  text?: string; // the first text content, if any
  options: PermissionOption[];
}

/**
 * The end of an ask, which the hub sends to every client: Kiro's dialog, another client or the
 * deck answered it, or the turn was cancelled.
 */
export interface AskResolved {
  sessionId: string;
  toolCallId: string;
  consentRound?: number;
}

/** What the deck sends back for an ask: an option of that ask, and a reason for "reject once". */
export interface AskAnswer {
  optionId: string;
  rejectionReason?: string;
}

/** The option of the given kind ("allow_once", "reject_once", ...), if Kiro offered it. */
export function optionOf(ask: Pick<PermissionAsk, "options">, kind: string): PermissionOption | undefined {
  return ask.options.find((o) => o.kind === kind);
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** Reads the params of a `session/request_permission` request. Undefined when they are unusable. */
export function parsePermissionAsk(params: unknown): PermissionAsk | undefined {
  const p = obj(params);
  const call = obj(p?.toolCall);
  const sessionId = str(p?.sessionId);
  const toolCallId = str(call?.toolCallId);
  if (!p || !call || !sessionId || !toolCallId) return undefined;

  const kiro = obj(obj(p._meta)?.kiro);
  const consent = obj(kiro?.consent);
  const locations = Array.isArray(call.locations) ? call.locations : [];
  const content = Array.isArray(call.content) ? call.content : [];
  const text = content.map((c) => str(obj(obj(c)?.content)?.text)).find((t) => t !== undefined);
  const options = (Array.isArray(p.options) ? p.options : [])
    .map(obj)
    .filter((o): o is Record<string, unknown> => o !== undefined && str(o.optionId) !== undefined)
    .map((o) => ({ optionId: str(o.optionId)!, kind: str(o.kind) ?? "", name: str(o.name) ?? "" }));
  const capability = str(consent?.capability);
  const resource = str(consent?.resource);
  const paths = locations.map((l) => str(obj(l)?.path)).filter((x): x is string => x !== undefined);
  // File asks name their file only as the consent resource.
  if (resource && capability?.startsWith("fs_") && !paths.includes(resource)) paths.push(resource);
  const round = kiro?.consentRound;

  return {
    sessionId,
    toolCallId,
    ...(typeof round === "number" ? { consentRound: round } : {}),
    title: str(call.title) ?? "Approval",
    ...(str(kiro?.toolId) ? { toolId: str(kiro?.toolId) } : {}),
    ...(capability ? { capability } : {}),
    ...(resource ? { resource } : {}),
    ...(str(kiro?.command) ? { command: str(kiro?.command) } : {}),
    ...(str(consent?.workspaceRoot) ? { workspaceRoot: str(consent?.workspaceRoot) } : {}),
    paths,
    ...(text ? { text } : {}),
    options,
  };
}

/** The parts of Kiro's context breakdown; together they are the share of the window in use. */
const CONTEXT_PARTS = ["contextFiles", "tools", "sessionFiles", "memory", "kiroResponses", "yourPrompts"] as const;

/**
 * How full a chat's context window is, in percent, from the result of `_kiro/session/context`
 * with `subcommand: "show"`: the sum of its breakdown's parts, which Kiro reconciles with the
 * usage the model last reported (`tools` already includes its MCP and built-in shares).
 * Undefined when the result has no breakdown.
 */
export function contextFromShow(result: unknown): number | undefined {
  const breakdown = obj(obj(result)?.breakdown);
  if (!breakdown) return undefined;
  let total = 0;
  let found = false;
  for (const part of CONTEXT_PARTS) {
    const percent = obj(breakdown[part])?.percent;
    if (typeof percent === "number" && Number.isFinite(percent)) {
      total += percent;
      found = true;
    }
  }
  return found ? Math.round(Math.max(0, Math.min(100, total)) * 10) / 10 : undefined;
}

/**
 * Reads a `session/update` that ends an ask: `update._meta.kiro` is
 * `{ kind: "interaction_resolved", toolCallId, consentRound? }` (the shape the hub itself
 * checks before sending such updates to every client).
 */
export function parseAskResolved(params: unknown): AskResolved | undefined {
  const p = obj(params);
  const sessionId = str(p?.sessionId);
  const kiro = obj(obj(obj(p?.update)?._meta)?.kiro);
  if (!sessionId || str(kiro?.kind) !== "interaction_resolved") return undefined;
  const toolCallId = str(kiro?.toolCallId);
  if (!toolCallId) return undefined;
  const round = kiro?.consentRound;
  return { sessionId, toolCallId, ...(typeof round === "number" ? { consentRound: round } : {}) };
}
