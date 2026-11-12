// One-click setup of a packaged plugin (src/bridge/setup.ts), against temporary folders.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "../src/bridge/logger";
import { Setup, type LongRunner } from "../src/bridge/setup";
import { PATH_HINT_PREFIX } from "../scripts/install/core.mjs";

/** Stands in for Stream Deck's bundled Node, which runs the plugin and so the installer. */
const NODE = "/streamdeck/NodeJS/24/node";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

/** A packaged plugin folder and an empty home, plus a runner that records what it ran. */
function fixture(answer = "Set up", installerOutput = "installed\n") {
  const root = mkdtempSync(join(tmpdir(), "sdk-setup-"));
  roots.push(root);
  const pluginDir = join(root, "net.streiner.ki-deck.sdPlugin");
  const home = join(root, "home");
  const base = join(home, ".ki-deck");
  const setupDir = join(pluginDir, "setup");
  write(join(setupDir, "scripts", "install.mjs"), "// installer\n");
  write(join(setupDir, "hooks", "kd-hook"), "kd-hook v2\n");
  write(join(setupDir, "hooks", "ki-deck.json"), "{}\n");
  write(join(setupDir, "bin", "ki-deck"), "cli v2\n");
  write(join(setupDir, "extension", "ki-deck-companion-0.4.0.vsix"), "zip");
  write(join(setupDir, "PACKAGED"), "0.9.0\n");
  const ran: Array<{ cmd: string; args: string[] }> = [];
  const exec: LongRunner = async (cmd, args) => {
    ran.push({ cmd, args });
    if (cmd === "/usr/bin/osascript" && args[1]!.includes("display dialog")) return { ok: answer !== "Not now", stdout: `${answer}\n`, stderr: "" };
    if (cmd === NODE) {
      // What the real installer does, in short.
      write(join(base, "bin", "kd-hook"), "kd-hook v2\n");
      write(join(base, "bin", "ki-deck"), "cli v2\n");
      write(join(home, ".kiro", "hooks", "ki-deck.json"), "{}\n");
      return { ok: true, stdout: installerOutput, stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };
  const setup = new Setup({ pluginDir, base, home, log: silentLogger, env: {}, node: NODE, exec, now: () => new Date(2026, 10, 11, 9, 30) });
  return { setup, ran, pluginDir, home, base };
}

describe("Setup", () => {
  it("never asks for a plugin linked from the repo", async () => {
    const { setup, ran, pluginDir } = fixture();
    rmSync(join(pluginDir, "setup"), { recursive: true });
    expect(setup.packaged).toBe(false);
    expect(setup.need()).toBe("none");
    await setup.offer();
    expect(ran).toHaveLength(0);
  });

  it("asks, runs the packaged installer on Set up, logs it and notifies", async () => {
    const { setup, ran, pluginDir, base } = fixture();
    expect(setup.need()).toBe("install");
    await setup.offer();
    expect(ran.map((r) => r.cmd)).toEqual(["/usr/bin/osascript", NODE, "/usr/bin/osascript"]);
    expect(ran[0]!.args).toContain("Set up");
    expect(ran[1]!.args).toEqual([join(pluginDir, "setup", "scripts", "install.mjs"), "--yes"]);
    expect(ran[2]!.args).toContain("Kiro is set up for Stream Deck");
    expect(ran[2]!.args.at(-1)).toContain("Check with: ki-deck doctor");
    expect(readFileSync(join(base, "logs", "setup-20261111-083000.log"), "utf8")).toContain("installed");
    expect(setup.need()).toBe("none");
  });

  it("names the full path in the notification when the command is not on the PATH", async () => {
    const { setup, ran } = fixture("Set up", `installed\n    ${PATH_HINT_PREFIX}$HOME/.ki-deck/bin:$PATH"\n`);
    await setup.offer();
    expect(ran[2]!.args.at(-1)).toContain("Check with: ~/.ki-deck/bin/ki-deck doctor");
  });

  it("remembers Not now for this package at start, but the Inbox key still asks", async () => {
    const { setup, ran } = fixture("Not now");
    await setup.offer();
    await setup.offer();
    expect(ran).toHaveLength(1); // one dialog, nothing installed
    await setup.offer(true);
    expect(ran).toHaveLength(2);
  });

  /** A Kiro side already installed, stamped with `version` (or unstamped, as 0.8 and older). */
  function installed(f: ReturnType<typeof fixture>, version?: string, kdHook = "kd-hook v2\n") {
    write(join(f.base, "bin", "kd-hook"), kdHook);
    write(join(f.base, "bin", "ki-deck"), "cli v2\n");
    write(join(f.home, ".kiro", "hooks", "ki-deck.json"), "{}\n");
    if (version) write(join(f.base, "VERSION"), `${version}\n`);
  }

  it("offers an update only when the package is newer than what the installer stamped", () => {
    const older = fixture();
    installed(older, "0.8.0", "kd-hook v1\n");
    expect(older.setup.need()).toBe("update");

    const same = fixture();
    installed(same, "0.9.0");
    expect(same.setup.need()).toBe("none");

    // Installed from a newer repo checkout, or a hook file edited by hand: never "updated" back.
    const newer = fixture();
    installed(newer, "1.0.0", "kd-hook v3, edited\n");
    expect(newer.setup.need()).toBe("none");
  });

  it("falls back to comparing files for installs from before the version stamp", () => {
    const unchanged = fixture();
    installed(unchanged);
    expect(unchanged.setup.need()).toBe("none");
    const differs = fixture();
    installed(differs, undefined, "kd-hook v1\n");
    expect(differs.setup.need()).toBe("update");
  });

  it("asks again after Not now once a newer package arrives", async () => {
    const f = fixture("Not now");
    await f.setup.offer();
    expect(readFileSync(join(f.pluginDir, "setup", ".declined"), "utf8").trim()).toBe("0.9.0");
    writeFileSync(join(f.pluginDir, "setup", "PACKAGED"), "0.9.1\n");
    await f.setup.offer();
    expect(f.ran.filter((r) => r.cmd === "/usr/bin/osascript")).toHaveLength(2);
  });

  it("installs once without asking after the installer package, then forgets the consent", async () => {
    const f = fixture();
    writeFileSync(join(f.pluginDir, "setup", ".consented"), "0.9.0\n");
    await f.setup.offer();
    expect(f.ran.map((r) => r.cmd)).toEqual([NODE, "/usr/bin/osascript"]); // the installer, then the notification
    expect(existsSync(join(f.pluginDir, "setup", ".consented"))).toBe(false);
  });

  it("announces a package install of a missing Kiro side, so the plugin can offer its profiles", async () => {
    const fresh = fixture();
    let announced = 0;
    fresh.setup.on("packageInstalled", () => announced++);
    writeFileSync(join(fresh.pluginDir, "setup", ".consented"), "0.9.0\n");
    await fresh.setup.offer();
    expect(announced).toBe(1);

    // An update keeps the profiles the package's postinstall already updated.
    const update = fixture();
    installed(update, "0.8.0", "kd-hook v1\n");
    update.setup.on("packageInstalled", () => announced++);
    writeFileSync(join(update.pluginDir, "setup", ".consented"), "0.9.0\n");
    await update.setup.offer();
    expect(announced).toBe(1);

    // After the dialog, Stream Deck's own plugin install already offered the profiles.
    const dialog = fixture();
    dialog.setup.on("packageInstalled", () => announced++);
    await dialog.setup.offer();
    expect(announced).toBe(1);
  });

  it("asks as usual when the consent is for another version, and drops it", async () => {
    const f = fixture("Not now");
    writeFileSync(join(f.pluginDir, "setup", ".consented"), "0.8.0\n");
    await f.setup.offer();
    expect(f.ran.map((r) => r.cmd)).toEqual(["/usr/bin/osascript"]); // the dialog only
    expect(existsSync(join(f.pluginDir, "setup", ".consented"))).toBe(false);
  });

  it("drops the consent when the Kiro side is already current", async () => {
    const f = fixture();
    installed(f, "0.9.0");
    writeFileSync(join(f.pluginDir, "setup", ".consented"), "0.9.0\n");
    await f.setup.offer();
    expect(f.ran).toHaveLength(0);
    expect(existsSync(join(f.pluginDir, "setup", ".consented"))).toBe(false);
  });

  it("gives the dialog no default button, so Return cannot start the installer", async () => {
    const f = fixture("later");
    await f.setup.offer();
    expect(f.ran[0]!.args[1]).not.toContain("default button");
    expect(f.ran[0]!.args[1]).toContain('cancel button 1');
  });
});
