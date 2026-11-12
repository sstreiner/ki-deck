// The installer (scripts/install/core.mjs) against temporary folders: in-process with a fake
// platform and runner, and once end to end through scripts/install.mjs on macOS.

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { install, PATH_HINT_PREFIX, type Deps, type Platform, type RunOptions } from "../scripts/install/core.mjs";
import { macos } from "../scripts/install/macos.mjs";

const REPO = join(__dirname, "..");
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function write(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
}

const modeOf = (path: string) => statSync(path).mode & 0o777;

interface FixtureOptions {
  /** A package's setup/ folder (default) or a repository checkout. */
  repo?: boolean;
  /** Executables on the PATH besides curl and shasum. */
  tools?: string[];
}

/** A source folder (package or repo), an empty home and a PATH with fake tools. */
function fixture({ repo = false, tools = ["kiro"] }: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "sdk-install-"));
  roots.push(root);
  const src = join(root, "src");
  const home = join(root, "home");
  const fakebin = join(root, "fakebin");
  const base = join(home, ".ki-deck");
  mkdirSync(home);
  write(join(src, "hooks", "kd-hook"), "#!/bin/sh\n# kd-hook v2\n", 0o755);
  write(join(src, "hooks", "ki-deck.json"), '{ "version": "v1", "hooks": [] }\n');
  write(join(src, "bin", "ki-deck"), "#!/bin/sh\necho \"doctor ok\"\n", 0o755);
  write(join(src, "config", "config.default.json"), '{ "default": true }\n');
  if (repo) {
    write(join(src, "package.json"), '{ "name": "ki-deck", "version": "0.11.0" }\n');
    mkdirSync(join(src, "net.streiner.ki-deck.sdPlugin"));
    write(join(src, "extension", "package.json"), "{}\n");
  } else {
    write(join(src, "PACKAGED"), "0.11.0\n");
    write(join(src, "extension", "ki-deck-companion-0.5.0.vsix"), "zip");
  }
  for (const tool of ["curl", "shasum", ...tools]) write(join(fakebin, tool), "#!/bin/sh\nexit 0\n", 0o755);
  const localBin = join(home, ".local", "bin");
  mkdirSync(localBin, { recursive: true });

  const ran: Array<{ cmd: string; args: string[]; options?: RunOptions }> = [];
  const lines: string[] = [];
  const errors: string[] = [];
  const platform: Platform = {
    checkSystem: () => "macOS 26.0",
    appVersion: (name) => (name === "Kiro" ? "1.4.154" : "7.6.1"),
    bundledKiro: () => undefined,
    pluginsDir: join(root, "Plugins"),
    sharedBinDirs: [],
    shellProfile: "~/.zshrc",
    streamDeckLog: "StreamDeck.log",
    loginShellPath: async () => undefined,
    streamDeckRunning: () => false,
    quitStreamDeck: async () => {},
    openStreamDeck: async () => {},
  };
  const deps: Deps = {
    root: src,
    home,
    env: { PATH: `${fakebin}:${localBin}` },
    nodeVersion: "24.11.0",
    interactive: false,
    ask: async () => "n",
    out: (text) => lines.push(text),
    err: (text) => errors.push(text),
    run: async (cmd, args, options) => {
      ran.push({ cmd, args, options });
      return { ok: true, stdout: "", stderr: "" };
    },
    platform,
    now: () => new Date(2026, 10, 12, 9, 30, 5),
    sleep: async () => {},
    bridgePid: async () => undefined,
  };
  const output = () => lines.join("\n");
  return { root, src, home, base, fakebin, localBin, deps, platform, ran, output, errors };
}

