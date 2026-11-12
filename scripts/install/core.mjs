// @ts-check
// The ki-deck installer: the Kiro side (kd-hook, the ki-deck command, config, the
// global Kiro hooks, the companion extension) and, from the repository, the Stream Deck plugin.
// One implementation for both ways in: scripts/install.sh runs it with the user's Node, and a
// packaged plugin's one-click setup (src/bridge/setup.ts) runs it from the plugin's setup/ folder
// with Stream Deck's own Node. Safe to re-run: unchanged files are skipped, changed ones are
// backed up first. Node built-ins only, so it runs before (and without) `npm ci`.
//
// What differs per OS comes in as a Platform (macos.mjs); MULTIOS.md has the Windows plan.

import { accessSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { basename, delimiter, dirname, join, relative } from "node:path";

export const PLUGIN_UUID = "net.streiner.ki-deck";
export const COMPANION_ID = "sstreiner.ki-deck-companion";
const CATEGORIES = ["shell", "write", "mcp"];
/** The plugin's manifest needs this Stream Deck version (Software.MinimumVersion). */
const STREAM_DECK_MIN = "7.6";
/**
 * Starts the line printed when the command may not be on the user's PATH. The packaged setup
 * (src/bridge/setup.ts) looks for it to name the command's full path in its notification.
 */
export const PATH_HINT_PREFIX = 'export PATH="';

export const USAGE = `Usage: scripts/install.sh [options]

  --yes, -y          Accept the plan without asking (required when not run from a terminal)
  --dry-run, -n      Show what would change, change nothing
  --gate LIST        Gate these categories through Stream Deck from the start,
                     comma-separated: shell,write,mcp (default: none, Mirror mode)
  --skip-plugin      Only install the Kiro side
  --dev              Also enable Stream Deck developer mode (debugger, inspector)
  --help, -h         Show this help`;

const NEXT_STEPS = `
Next steps
  1. Start a NEW chat session in Kiro (and restart any kiro-cli session) so the hooks load,
     send one prompt, then run: ki-deck doctor
  2. Reload open Kiro windows (Command Palette -> Developer: Reload Window) so the companion
     extension loads; then the deck can answer Kiro's own IDE approval prompts.
  3. Put the keys on your devices: ki-deck profiles (Stream Deck asks once per device), or drag
     the actions from the "ki-deck" category in the Stream Deck app.
  4. Stream Deck Mobile: device menu (top left) -> Add Mobile Device, scan the code with the app.
  5. Gate approvals when you are ready: ki-deck gate shell on`;

/**
 * @typedef {object} RunResult
 * @property {boolean} ok
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {object} RunOptions
 * @property {string} [cwd]
 * @property {boolean} [inherit] Stream the output (and take stdin) instead of capturing it.
 * @property {number} [timeoutMs]
 */

/** @typedef {(cmd: string, args: string[], options?: RunOptions) => Promise<RunResult>} Runner */

/**
 * What differs per OS.
 * @typedef {object} Platform
 * @property {() => string} checkSystem The OS and its version ("macOS 26.6.2"); throws when unsupported.
 * @property {(name: string) => string} appVersion The version of an installed app, "" when it is missing.
 * @property {() => string | undefined} bundledKiro Kiro IDE's own `kiro` launcher, for when the command is not on the PATH.
 * @property {string} pluginsDir Stream Deck's plugin folder.
 * @property {string[]} sharedBinDirs Folders often on the PATH that the command may be linked into, after ~/.local/bin and ~/bin.
 * @property {string} shellProfile Where a PATH line goes, for the hint.
 * @property {string} streamDeckLog
 * @property {() => Promise<string | undefined>} loginShellPath The PATH a new terminal gets.
 * @property {() => boolean} streamDeckRunning
 * @property {() => Promise<void>} quitStreamDeck
 * @property {() => Promise<void>} openStreamDeck
 */

/**
 * @typedef {object} Deps
 * @property {string} root The folder holding scripts/, hooks/, bin/ and config/: the repository, or a package's setup/.
 * @property {string} home
 * @property {NodeJS.ProcessEnv} env
 * @property {string} nodeVersion The running Node's version ("24.11.0"), which also builds the plugin.
 * @property {boolean} interactive Stdin is a terminal.
 * @property {(question: string) => Promise<string>} ask
 * @property {(text: string) => void} out
 * @property {(text: string) => void} err
 * @property {Runner} run
 * @property {Platform} platform
 * @property {() => Date} [now]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {(socketPath: string) => Promise<number | undefined>} [bridgePid]
 */

/**
 * @typedef {object} Options
 * @property {boolean} yes
 * @property {boolean} dry
 * @property {boolean} skipPlugin
 * @property {boolean} dev
 * @property {boolean} help
 * @property {string[] | undefined} gate Categories to gate, or undefined to keep the current ones.
 */

/** An error the installer reports as `install: <message>`, optionally after the usage text. */
export class Fail extends Error {
  /** @param {string} message @param {boolean} [usage] */
  constructor(message, usage = false) {
    super(message);
    this.usage = usage;
  }
}

/** @param {string[]} argv @returns {Options} */
export function parseArgs(argv) {
  /** @type {Options} */
  const options = { yes: false, dry: false, skipPlugin: false, dev: false, help: false, gate: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--dry-run" || arg === "-n") options.dry = true;
    else if (arg === "--skip-plugin") options.skipPlugin = true;
    else if (arg === "--dev") options.dev = true;
    else if (arg === "--help" || arg === "-h") return { ...options, help: true };
    else if (arg === "--gate") {
      const list = argv[++i];
      if (list === undefined) throw new Fail("--gate needs a list, for example --gate shell,mcp");
      options.gate = list.split(/[\s,]+/).filter(Boolean);
    } else throw new Fail(`unknown option: ${arg}`, true);
  }
  for (const c of options.gate ?? []) {
    if (!CATEGORIES.includes(c)) throw new Fail(`unknown gate category '${c}' (use shell, write, mcp)`);
  }
  return options;
}

/** True when dotted version `a` is at least `b`, comparing major and minor. @param {string} a @param {string} b */
export function versionAtLeast(a, b) {
  const [x1 = 0, x2 = 0] = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [y1 = 0, y2 = 0] = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  return x1 !== y1 ? x1 > y1 : x2 >= y2;
}

/** The first executable called `name` on `path`. @param {string} name @param {string | undefined} path */
export function which(name, path) {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** The PID of the bridge answering on `socketPath`, undefined when none does. @param {string} socketPath @returns {Promise<number | undefined>} */
export function bridgePid(socketPath) {
  return new Promise((resolve) => {
    const req = request({ socketPath, path: "/v1/health", timeout: 1000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const pid = JSON.parse(body).pid;
          resolve(res.statusCode === 200 && typeof pid === "number" ? pid : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(undefined));
    req.end();
  });
}

/** @param {string} path */
function readText(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

/** Where `path` links to: undefined when nothing is there, null when it is not a symlink. @param {string} path */
function linkTarget(path) {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch {
    return undefined;
  }
}

/**
 * A symlink the installer may replace: this user's, and either pointing nowhere or at another
 * ki-deck (an older install). Other users' links in a shared folder stay as they are.
 * @param {string} link
 */
function replaceableLink(link) {
  try {
    const st = lstatSync(link);
    if (!st.isSymbolicLink() || st.uid !== process.getuid?.()) return false;
    return !existsSync(link) || basename(readlinkSync(link)) === "ki-deck";
  } catch {
    return false;
  }
}

/** Both paths name the same file (after symlinks), or the same path when one does not exist. @param {string} a @param {string} b */
function samePath(a, b) {
  const real = (/** @type {string} */ p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(a) === real(b);
}

/** @param {string} dir */
function isWritableDir(dir) {
  try {
    if (!statSync(dir).isDirectory()) return false;
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The most recently written .vsix in `dir`. @param {string} dir */
function newestVsix(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".vsix"))
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch {
    return undefined;
  }
}

/** Local time as YYYYMMDD-HHMMSS. @param {Date} d */
function stamp(d) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Runs the installer. Resolves to the exit code; never rejects.
 * @param {string[]} argv
 * @param {Deps} deps
 * @returns {Promise<number>}
 */
export async function install(argv, deps) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      deps.out(USAGE);
      return 0;
    }
    await new Installer(options, deps).run();
    return 0;
  } catch (error) {
    if (error instanceof Fail && error.usage) deps.err(USAGE);
    deps.err(`install: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

class Installer {
  /** @param {Options} options @param {Deps} deps */
  constructor(options, deps) {
    this.o = options;
    this.d = deps;
    this.p = deps.platform;
    this.base = deps.env.KI_DECK_HOME || join(deps.home, ".ki-deck");
    this.hookDir = join(deps.home, ".kiro", "hooks");
    this.hookFile = join(this.hookDir, "ki-deck.json");
    this.pluginDir = join(deps.root, `${PLUGIN_UUID}.sdPlugin`);
    this.extDir = join(deps.root, "extension");
    // A packaged plugin's setup/ folder (scripts/package.mjs): Stream Deck already installed the
    // plugin and the companion comes prebuilt, so there is nothing to build.
    this.packaged = existsSync(join(deps.root, "PACKAGED"));
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pidOf = deps.bridgePid ?? bridgePid;
  }

  /** @param {string} text */
  say(text) {
    this.d.out(text);
  }

  /** @param {string} text */
  step(text) {
    this.d.out(`\n==> ${text}`);
  }

  /** @param {string} text */
  warn(text) {
    this.d.out(`  warn: ${text}`);
  }

  /** @param {string} question */
  async confirm(question) {
    if (this.o.yes) return true;
    if (!this.d.interactive) throw new Fail("not a terminal: re-run with --yes to accept the plan");
    const answer = (await this.d.ask(`${question} [y/N] `)).trim();
    return answer === "y" || answer === "Y" || answer === "yes";
  }

  /** Runs a build command in the repository, streaming its output; stops the install when it fails. @param {string} cmd @param {string[]} args */
  async inRepo(cmd, args) {
    const line = [cmd, ...args].join(" ");
    if (this.o.dry) {
      this.say(`  would run in ${this.d.root}: ${line}`);
      return;
    }
    const result = await this.d.run(cmd, args, { cwd: this.d.root, inherit: true });
    if (!result.ok) throw new Fail(`'${line}' failed`);
  }

  /** @param {string} dir */
  privateDir(dir) {
    if (this.o.dry) {
      if (!existsSync(dir)) this.say(`  would create: ${dir} (private)`);
      return;
    }
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
  }

  /** Copies `src` to `dest` with `mode`. Skips identical files and backs up changed ones. @param {string} src @param {string} dest @param {number} mode */
  installFile(src, dest, mode) {
    const content = readFileSync(src);
    const exists = existsSync(dest);
    if (exists && readFileSync(dest).equals(content)) {
      this.say(`  up to date: ${dest}`);
      return;
    }
    if (this.o.dry) {
      this.say(exists ? `  would back up and replace: ${dest}` : `  would install: ${dest}`);
      return;
    }
    if (exists) {
      const backup = join(this.base, "backups", `${basename(dest)}.${stamp(this.now())}`);
      copyFileSync(dest, backup);
      const old = statSync(dest);
      chmodSync(backup, old.mode & 0o7777);
      utimesSync(backup, old.atime, old.mtime);
      this.say(`  backed up previous version to ${backup}`);
    }
    // Write next to the target, then rename: a hook running right now keeps reading the old file.
    const tmp = `${dest}.tmp-${process.pid}`;
    writeFileSync(tmp, content, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, dest);
    this.say(`  installed: ${dest}`);
  }

  async run() {
    const { d, o, p } = this;

    this.step("Checking prerequisites");
    this.say(`  ${p.checkSystem()}`);
    // kd-hook needs curl, the ki-deck command shasum.
    for (const tool of ["curl", "shasum"]) {
      if (!which(tool, d.env.PATH)) throw new Fail(`'${tool}' not found`);
    }
    const sd = p.appVersion("Elgato Stream Deck");
    if (!sd) this.warn(`Stream Deck app not found. Install it from https://www.elgato.com/downloads (${STREAM_DECK_MIN} or later).`);
    else if (versionAtLeast(sd, STREAM_DECK_MIN)) this.say(`  Stream Deck ${sd}`);
    else this.warn(`Stream Deck ${sd} is too old for the plugin (${STREAM_DECK_MIN} or later required).`);
    const kiroVersion = p.appVersion("Kiro");
    if (kiroVersion) this.say(`  Kiro IDE ${kiroVersion}`);
    else this.warn("Kiro IDE not found in /Applications or ~/Applications.");
    const kiroCli = which("kiro-cli", d.env.PATH);
    if (kiroCli) {
      const version = await d.run(kiroCli, ["--version"], { timeoutMs: 10_000 });
      this.say(`  ${version.stdout.trim().split("\n")[0] || "kiro-cli"}`);
    } else {
      this.warn("kiro-cli not found (optional).");
    }

    const pluginReady = !this.packaged && !o.skipPlugin && existsSync(join(d.root, "package.json")) && existsSync(this.pluginDir);
    if (pluginReady) {
      const major = Number.parseInt(d.nodeVersion, 10);
      if (!(major >= 24)) throw new Fail(`Node.js v${d.nodeVersion} is too old to build the plugin (24 or later, or use --skip-plugin)`);
      if (!which("npm", d.env.PATH)) throw new Fail("npm not found: it comes with Node.js and builds the plugin (or use --skip-plugin)");
    }

    // The companion is built with the plugin (or ships prebuilt in a package) and installed with
    // Kiro's `kiro` command, or the launcher inside Kiro.app when the command is not installed.
    const kiro = which("kiro", d.env.PATH) ?? p.bundledKiro();
    const companionReady = kiro !== undefined && ((pluginReady && existsSync(this.extDir)) || (this.packaged && newestVsix(this.extDir) !== undefined));

    this.step("Plan");
    this.say(`  ${this.base}/bin/kd-hook and ${this.base}/bin/ki-deck`);
    this.say(`  ${this.base}/config.json (only if it does not exist yet)`);
    if (o.gate) this.say(`  gated categories: ${o.gate.join(" ") || "none"}`);
    else this.say("  gated categories: unchanged (none on a fresh install, so Kiro prompts exactly as before)");
    this.say(`  ${this.hookFile}`);
    this.say("    global Kiro hooks: every new Kiro IDE and CLI session on this Mac reports to Stream Deck");
    if (this.packaged) {
      this.say("  Stream Deck plugin: installed from the package (Stream Deck manages it)");
    } else if (pluginReady) {
      this.say(`  build and link the Stream Deck plugin ${PLUGIN_UUID}`);
      this.say("    Stream Deck restarts once if that is the only way to load a new plugin build");
    } else {
      this.say("  Stream Deck plugin: skipped (not built yet, or --skip-plugin)");
    }
    if (companionReady) {
      this.say(`  install the Kiro companion extension ${COMPANION_ID}`);
      this.say("    lets the deck answer Kiro's own IDE approval prompts; reload Kiro windows afterwards");
    } else if ((pluginReady || this.packaged) && kiro === undefined) {
      this.say("  Kiro companion extension: skipped (Kiro IDE not found: no 'kiro' command and no Kiro.app)");
    }
    if (o.dry) this.say("  (dry run: nothing will change)");
    if (!(await this.confirm("Continue?"))) {
      this.say("Nothing changed.");
      return;
    }

    this.step("Installing scripts");
    for (const sub of ["", "bin", "run", "data", "logs", "backups"]) this.privateDir(sub ? join(this.base, sub) : this.base);
    this.installFile(join(d.root, "hooks", "kd-hook"), join(this.base, "bin", "kd-hook"), 0o755);
    this.installFile(join(d.root, "bin", "ki-deck"), join(this.base, "bin", "ki-deck"), 0o755);

    this.step("Configuration");
    this.configure();

    this.step("Kiro hooks");
    if (o.dry) {
      if (!existsSync(this.hookDir)) this.say(`  would create: ${this.hookDir}`);
    } else {
      mkdirSync(this.hookDir, { recursive: true });
    }
    this.installFile(join(d.root, "hooks", "ki-deck.json"), this.hookFile, 0o644);
    for (const other of this.otherHookFiles()) this.say(`  note: ${other} also hooks into Kiro; both run side by side`);

    this.step("Command line");
    await this.linkCommand();

    this.step("Stream Deck plugin");
    if (this.packaged) {
      this.say("  installed from the package; nothing to build");
    } else if (pluginReady) {
      // @elgato/cli is a pinned devDependency; --no stops npm from fetching anything unpinned.
      await this.inRepo("npm", ["ci"]);
      await this.inRepo("npm", ["run", "build"]);
      if (o.dev) await this.inRepo("npm", ["exec", "--no", "--", "streamdeck", "dev"]);
      if (linkTarget(join(p.pluginsDir, `${PLUGIN_UUID}.sdPlugin`))) this.say("  plugin already linked");
      else await this.inRepo("npm", ["exec", "--no", "--", "streamdeck", "link", this.pluginDir]);
      if (o.dry) this.say("  would start the plugin (restarting Stream Deck if needed)");
      else await this.loadPlugin();
      this.say("  its actions appear under 'ki-deck' in the Stream Deck app");
    } else {
      this.say("  skipped");
    }

    this.step("Kiro companion extension");
    if (companionReady && kiro !== undefined) {
      await this.installCompanion(kiro);
    } else if (kiro === undefined) {
      this.say("  skipped (Kiro IDE not found: no 'kiro' command and no Kiro.app)");
    } else {
      this.say("  skipped (it is built with the plugin; --skip-plugin leaves both out)");
    }

    // Which version of the Kiro side is installed. A packaged plugin offers an update only when it
    // is newer than this (src/bridge/setup.ts), so it never replaces a newer install from the repo.
    const version = this.packaged ? readText(join(d.root, "PACKAGED")) : this.repoVersion();
    if (version && !o.dry) {
      const file = join(this.base, "VERSION");
      writeFileSync(file, `${version}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
    }

    this.step("Optional extras");
    if (which("terminal-notifier", d.env.PATH)) {
      this.say("  terminal-notifier found: notifications will be clickable");
    } else if (!o.yes && !o.dry && which("brew", d.env.PATH)) {
      if (await this.confirm("  Install terminal-notifier with Homebrew so notifications focus the right window when clicked?")) {
        await d.run("brew", ["install", "terminal-notifier"], { inherit: true });
      }
    } else {
      this.say("  for clickable notifications: brew install terminal-notifier");
    }

    this.step("Checking the result");
    if (o.dry) this.say("  (skipped in a dry run)");
    else await d.run(join(this.base, "bin", "ki-deck"), ["doctor"], { inherit: true, timeoutMs: 60_000 });

    this.say(NEXT_STEPS);
  }

  configure() {
    const config = join(this.base, "config.json");
    if (existsSync(config)) {
      this.say(`  keeping existing ${config}`);
    } else if (this.o.dry) {
      this.say(`  would create ${config}`);
    } else {
      writeFileSync(config, readFileSync(join(this.d.root, "config", "config.default.json")), { mode: 0o600 });
      chmodSync(config, 0o600);
      this.say(`  created ${config}`);
    }
    const gated = join(this.base, "gated");
    if (this.o.gate || !existsSync(gated)) {
      const list = this.o.gate ?? [];
      if (this.o.dry) {
        this.say(`  would write gated categories: ${list.join(" ") || "none"}`);
      } else {
        writeFileSync(gated, list.map((c) => `${c}\n`).join(""), { mode: 0o600 });
        chmodSync(gated, 0o600);
        this.say(`  gated categories: ${list.join(" ") || "none"}`);
      }
    } else {
      const kept = readText(gated).split(/\s+/).filter(Boolean).join(" ");
      this.say(`  keeping gated categories: ${kept || "none"}`);
    }
  }

  /** Other global Kiro hook files, which run next to ours. */
  otherHookFiles() {
    try {
      return readdirSync(this.hookDir).filter((f) => f.endsWith(".json") && f !== basename(this.hookFile));
    } catch {
      return [];
    }
  }

  /**
   * Links the command into the first of ~/.local/bin, ~/bin and the platform's shared folders
   * that is on the user's PATH and writable. Run from a terminal, that is this process's PATH; run
   * by the plugin (no terminal), the PATH a new terminal gets, since Stream Deck's own PATH says
   * nothing about the user's shell. Prints the PATH line for the shell profile when no folder
   * fits, or when that PATH could not be read (so the plugin's notification names the full path).
   */
  async linkCommand() {
    const target = join(this.base, "bin", "ki-deck");
    const probed = this.d.interactive ? this.d.env.PATH : await this.p.loginShellPath();
    const userPath = probed ?? this.d.env.PATH ?? "";
    const onPath = new Set(userPath.split(delimiter).filter(Boolean));
    let linked = "";
    for (const dir of [join(this.d.home, ".local", "bin"), join(this.d.home, "bin"), ...this.p.sharedBinDirs]) {
      if (!onPath.has(dir) || !isWritableDir(dir)) continue;
      const link = join(dir, "ki-deck");
      const current = linkTarget(link);
      if (current !== undefined && current !== target && !replaceableLink(link)) {
        this.say(`  ${link} exists and is not ours; left alone`);
        continue;
      }
      if (current !== target) {
        if (this.o.dry) {
          this.say(`  would run: ln -sf ${target} ${link}`);
        } else {
          if (current !== undefined) unlinkSync(link);
          symlinkSync(target, link);
        }
      }
      linked = link;
      break;
    }
    if (linked) {
      this.say(`  ki-deck is on your PATH via ${dirname(linked)}`);
      const first = which("ki-deck", userPath);
      if (first && !samePath(first, linked)) this.warn(`${first} comes first on your PATH, so the shell runs that one`);
      if (probed !== undefined) return;
    }
    const bin = join(this.base, "bin");
    const entry = bin.startsWith(`${this.d.home}/`) ? `$HOME/${relative(this.d.home, bin)}` : bin;
    this.say(linked ? `  if a new terminal does not find it, add this to ${this.p.shellProfile}:` : `  add this to ${this.p.shellProfile} to use the ki-deck command:`);
    this.say(`    ${PATH_HINT_PREFIX}${entry}:$PATH"`);
  }

  /**
   * Starts the freshly built plugin. `streamdeck restart` only works in Stream Deck's developer
   * mode, and a newly linked plugin is only picked up when Stream Deck starts, so fall back to
   * restarting the app.
   */
  async loadPlugin() {
    const { p } = this;
    if (!p.streamDeckRunning()) {
      this.say("  Stream Deck is not running: open it to load the plugin");
      return;
    }
    const sock = join(this.base, "run", "bridge.sock");
    const before = await this.pidOf(sock);
    await this.d.run("npm", ["exec", "--no", "--", "streamdeck", "restart", PLUGIN_UUID], { cwd: this.d.root, timeoutMs: 60_000 });
    let pid = await this.waitNewBridge(sock, 5, before);
    if (pid !== undefined) {
      this.say(`  plugin running (bridge PID ${pid})`);
      return;
    }
    if (!(await this.confirm("  Stream Deck has to restart to load the new plugin; its keys go blank for a few seconds. Restart it now?"))) {
      this.say("  quit and reopen Stream Deck to load the plugin");
      return;
    }
    await p.quitStreamDeck();
    for (let i = 0; i < 15 && p.streamDeckRunning(); i++) await this.sleep(1000);
    await p.openStreamDeck();
    pid = await this.waitNewBridge(sock, 30, before);
    if (pid !== undefined) this.say(`  Stream Deck restarted; plugin running (bridge PID ${pid})`);
    else this.warn(`the plugin did not start. See ${p.streamDeckLog}`);
  }

  /** Waits up to `seconds` for a bridge whose PID differs from `before`. @param {string} sock @param {number} seconds @param {number | undefined} before */
  async waitNewBridge(sock, seconds, before) {
    for (let i = 0; i < seconds; i++) {
      const pid = await this.pidOf(sock);
      if (pid !== undefined && pid !== before) return pid;
      await this.sleep(1000);
    }
    return undefined;
  }

  /** @param {string} kiro */
  async installCompanion(kiro) {
    const { d } = this;
    if (this.o.dry) {
      this.say(`  would ${this.packaged ? "install the companion" : "build the companion and install it"}: kiro --install-extension <vsix> --force`);
      this.say("  would ask you to reload open Kiro windows to activate it");
    } else {
      if (!this.packaged) {
        const built = await d.run("npm", ["run", "companion"], { cwd: d.root, timeoutMs: 120_000 });
        if (!built.ok) this.warn("building the companion failed");
      }
      const vsix = newestVsix(this.extDir);
      if (!vsix) {
        this.warn("no companion .vsix was produced; skipping");
      } else if ((await d.run(kiro, ["--install-extension", vsix, "--force"], { timeoutMs: 120_000 })).ok) {
        this.say(`  installed ${basename(vsix)}`);
        this.say("  reload any open Kiro window (Command Palette -> Developer: Reload Window) to activate it");
      } else {
        this.warn(`could not install the companion; install it by hand: kiro --install-extension "${vsix}" --force`);
      }
    }
    this.say("  it lets the deck answer Kiro's own approval prompts in IDE windows (Mirror mode)");
  }

  repoVersion() {
    try {
      const version = JSON.parse(readFileSync(join(this.d.root, "package.json"), "utf8")).version;
      return typeof version === "string" ? version : "";
    } catch {
      return "";
    }
  }
}
