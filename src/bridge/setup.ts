// One-click setup for the packaged plugin (`npm run package` -> dist/*.streamDeckPlugin). The
// package carries the Kiro side in the plugin's `setup/` folder: the installer, kd-hook, the
// ki-deck command, the hook file, the default config and the companion extension. When
// they are missing on this Mac, or older than the package's, the plugin offers to install them:
// once per package in a dialog when it starts, and on the Inbox key until it is done.
//
// Nothing changes without a click on "Set up". It then runs the same installer as the repo
// (`setup/scripts/install.mjs --yes`, with the Node that runs this plugin: Stream Deck's own),
// which backs up every file it replaces, gates nothing, and can be undone with
// `ki-deck uninstall`. A plugin linked from the repo has no `setup/` folder, so it never
// asks.

import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compareVersions, parseVersion } from "../companion/update";
import type { Logger } from "./logger";
import type { RunResult } from "./system";

export type SetupNeed = "none" | "install" | "update";

export type LongRunner = (cmd: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv) => Promise<RunResult>;

export interface SetupOptions {
  /** The plugin's own folder (`<uuid>.sdPlugin`). */
  pluginDir: string;
  /** ~/.ki-deck */
  base: string;
  home: string;
  log: Logger;
  /** Environment for the installer: a PATH that finds `kiro` (Stream Deck gives plugins a minimal one). */
  env: NodeJS.ProcessEnv;
  /** Node to run the installer with; default the plugin's own (Stream Deck's bundled Node). */
  node?: string;
  exec?: LongRunner;
  now?: () => Date;
}

const DIALOG_WAIT_S = 900;
/**
 * How the installer's PATH line starts (`PATH_HINT_PREFIX` in scripts/install/core.mjs, which
 * test/setup.test.ts uses): printed when the command may not be on the user's PATH.
 */
const PATH_HINT = 'export PATH="';
const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** need() reads a few small files; cache it this long between redraws. */
const NEED_CACHE_MS = 30_000;

const DIALOG = `on run argv
  try
    set answer to display dialog (item 2 of argv) with title (item 1 of argv) buttons {"Not now", (item 3 of argv)} cancel button 1 with icon note giving up after (item 4 of argv as integer)
  on error number -128
    return "Not now"
  end try
  if gave up of answer then return "later"
  return button returned of answer
end run`;

const NOTIFY = `on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run`;

const execLong: LongRunner = (cmd, args, timeoutMs, env) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout), stderr: err && !stderr ? err.message : String(stderr) }),
    );
  });