describe("install", () => {
  it("installs the Kiro side from a package into an empty home", async () => {
    const f = fixture();
    f.platform.loginShellPath = async () => `/usr/bin:${f.localBin}`;
    expect(await install(["--yes"], f.deps)).toBe(0);

    expect(readFileSync(join(f.base, "bin", "kd-hook"), "utf8")).toContain("kd-hook v2");
    expect(modeOf(join(f.base, "bin", "kd-hook"))).toBe(0o755);
    expect(modeOf(join(f.base, "bin", "ki-deck"))).toBe(0o755);
    for (const dir of ["", "bin", "run", "data", "logs", "backups"]) expect(modeOf(join(f.base, dir))).toBe(0o700);
    expect(readFileSync(join(f.base, "config.json"), "utf8")).toBe('{ "default": true }\n');
    expect(modeOf(join(f.base, "config.json"))).toBe(0o600);
    expect(readFileSync(join(f.base, "gated"), "utf8")).toBe("");
    expect(modeOf(join(f.home, ".kiro", "hooks", "ki-deck.json"))).toBe(0o644);
    expect(readFileSync(join(f.base, "VERSION"), "utf8")).toBe("0.11.0\n");
    expect(readlinkSync(join(f.localBin, "ki-deck"))).toBe(join(f.base, "bin", "ki-deck"));

    const vsix = join(f.src, "extension", "ki-deck-companion-0.5.0.vsix");
    expect(f.ran.map((r) => [r.cmd, ...r.args])).toEqual([
      [join(f.fakebin, "kiro"), "--install-extension", vsix, "--force"],
      [join(f.base, "bin", "ki-deck"), "doctor"],
    ]);
    expect(f.output()).toContain("Stream Deck plugin: installed from the package");
    expect(f.output()).toContain("Next steps");
    expect(f.errors).toEqual([]);
  });

  it("skips unchanged files on a re-run, and backs up a changed one before replacing it", async () => {
    const f = fixture();
    await install(["--yes"], f.deps);
    const again = fixture();
    Object.assign(f.deps, { out: again.deps.out });
    await install(["--yes"], f.deps);
    expect(again.output().match(/up to date:/g)).toHaveLength(3);
    expect(readdirSync(join(f.base, "backups"))).toEqual([]);

    const installed = join(f.base, "bin", "kd-hook");
    writeFileSync(installed, "edited by hand\n");
    await install(["--yes"], f.deps);
    const backup = join(f.base, "backups", "kd-hook.20261112-093005");
    expect(readFileSync(backup, "utf8")).toBe("edited by hand\n");
    expect(readFileSync(installed, "utf8")).toContain("kd-hook v2");
    expect(modeOf(installed)).toBe(0o755);
  });

  it("changes nothing in a dry run", async () => {
    const f = fixture();
    expect(await install(["--dry-run", "--yes"], f.deps)).toBe(0);
    expect(readdirSync(f.home)).toEqual([".local"]);
    expect(readdirSync(f.localBin)).toEqual([]);
    expect(f.ran).toEqual([]);
    expect(f.output()).toContain(`would install: ${join(f.base, "bin", "kd-hook")}`);
    expect(f.output()).toContain("(skipped in a dry run)");
  });

  it("needs --yes without a terminal, and changes nothing when the answer is no", async () => {
    const f = fixture();
    expect(await install([], f.deps)).toBe(1);
    expect(f.errors.join("\n")).toContain("not a terminal: re-run with --yes");
    expect(existsSync(f.base)).toBe(false);

    f.deps.interactive = true;
    expect(await install([], f.deps)).toBe(0);
    expect(f.output()).toContain("Nothing changed.");
    expect(existsSync(f.base)).toBe(false);
  });

  it("writes the gated categories it is given and keeps them on the next run", async () => {
    const f = fixture();
    await install(["--yes", "--gate", "shell, mcp"], f.deps);
    expect(readFileSync(join(f.base, "gated"), "utf8")).toBe("shell\nmcp\n");
    await install(["--yes"], f.deps);
    expect(f.output()).toContain("keeping gated categories: shell mcp");
    expect(readFileSync(join(f.base, "gated"), "utf8")).toBe("shell\nmcp\n");
  });

  it("refuses unknown options and gate categories", async () => {
    const f = fixture();
    expect(await install(["--gate", "bogus"], f.deps)).toBe(1);
    expect(f.errors).toContain("install: unknown gate category 'bogus' (use shell, write, mcp)");
    expect(await install(["--frobnicate"], f.deps)).toBe(1);
    expect(f.errors.join("\n")).toContain("Usage: scripts/install.sh");
    expect(existsSync(f.base)).toBe(false);
  });

  it("keeps an existing config", async () => {
    const f = fixture();
    write(join(f.base, "config.json"), '{ "mine": true }\n', 0o600);
    await install(["--yes"], f.deps);
    expect(readFileSync(join(f.base, "config.json"), "utf8")).toBe('{ "mine": true }\n');
    expect(f.output()).toContain("keeping existing");
  });

  it("installs the companion with Kiro.app's own launcher when the kiro command is missing", async () => {
    const f = fixture({ tools: [] });
    f.platform.bundledKiro = () => "/Applications/Kiro.app/Contents/Resources/app/bin/code";
    await install(["--yes"], f.deps);
    expect(f.ran[0]!.cmd).toBe("/Applications/Kiro.app/Contents/Resources/app/bin/code");
    expect(f.ran[0]!.args[0]).toBe("--install-extension");
  });

  it("skips the companion when Kiro IDE is not installed", async () => {
    const f = fixture({ tools: [] });
    await install(["--yes"], f.deps);
    expect(f.ran.map((r) => r.args[0])).toEqual(["doctor"]);
    expect(f.output()).toContain("skipped (Kiro IDE not found");
  });

  it("links the command where a new terminal looks, not where the plugin's PATH does", async () => {
    const f = fixture();
    const shared = join(f.root, "homebrew-bin");
    mkdirSync(shared);
    f.platform.sharedBinDirs = [shared];
    // The plugin's PATH has ~/.local/bin (toolEnv), the user's shell does not.
    f.platform.loginShellPath = async () => `/usr/bin:${shared}`;
    await install(["--yes"], f.deps);
    expect(existsSync(join(f.localBin, "ki-deck"))).toBe(false);
    expect(readlinkSync(join(shared, "ki-deck"))).toBe(join(f.base, "bin", "ki-deck"));
  });

  it("prints the PATH line when no folder on the user's PATH can take the link", async () => {
    const f = fixture();
    f.platform.loginShellPath = async () => "/usr/bin:/bin";
    await install(["--yes"], f.deps);
    expect(f.output()).toContain("add this to ~/.zshrc to use the ki-deck command:");
    expect(f.output()).toContain('export PATH="$HOME/.ki-deck/bin:$PATH"');
  });

  it("leaves a file of the same name alone", async () => {
    const f = fixture();
    write(join(f.localBin, "ki-deck"), "someone else's\n", 0o755);
    await install(["--yes"], f.deps);
    expect(lstatSync(join(f.localBin, "ki-deck")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(f.localBin, "ki-deck"), "utf8")).toBe("someone else's\n");
    expect(f.output()).toContain("exists and is not ours; left alone");
  });

  it("replaces its own older link, but not a link to something else", async () => {
    const f = fixture();
    const link = join(f.localBin, "ki-deck");
    symlinkSync("/old/checkout/bin/ki-deck", link);
    await install(["--yes"], f.deps);
    expect(readlinkSync(link)).toBe(join(f.base, "bin", "ki-deck"));

    const g = fixture();
    symlinkSync("/usr/bin/true", join(g.localBin, "ki-deck"));
    await install(["--yes"], g.deps);
    expect(readlinkSync(join(g.localBin, "ki-deck"))).toBe("/usr/bin/true");
    expect(g.output()).toContain("exists and is not ours; left alone");
  });

  it("warns when another ki-deck comes first on the PATH", async () => {
    const f = fixture({ tools: ["kiro", "ki-deck"] });
    f.deps.interactive = true;
    f.deps.ask = async () => "y";
    await install(["--yes"], f.deps);
    expect(f.output()).toContain(`warn: ${join(f.fakebin, "ki-deck")} comes first on your PATH`);
  });

  it("also prints the PATH line when the login shell's PATH could not be read", async () => {
    const f = fixture();
    await install(["--yes"], f.deps); // loginShellPath() answers undefined: the plugin's PATH decides
    expect(readlinkSync(join(f.localBin, "ki-deck"))).toBe(join(f.base, "bin", "ki-deck"));
    expect(f.output()).toContain("if a new terminal does not find it, add this to ~/.zshrc:");
    expect(f.output()).toContain(`${PATH_HINT_PREFIX}$HOME/.ki-deck/bin:$PATH"`);
  });

  it("takes gate lists separated by commas or spaces", async () => {
    const f = fixture();
    await install(["--yes", "--gate", "shell write"], f.deps);
    expect(readFileSync(join(f.base, "gated"), "utf8")).toBe("shell\nwrite\n");
  });

  it("builds and links the plugin from the repository", async () => {
    const f = fixture({ repo: true, tools: ["kiro", "npm"] });
    write(join(f.src, "extension", "ki-deck-companion-0.6.0.vsix"), "zip");
    expect(await install(["--yes"], f.deps)).toBe(0);
    const commands = f.ran.map((r) => [r.cmd, ...r.args].join(" "));
    expect(commands.slice(0, 4)).toEqual([
      "npm ci",
      "npm run build",
      `npm exec --no -- streamdeck link ${join(f.src, "net.streiner.ki-deck.sdPlugin")}`,
      "npm run companion",
    ]);
    expect(f.ran[0]!.options).toMatchObject({ cwd: f.src, inherit: true });
    expect(f.output()).toContain("Stream Deck is not running: open it to load the plugin");
    expect(readFileSync(join(f.base, "VERSION"), "utf8")).toBe("0.11.0\n");
  });

  it("restarts Stream Deck when streamdeck restart does not load the new build", async () => {
    const f = fixture({ repo: true, tools: ["kiro", "npm"] });
    let running = true;
    let pid = 100;
    f.platform.streamDeckRunning = () => running;
    f.platform.quitStreamDeck = async () => {
      running = false;
    };
    f.platform.openStreamDeck = async () => {
      running = true;
      pid = 200;
    };
    f.deps.bridgePid = async () => (running ? pid : undefined);
    await install(["--yes"], f.deps);
    expect(f.ran.map((r) => r.args.join(" "))).toContain("exec --no -- streamdeck restart net.streiner.ki-deck");
    expect(f.output()).toContain("Stream Deck restarted; plugin running (bridge PID 200)");
  });

  it("needs Node 24 to build the plugin, but not for --skip-plugin", async () => {
    const f = fixture({ repo: true, tools: ["kiro", "npm"] });
    f.deps.nodeVersion = "22.12.0";
    expect(await install(["--yes"], f.deps)).toBe(1);
    expect(f.errors.join("\n")).toContain("Node.js v22.12.0 is too old to build the plugin");
    expect(await install(["--yes", "--skip-plugin"], f.deps)).toBe(0);
    expect(f.ran.some((r) => r.cmd === "npm")).toBe(false);
    expect(f.output()).toContain("skipped (it is built with the plugin; --skip-plugin leaves both out)");
  });
});

