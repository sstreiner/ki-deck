// Classifies Kiro tool calls from hook payloads. Hook events carry only `tool_name`
// (no category tags), so categories are derived from the name. The patterns cover the
// built-in tool IDs seen in Kiro IDE and CLI; the event ledger shows any that fall through.

import { homedir } from "node:os";
import { basename, dirname } from "node:path";

export type ToolCategory = "shell" | "write" | "read" | "web" | "mcp" | "other";
export type GateCategory = "shell" | "write" | "mcp";
export const GATE_CATEGORIES: readonly GateCategory[] = ["shell", "write", "mcp"];

/**
 * Tools that Kiro's own hook matchers `shell` and `write` cover, so their gate hook runs.
 * Read from the tool tags in Kiro IDE 1.4.121 (kiro.kiro-agent 1.1.787) and kiro-cli 3.0.0,
 * and checked live in the IDE: control_bash_process and get_process_output ran the shell gate,
 * delete_file the write gate; list_processes, smart_relocate and semantic_rename ran none.
 * MCP tools are named `mcp_<server>_<tool>` and all carry the `@mcp` tag.
 */
const GATE_COVERED: Readonly<Record<string, GateCategory>> = {
  execute_bash: "shell",
  execute_pwsh: "shell",
  control_bash_process: "shell",
  control_pwsh_process: "shell",
  get_process_output: "shell",
  fs_write: "write",
  fs_append: "write",
  str_replace: "write",
  delete_file: "write",
  code: "write",
  create_artifact: "write",
  create_task: "write",
  add_memory: "write",
  update_memory: "write",
  delete_memory: "write",
  open_browser_page: "write",
  close_browser_page: "write",
  navigate_page: "write",
  click_element: "write",
  hover_element: "write",
  type_in_page: "write",
  handle_dialog: "write",
};

/** The gate whose hook Kiro runs for this tool, or undefined when no gate covers it. */
export function gateCategory(toolName: string): GateCategory | undefined {
  return GATE_COVERED[toolName] ?? (/^mcp_/.test(toolName) ? "mcp" : undefined);
}

export function isGateCategory(value: unknown): value is GateCategory {
  return typeof value === "string" && (GATE_CATEGORIES as readonly string[]).includes(value);
}

const CATEGORY_PATTERNS: ReadonlyArray<[ToolCategory, RegExp]> = [
  ["mcp", /^(mcp_|@)/],
  ["shell", /bash|shell|command|terminal|process/i],
  ["write", /write|replace|append|delete|edit|create|relocate|rename|patch|move/i],
  ["web", /web|fetch|http|url/i],
  ["read", /read|grep|search|list|glob|find|code|diagnos/i],
];

/** Display category: Kiro's gate category where known, else a guess from the name. */
export function categorize(toolName: string): ToolCategory {
  return gateCategory(toolName) ?? CATEGORY_PATTERNS.find(([, pattern]) => pattern.test(toolName))?.[0] ?? "other";
}

const COMMAND_FIELDS = ["command", "cmd"];
const PATH_FIELDS = ["path", "file_path", "filePath", "targetFile", "sourcePath", "target_file"];
const OTHER_FIELDS = ["url", "query", "pattern", "name"];

/** Short, redacted description of what a tool call acts on, for display on a key. */
export function summarize(toolName: string, input: unknown): string {
  const fields = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const pick = (names: string[]) => names.map((n) => fields[n]).find((v): v is string => typeof v === "string" && v.trim() !== "");

  const command = pick(COMMAND_FIELDS);
  if (command) return redact(command.split("\n")[0]!.trim());
  const path = pick(PATH_FIELDS);
  if (path) return shortPath(path);
  const other = pick(OTHER_FIELDS);
  if (other) return redact(other.trim());
  return toolName;
}

/**
 * The whole request, redacted, for the request banner: every line of a command (joined with ⏎),
 * a full path, or the tool name with its input. At most `max` characters.
 */
export function describe(toolName: string, input: unknown, max = 400): string {
  const fields = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const pick = (names: string[]) => names.map((n) => fields[n]).find((v): v is string => typeof v === "string" && v.trim() !== "");
  const clip = (s: string) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

  const command = pick(COMMAND_FIELDS);
  if (command) return clip(redact(command.trim().split(/\s*\n\s*/).join(" ⏎ ").replace(/[ \t]+/g, " ")));
  const path = pick(PATH_FIELDS);
  if (path) return clip(tildify(path));
  const other = pick(OTHER_FIELDS);
  if (other) return clip(redact(other.trim()));
  const json = Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
  return clip(redact(`${toolName}${json}`));
}

function tildify(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function shortPath(path: string): string {
  const parent = basename(dirname(path));
  const name = basename(path);
  return parent && parent !== "." && parent !== "/" ? `${parent}/${name}` : name;
}

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "•••"],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{8,}/g, "•••"],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, "•••"],
  [/\bA[KS]IA[A-Z0-9]{12,}/g, "•••"],
  [/\b(Bearer|Basic)\s+[^\s'"]+/gi, "$1 •••"],
  [/\b(password|passwd|pwd|token|secret|api[_-]?key|auth)(\s*[=:]\s*)[^\s'"]+/gi, "$1$2•••"],
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, "•••"],
];

/** Masks common credential shapes. Best effort: keys show at most a few words anyway. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}
