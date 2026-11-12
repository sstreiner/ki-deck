// Process helpers. Stream Deck starts plugins with a minimal PATH, so executables are
// looked up in the usual install locations, and commands always run without a shell.

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

export const runCommand: Runner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout), stderr: err && !stderr ? err.message : String(stderr) }),
    );
  });

const SEARCH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local/bin"), "/usr/bin", "/bin"];

/** First executable called `name` in the usual locations or PATH, else the first `extra` that exists. */
export function findExecutable(name: string, extra: string[] = []): string | undefined {
  const dirs = [...SEARCH_DIRS, ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)];
  const candidates = [...dirs.map((d) => join(d, name)), ...extra];
  return candidates.find((p) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface Executables {
  kiroCli?: string;
  tmux?: string;
  terminalNotifier?: string;
}

export function findExecutables(): Executables {
  return {
    kiroCli: findExecutable("kiro-cli", ["/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli"]),
    tmux: findExecutable("tmux"),
    terminalNotifier: findExecutable("terminal-notifier"),
  };
}

/**
 * Environment for kiro-cli: Stream Deck starts plugins with a minimal PATH, and kiro-cli
 * starts its own helpers, so give it the usual install locations.
 */
export function toolEnv(): NodeJS.ProcessEnv {
  const path = [...new Set([...SEARCH_DIRS, ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)])].join(delimiter);
  return { ...process.env, PATH: path };
}
