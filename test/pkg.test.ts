// The macOS installer package's scripts (scripts/pkg/install/), its uninstaller app, and
// `ki-deck uninstall` for a package install, against a temporary home, with fake
// pgrep, osascript, pkill, open, sleep and pkgutil, so the real Stream Deck is never touched.

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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

interface FixtureOptions {
  streamDeckRunning?: boolean;
  /** No permission to send Apple events: the quit request leaves Stream Deck running. */
  quitRefused?: boolean;
  /** The installer package's receipt is in ~/Library/Receipts. */
  receipt?: boolean;
}

/** A home with Stream Deck's plugin folder, and fakes that log what the scripts asked for. */
function fixture({ streamDeckRunning = false, quitRefused = false, receipt = false }: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "sdk-pkg-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const plugin = join(home, "Library", "Application Support", "com.elgato.StreamDeck", "Plugins", "net.streiner.ki-deck.sdPlugin");
  const fakebin = join(root, "fakebin");
  const log = join(root, "calls.log");
  const running = join(root, "running");
  const receiptFile = join(root, "receipt");
  if (streamDeckRunning) writeFileSync(running, "");
  if (receipt) writeFileSync(receiptFile, "");
  // pgrep succeeds while the state file exists; a quit through osascript or pkill removes it.
  write(join(fakebin, "pgrep"), `#!/bin/sh\necho "pgrep $*" >> "${log}"\n[ -e "${running}" ]\n`, 0o755);
  write(join(fakebin, "osascript"), `#!/bin/sh\necho "osascript $*" >> "${log}"\n${quitRefused ? "" : `rm -f "${running}"`}\n`, 0o755);
  write(join(fakebin, "pkill"), `#!/bin/sh\necho "pkill $*" >> "${log}"\nrm -f "${running}"\n`, 0o755);
  write(join(fakebin, "open"), `#!/bin/sh\necho "open $*" >> "${log}"\n`, 0o755);
  write(join(fakebin, "sleep"), "#!/bin/sh\nexit 0\n", 0o755);
  write(
    join(fakebin, "pkgutil"),
    `#!/bin/sh\necho "pkgutil $*" >> "${log}"\ncase "$*" in *--forget*) rm -f "${receiptFile}" ;; esac\n[ -e "${receiptFile}" ] || case "$*" in *--forget*) exit 0 ;; *) exit 1 ;; esac\n`,
    0o755,
  );
  const env = { PATH: `${fakebin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home };
  /** Runs an Installer script the way Installer does: package path, home folder, "/". */
  const script = (path: string, scriptEnv: NodeJS.ProcessEnv = env) =>
    spawnSync("/bin/sh", [path, "/path/to/ki-deck.pkg", home, "/"], { env: scriptEnv, encoding: "utf8" });
  const cli = (...args: string[]) => spawnSync("/bin/sh", [join(REPO, "bin", "ki-deck"), ...args], { env, encoding: "utf8" });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  /** A Kiro side as the setup leaves it, and the plugin folder the installer copied. */
  const installed = () => {
    const base = join(home, ".ki-deck");
    write(join(base, "bin", "kd-hook"), "#!/bin/sh\n", 0o755);
    write(join(base, "bin", "ki-deck"), "#!/bin/sh\n", 0o755);
    write(join(base, "config.json"), "{}\n", 0o600);
    write(join(home, ".kiro", "hooks", "ki-deck.json"), "{}\n");
    write(join(plugin, "setup", "PACKAGED"), "0.11.0\n");
    write(join(plugin, "bin", "plugin.js"), "// plugin\n");
    return base;
  };
  const profiles = join(home, "Library", "Application Support", "com.elgato.StreamDeck", "ProfilesV3");
  return { root, home, plugin, profiles, env, script, cli, calls, installed, receiptFile };
}

const INSTALL = join(REPO, "scripts", "pkg", "install");

describe("installer package scripts", () => {
  it("refuses to write through a plugin linked from a repository, and changes nothing", () => {
    const f = fixture({ streamDeckRunning: true });
    const checkout = join(f.home, "checkout", "net.streiner.ki-deck.sdPlugin");
    mkdirSync(checkout, { recursive: true });
    mkdirSync(dirname(f.plugin), { recursive: true });
    symlinkSync(checkout, f.plugin);
    const result = f.script(join(INSTALL, "preinstall"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("links to a repository checkout");
    expect(existsSync(checkout)).toBe(true);
    expect(f.calls()).not.toContain("osascript"); // Stream Deck keeps running
  });

  it("quits Stream Deck and removes the old plugin before the new one is copied", () => {
    const f = fixture({ streamDeckRunning: true });
    write(join(f.plugin, "bin", "old-file.js"), "old\n");
    const result = f.script(join(INSTALL, "preinstall"));
    expect(result.status).toBe(0);
    expect(f.calls()).toContain('osascript -e tell application id "com.elgato.StreamDeck" to quit');
    expect(f.calls()).not.toContain("pkill");
    expect(existsSync(f.plugin)).toBe(false);
  });

  it("terminates Stream Deck when it does not quit on request", () => {
    const f = fixture({ streamDeckRunning: true, quitRefused: true });
    expect(f.script(join(INSTALL, "preinstall")).status).toBe(0);
    expect(f.calls()).toContain("pkill -TERM -f Elgato Stream Deck.app/Contents/MacOS");
  });

  it("leaves Stream Deck alone when it is not running", () => {
    const f = fixture();
    expect(f.script(join(INSTALL, "preinstall")).status).toBe(0);
    expect(f.calls()).not.toContain("osascript");
  });

  it("leaves the one-time consent for the plugin's version and starts Stream Deck", () => {
    const f = fixture();
    write(join(f.plugin, "setup", "PACKAGED"), "0.11.0\n");
    expect(f.script(join(INSTALL, "postinstall")).status).toBe(0);
    expect(readFileSync(join(f.plugin, "setup", ".consented"), "utf8")).toBe("0.11.0\n");
    expect(f.calls()).toContain("open -b com.elgato.StreamDeck");
  });

  it("starts Stream Deck without Installer's temporary environment", () => {
    const f = fixture();
    // Logs what `open` would hand to Stream Deck.
    write(join(f.root, "fakebin", "open"), `#!/bin/sh\necho "open $* TMPDIR=\${TMPDIR-none} SCRIPT_NAME=\${SCRIPT_NAME-none}" >> "${join(f.root, "calls.log")}"\n`, 0o755);
    const installerEnv = { ...f.env, TMPDIR: "/private/tmp/PKInstallSandbox.test/tmp", SCRIPT_NAME: "postinstall", PACKAGE_PATH: "/path/to/ki-deck.pkg" };
    expect(f.script(join(INSTALL, "postinstall"), installerEnv).status).toBe(0);
    expect(f.calls()).toContain("open -b com.elgato.StreamDeck TMPDIR=none SCRIPT_NAME=none");
  });

  it("updates Kiro profiles from an earlier version while Stream Deck is still quit, before starting it", () => {
    const f = fixture();
    write(join(f.plugin, "setup", "PACKAGED"), "0.11.0\n");
    write(join(f.plugin, "setup", "bin", "ki-deck"), `#!/bin/sh\necho "ki-deck $* HOME=$HOME" >> "${join(f.root, "calls.log")}"\n`, 0o755);
    write(join(f.profiles, "AAAA.sdProfile", "manifest.json"), JSON.stringify({ InstalledByPluginUUID: "net.streiner.ki-deck", Name: "Kiro" }));
    expect(f.script(join(INSTALL, "postinstall")).status).toBe(0);
    const calls = f.calls();
    expect(calls).toContain(`ki-deck profiles --replace --offline --yes HOME=${f.home}`);
    expect(calls.indexOf("ki-deck profiles")).toBeLessThan(calls.indexOf("open -b"));
  });

  it("leaves the profiles to the plugin when no Kiro profile is installed yet", () => {
    const f = fixture();
    write(join(f.plugin, "setup", "PACKAGED"), "0.11.0\n");
    write(join(f.plugin, "setup", "bin", "ki-deck"), `#!/bin/sh\necho "ki-deck $*" >> "${join(f.root, "calls.log")}"\n`, 0o755);
    write(join(f.profiles, "BBBB.sdProfile", "manifest.json"), JSON.stringify({ Name: "Default Profile" }));
    expect(f.script(join(INSTALL, "postinstall")).status).toBe(0);
    expect(f.calls()).not.toContain("ki-deck profiles");
  });
});

