// The companion extension posts Kiro's own permission prompts to the bridge (POST
// /v1/companion/ask). These helpers read that payload and describe the call the same way the
// gate does, so a native prompt and a gated call look identical on the deck. No Stream Deck or
// companion dependency, so the plugin bundle stays free of the extension's `vscode` import.

import { categorize } from "./tools";

/** The fields of a `PermissionAsk` the bridge needs. Everything is untrusted input. */
export interface PostedAsk {
  sessionId: string;
  toolCallId: string;
  toolId?: string;
  capability?: string;
  command?: string;
  resource?: string;
  workspaceRoot?: string;
  title: string;
  paths: string[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Reads what the companion posts. Undefined when it cannot identify the call. */
export function parsePostedAsk(raw: unknown): PostedAsk | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const sessionId = str(o.sessionId);
  const toolCallId = str(o.toolCallId);
  if (!sessionId || !toolCallId) return undefined;
  return {
    sessionId,
    toolCallId,
    ...(str(o.toolId) ? { toolId: str(o.toolId) } : {}),
    ...(str(o.capability) ? { capability: str(o.capability) } : {}),
    ...(str(o.command) ? { command: str(o.command) } : {}),
    ...(str(o.resource) ? { resource: str(o.resource) } : {}),
    ...(str(o.workspaceRoot) ? { workspaceRoot: str(o.workspaceRoot) } : {}),
    title: str(o.title) ?? "Approval",
    paths: Array.isArray(o.paths) ? o.paths.filter((p): p is string => typeof p === "string") : [],
  };
}

/** Display category for a native ask: Kiro's consent capability where known, else the tool name. */
export function companionCategory(ask: PostedAsk): string {
  const cap = ask.capability ?? "";
  if (cap === "shell") return "shell";
  if (cap.startsWith("fs_")) return "write";
  if (cap === "mcp" || (ask.toolId ?? "").startsWith("mcp_")) return "mcp";
  return categorize(ask.toolId ?? ask.title);
}

/** The `tool_input` shape summarize()/describe() expect, built from the ask's own fields. */
export function askInput(ask: PostedAsk): Record<string, string> {
  if (ask.command) return { command: ask.command };
  if (ask.paths.length > 0) return { path: ask.paths[0]! };
  if (ask.resource) return { path: ask.resource };
  return { name: ask.title };
}