describe.runIf(process.platform === "darwin")("macOS login shell PATH", () => {
  /** A fake $SHELL: runs the probe's command with /bin/sh, then `after`. */
  function shell(after: string): string {
    const root = mkdtempSync(join(tmpdir(), "sdk-shell-"));
    roots.push(root);
    const path = join(root, "zsh");
    write(path, `#!/bin/sh\nshift\n${after}\n`, 0o755);
    return path;
  }

  it("answers as soon as the shell prints, even if its profile leaves a job holding the pipe", async () => {
    const platform = macos("/nonexistent", { SHELL: shell('/bin/sh -c "$1"\nexec sleep 2') });
    const started = Date.now();
    expect(await platform.loginShellPath()).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("gives up on a shell that never answers and ignores SIGTERM", async () => {
    const platform = macos("/nonexistent", { SHELL: shell("trap '' TERM\nsleep 30") }, { probeTimeoutMs: 300 });
    const started = Date.now();
    expect(await platform.loginShellPath()).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("ki-deck uninstall", () => {
  it("removes the command's links and keeps the config", async () => {
    const f = fixture();
    await install(["--yes"], f.deps);
    const homeBin = join(f.home, "bin");
    mkdirSync(homeBin);
    symlinkSync(join(f.base, "bin", "ki-deck"), join(homeBin, "ki-deck"));
    const result = spawnSync("/bin/sh", [join(REPO, "bin", "ki-deck"), "uninstall", "--yes"], {
      env: { HOME: f.home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(existsSync(join(f.localBin, "ki-deck"))).toBe(false);
    expect(existsSync(join(homeBin, "ki-deck"))).toBe(false);
    expect(existsSync(join(f.home, ".kiro", "hooks", "ki-deck.json"))).toBe(false);
    expect(existsSync(join(f.base, "config.json"))).toBe(true);
  });
});

describe.runIf(process.platform === "darwin")("install.mjs end to end", () => {
  it("runs from a package's setup folder with a bare environment, as the plugin starts it", () => {
    const f = fixture({ tools: ["kiro"] });
    for (const file of ["install.mjs", "install/core.mjs", "install/macos.mjs"]) {
      mkdirSync(dirname(join(f.src, "scripts", file)), { recursive: true });
      copyFileSync(join(REPO, "scripts", file), join(f.src, "scripts", file));
    }
    // Real curl and shasum from /usr/bin and a fake kiro. The login shell answers with the system
    // PATH only, so the test never links into a real folder such as /usr/local/bin.
    rmSync(join(f.fakebin, "curl"));
    rmSync(join(f.fakebin, "shasum"));
    write(join(f.fakebin, "zsh"), '#!/bin/sh\nshift\nexec /bin/sh -c "$1"\n', 0o755);
    const result = spawnSync(process.execPath, [join(f.src, "scripts", "install.mjs"), "--yes"], {
      env: { HOME: f.home, PATH: `${f.fakebin}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: join(f.fakebin, "zsh") },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(existsSync(join(f.base, "bin", "kd-hook"))).toBe(true);
    expect(readFileSync(join(f.base, "VERSION"), "utf8")).toBe("0.11.0\n");
    // The doctor's output (a child process) follows the installer's own lines.
    expect(result.stdout.indexOf("doctor ok")).toBeGreaterThan(result.stdout.indexOf("==> Checking the result"));
    expect(result.stdout).toContain("add this to ~/.zshrc"); // no PATH folder in this home
  });
});