function sameFile(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * `changed`: the need or the running state changed (the Inbox key redraws).
 * `packageInstalled`: the installer package's consent set up a Kiro side that was missing. The
 * package bypasses Stream Deck's own plugin install, which is what offers bundled profiles, so
 * the plugin offers them now (src/plugin.ts).
 */
export class Setup extends EventEmitter<{ changed: []; packageInstalled: [] }> {
  private cached?: { need: SetupNeed; at: number };
  private busy = false;
  private asking = false;

  constructor(private readonly options: SetupOptions) {
    super();
  }

  private get dir(): string {
    return join(this.options.pluginDir, "setup");
  }

  /** The plugin came from a package that carries the Kiro side. */
  get packaged(): boolean {
    return existsSync(this.installer);
  }

  private get installer(): string {
    return join(this.dir, "scripts", "install.mjs");
  }

  /** The installer is running. */
  get running(): boolean {
    return this.busy;
  }

  /** The package's version, from `setup/PACKAGED`. */
  get version(): string {
    return readText(join(this.dir, "PACKAGED")) || "?";
  }

  /**
   * What the Kiro side on this Mac lacks compared with the package: `install` when kd-hook or the
   * hook file is missing, `update` when one of them, the command or the companion is older.
   */
  need(): SetupNeed {
    const now = Date.now();
    if (this.cached && now - this.cached.at < NEED_CACHE_MS) return this.cached.need;
    const need = this.compute();
    this.cached = { need, at: now };
    return need;
  }

  /**
   * The installer stamps `~/.ki-deck/VERSION` when it finishes, from the repo or a package.
   * Only a package newer than the stamp offers an update, so a newer repo install or a hand-edited
   * hook file is never overwritten with older files. Installs from before the stamp (0.8 and
   * older) count as older when one of their files differs from the package's. The companion is
   * not compared: the installer can only install it when Kiro IDE is there, and an offer that a
   * successful run cannot satisfy would come back forever.
   */
  private compute(): SetupNeed {
    if (!this.packaged) return "none";
    const { base, home } = this.options;
    const kdHook = join(base, "bin", "kd-hook");
    const hookFile = join(home, ".kiro", "hooks", "ki-deck.json");
    if (!existsSync(kdHook) || !existsSync(hookFile)) return "install";
    const stamped = readText(join(base, "VERSION"));
    if (stamped) return parseVersion(this.version) && parseVersion(stamped) && compareVersions(this.version, stamped) > 0 ? "update" : "none";
    const files: Array<[string, string]> = [
      [join(this.dir, "hooks", "kd-hook"), kdHook],
      [join(this.dir, "bin", "ki-deck"), join(base, "bin", "ki-deck")],
      [join(this.dir, "hooks", "ki-deck.json"), hookFile],
    ];
    return files.some(([shipped, installed]) => !sameFile(shipped, installed)) ? "update" : "none";
  }

  /**
   * Asks with a dialog and, on "Set up", installs. At start (`fromKey` false) it asks once per
   * package: "Not now" is remembered until the next package. From the Inbox key it always asks.
   * No button is the default, so a stray Return cannot start the installer; Escape is "Not now".
   * After the macOS installer package (scripts/pkg/), whose user already chose Install, it
   * installs once without asking. Never rejects.
   */
  async offer(fromKey = false): Promise<void> {
    if (this.busy || this.asking) return;
    const need = this.need();
    if (this.takeConsent() && need !== "none") {
      this.options.log.info("setup: installing, as agreed in the installer package");
      const ok = await this.install().catch((err: unknown) => {
        this.options.log.warn(`setup: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      });
      if (ok && need === "install") this.emit("packageInstalled");
      return;
    }
    if (need === "none") return;
    // "Not now" holds for this package only: the file names the version it was given for.
    const declined = join(this.dir, ".declined");
    if (!fromKey && readText(declined) === this.version) return;
    this.asking = true;
    try {
      const update = need === "update";
      const button = update ? "Update" : "Set up";
      const text = update
        ? `The Kiro side of ki-deck on this Mac is older than this plugin (${this.version}). Update it?\n\nThe installer backs up every file it replaces.`
        : [
            "ki-deck needs a one-time setup on this Mac:",
            "",
            "• kd-hook and the ki-deck command in ~/.ki-deck",
            "• global Kiro hooks (~/.kiro/hooks/ki-deck.json): new Kiro sessions report to the deck",
            "• the Kiro companion extension, so the deck can answer Kiro's own prompts",
            "",
            "Nothing is gated: Kiro keeps asking exactly as before. Undo any time with: ki-deck uninstall",
          ].join("\n");
      const exec = this.options.exec ?? execLong;
      const answer = await exec("/usr/bin/osascript", ["-e", DIALOG, "ki-deck", text, button, String(DIALOG_WAIT_S)], (DIALOG_WAIT_S + 30) * 1000, this.options.env);
      const choice = answer.stdout.trim();
      if (choice === button) {
        await this.install().catch((err: unknown) => this.options.log.warn(`setup: ${err instanceof Error ? err.message : String(err)}`));
      } else if (choice === "Not now") {
        try {
          writeFileSync(declined, `${this.version}\n`);
        } catch {
          // a read-only plugin folder: it asks again next start
        }
        this.options.log.info("setup: postponed by the user");
      }
    } finally {
      this.asking = false;
    }
  }

  /**
   * The installer package's one-time consent (`setup/.consented`, written by
   * scripts/pkg/postinstall): true when it names this package's version. Always deleted, so it
   * counts once: a later `ki-deck uninstall` is never undone at the next start, and a
   * failed setup falls back to the dialog.
   */
  private takeConsent(): boolean {
    const file = join(this.dir, ".consented");
    if (!existsSync(file)) return false;
    const forThis = readText(file) === this.version;
    try {
      unlinkSync(file);
    } catch {
      // a read-only plugin folder: it would install again at the next start, so ask instead
      return false;
    }
    return forThis;
  }

  /** Runs the packaged installer. True when it finished without an error. */
  async install(): Promise<boolean> {
    if (this.busy || !this.packaged) return false;
    this.busy = true;
    this.emit("changed");
    const exec = this.options.exec ?? execLong;
    const now = this.options.now?.() ?? new Date();
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
    const logFile = join(this.options.base, "logs", `setup-${stamp}.log`);
    try {
      this.options.log.info(`setup: running the packaged installer (${this.version})`);
      const result = await exec(this.options.node ?? process.execPath, [this.installer, "--yes"], INSTALL_TIMEOUT_MS, this.options.env);
      await mkdir(join(this.options.base, "logs"), { recursive: true, mode: 0o700 });
      await writeFile(logFile, `${result.stdout}\n${result.stderr}`, { mode: 0o600 }).catch(() => undefined);
      if (result.ok) {
        this.options.log.info(`setup: done (${logFile})`);
        // The installer prints the PATH line when the command may not be on the user's PATH.
        const doctor = result.stdout.includes(PATH_HINT) ? `${this.shortPath(join(this.options.base, "bin", "ki-deck"))} doctor` : "ki-deck doctor";
        await this.notify("Kiro is set up for Stream Deck", `Start a new chat in Kiro and reload open Kiro windows once. Check with: ${doctor}`);
      } else {
        this.options.log.warn(`setup: the installer failed, see ${logFile}`);
        await this.notify("ki-deck: setup failed", `See ${logFile}`);
      }
      return result.ok;
    } finally {
      this.busy = false;
      this.cached = undefined;
      this.emit("changed");
    }
  }

  /** `path` with the home folder written as `~`. */
  private shortPath(path: string): string {
    const home = this.options.home.replace(/\/+$/, "");
    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  }

  private async notify(title: string, message: string): Promise<void> {
    const exec = this.options.exec ?? execLong;
    await exec("/usr/bin/osascript", ["-e", NOTIFY, title, message], 10_000, this.options.env);
  }
}