describe.runIf(process.platform === "darwin")("ki-deck profiles --replace --offline", () => {
  /** An installed Kiro profile with one old page, and the plugin's bundled layout with a new one. */
  function profiles(streamDeckRunning: boolean) {
    const f = fixture({ streamDeckRunning });
    rmSync(join(f.root, "fakebin", "osascript")); // the real one: the command edits JSON with JavaScript for Automation
    const installed = join(f.profiles, "AAAA.sdProfile");
    write(
      join(installed, "manifest.json"),
      JSON.stringify({ Device: { Model: "20GAI9901", UUID: "device-1" }, InstalledByPluginUUID: "net.streiner.ki-deck", Name: "Kiro", Pages: { Current: "old-page", Default: "old-page", Pages: ["old-page"] }, PreconfiguredName: "profiles/kiro-mini", Version: "3.0" }),
    );
    write(join(installed, "Profiles", "OLD-PAGE", "manifest.json"), JSON.stringify({ Controllers: [{ Actions: { "0,0": { ActionID: "a" } } }] }));
    const layout = join(f.root, "layout", "NEW.sdProfile");
    write(join(layout, "manifest.json"), JSON.stringify({ Device: { Model: "", UUID: "" }, Name: "Kiro Mini", Pages: { Current: "new-page", Default: "new-page", Pages: ["new-page"] }, Version: "3.0" }));
    write(join(layout, "Profiles", "NEW-PAGE", "manifest.json"), JSON.stringify({ Controllers: [{ Actions: { "0,0": { ActionID: "a" }, "1,0": { ActionID: "b" } } }] }));
    mkdirSync(join(f.plugin, "profiles"), { recursive: true });
    spawnSync("/usr/bin/zip", ["-qr", join(f.plugin, "profiles", "kiro-mini.streamDeckProfile"), "NEW.sdProfile"], { cwd: dirname(layout) });
    return { ...f, installed };
  }

  it("swaps in the bundled pages, keeps the device and name, and backs up the old profile", () => {
    const f = profiles(false);
    const result = f.cli("profiles", "--replace", "--offline", "--yes");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(existsSync(join(f.installed, "Profiles", "NEW-PAGE"))).toBe(true);
    expect(existsSync(join(f.installed, "Profiles", "OLD-PAGE"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(f.installed, "manifest.json"), "utf8"));
    expect(manifest.Pages.Current).toBe("new-page");
    expect(manifest.Device.UUID).toBe("device-1");
    expect(manifest.Name).toBe("Kiro");
    const backups = join(f.home, ".ki-deck", "backups");
    const [backup] = readdirSync(backups);
    expect(existsSync(join(backups, backup!, "AAAA.sdProfile", "Profiles", "OLD-PAGE"))).toBe(true);
    expect(f.calls()).not.toContain("open -b"); // offline: no restart, no deep link
  });

  it("refuses while Stream Deck runs, and changes nothing", () => {
    const f = profiles(true);
    const result = f.cli("profiles", "--replace", "--offline", "--yes");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Stream Deck is running; nothing changed");
    expect(existsSync(join(f.installed, "Profiles", "OLD-PAGE"))).toBe(true);
  });
});

describe("uninstall after the installer package", () => {
  it("removes the plugin the package put there, forgets the receipt and starts Stream Deck again", () => {
    const f = fixture({ streamDeckRunning: true, receipt: true });
    const base = f.installed();
    const result = f.cli("uninstall", "--yes");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("the Stream Deck plugin from the installer package");
    expect(result.stdout).toContain("Removed the Stream Deck plugin.");
    expect(existsSync(f.plugin)).toBe(false);
    expect(existsSync(join(f.home, ".kiro", "hooks", "ki-deck.json"))).toBe(false);
    expect(existsSync(join(base, "bin"))).toBe(false);
    expect(existsSync(join(base, "config.json"))).toBe(true);
    expect(f.calls()).toContain('osascript -e tell application id "com.elgato.StreamDeck" to quit');
    expect(f.calls()).toContain("open -b com.elgato.StreamDeck");
    expect(f.calls()).toContain(`pkgutil --volume ${f.home} --forget net.streiner.ki-deck`);
    expect(existsSync(f.receiptFile)).toBe(false);
  });

  it("does not start Stream Deck when it was not running", () => {
    const f = fixture({ receipt: true });
    f.installed();
    expect(f.cli("uninstall", "--yes").status).toBe(0);
    expect(existsSync(f.plugin)).toBe(false);
    expect(f.calls()).not.toContain("open -b");
  });

  it("leaves a plugin from a .streamDeckPlugin to Stream Deck, and stops it offering the setup at start", () => {
    const f = fixture({ streamDeckRunning: true });
    f.installed();
    const result = f.cli("uninstall", "--yes");
    expect(result.status).toBe(0);
    expect(existsSync(join(f.plugin, "bin", "plugin.js"))).toBe(true);
    expect(readFileSync(join(f.plugin, "setup", ".declined"), "utf8")).toBe("0.11.0\n");
    expect(result.stdout).toContain("remove it in Stream Deck");
    expect(f.calls()).not.toContain("osascript");
  });

  /** The uninstaller app as scripts/pkg/build.mjs builds it: only its Info.plist matters here. */
  function uninstallerApp(home: string, id: string) {
    const app = join(home, "Applications", "Uninstall ki-deck.app");
    write(
      join(app, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>\n`,
    );
    write(join(app, "Contents", "Resources", "ki-deck"), "#!/bin/sh\n", 0o755);
    return app;
  }

  it("removes the uninstaller app last, and only the package's own", () => {
    const f = fixture({ receipt: true });
    f.installed();
    const app = uninstallerApp(f.home, "net.streiner.ki-deck.uninstaller");
    const result = f.cli("uninstall", "--yes");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Removed ${app}.`);
    expect(existsSync(app)).toBe(false);

    const g = fixture();
    g.installed();
    const other = uninstallerApp(g.home, "com.someone.else");
    g.cli("uninstall", "--yes");
    expect(existsSync(other)).toBe(true);
  });

  it("runs from a copy of the command, as the uninstaller app does, even while that copy goes away", () => {
    const f = fixture({ receipt: true });
    f.installed();
    const app = uninstallerApp(f.home, "net.streiner.ki-deck.uninstaller");
    const command = join(app, "Contents", "Resources", "ki-deck");
    copyFileSync(join(REPO, "bin", "ki-deck"), command);
    // `do shell script` runs with this PATH and without KI_DECK_HOME.
    const result = spawnSync("/bin/sh", [command, "uninstall", "--yes"], { env: { ...f.env, PATH: `${join(f.root, "fakebin")}:/usr/bin:/bin:/usr/sbin:/sbin` }, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Uninstalled.");
    expect(existsSync(join(f.home, ".kiro", "hooks", "ki-deck.json"))).toBe(false);
    expect(existsSync(f.plugin)).toBe(false);
    expect(existsSync(f.receiptFile)).toBe(false);
    expect(existsSync(app)).toBe(false);
  });
});

describe.runIf(process.platform === "darwin")("uninstaller app", () => {
  it("compiles", () => {
    const out = mkdtempSync(join(tmpdir(), "sdk-applet-"));
    roots.push(out);
    const result = spawnSync("/usr/bin/osacompile", ["-o", join(out, "Uninstall.app"), join(INSTALL, "uninstaller.applescript")], { encoding: "utf8" });
    expect(result.stderr).not.toMatch(/error/i); // it always notes ".: replacing existing signature"
    expect(result.status).toBe(0);
  });
});
