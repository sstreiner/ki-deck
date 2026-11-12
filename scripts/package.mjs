#!/usr/bin/env node
// Builds the release package dist/net.streiner.ki-deck.streamDeckPlugin: the plugin, plus
// everything its one-click setup installs on the Kiro side, in the plugin's setup/ folder
// (src/bridge/setup.ts). Double-clicking the file installs it in Stream Deck; the plugin then
// offers the setup. Run by `npm run package`, after `npm run build` and `npm run companion`.
//
// The repo's own plugin folder stays untouched: the package is staged in a temporary copy, so a
// plugin linked from the repo never gets a setup/ folder and never asks.

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = "net.streiner.ki-deck.sdPlugin";
const DIST = join(REPO, "dist");

const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const ext = JSON.parse(readFileSync(join(REPO, "extension", "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(REPO, PLUGIN, "manifest.json"), "utf8"));
const vsix = join(REPO, "extension", `${ext.name}-${ext.version}.vsix`);

const fail = (message) => {
  console.error(`package: ${message}`);
  process.exit(1);
};
if (!manifest.Version.startsWith(`${pkg.version}.`)) fail(`manifest Version ${manifest.Version} does not match package.json ${pkg.version}`);
for (const built of [join(REPO, PLUGIN, "bin", "plugin.js"), join(REPO, PLUGIN, "imgs"), vsix]) {
  if (!existsSync(built)) fail(`missing ${relative(REPO, built)}: run npm run build and npm run companion first`);
}

// What the packaged installer (scripts/install.mjs, run from setup/ with Stream Deck's Node)
// expects, relative to setup/. Same layout as the repository.
const SETUP_FILES = [
  ["scripts/install.mjs", 0o644],
  ["scripts/install/core.mjs", 0o644],
  ["scripts/install/macos.mjs", 0o644],
  ["hooks/kd-hook", 0o755],
  ["hooks/ki-deck.json", 0o644],
  ["bin/ki-deck", 0o755],
  ["config/config.default.json", 0o644],
];

const stage = mkdtempSync(join(tmpdir(), "ki-deck-package-"));
try {
  const plugin = join(stage, PLUGIN);
  // Runtime logs and Finder metadata stay out of the package.
  cpSync(join(REPO, PLUGIN), plugin, {
    recursive: true,
    filter: (src) => {
      const rel = relative(join(REPO, PLUGIN), src);
      return rel !== "logs" && !rel.startsWith(`logs/`) && !src.endsWith(".DS_Store");
    },
  });
  const setup = join(plugin, "setup");
  for (const [file, mode] of SETUP_FILES) {
    const target = join(setup, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(REPO, file), target);
    chmodSync(target, mode);
  }
  mkdirSync(join(setup, "extension"), { recursive: true });
  copyFileSync(vsix, join(setup, "extension", `${ext.name}-${ext.version}.vsix`));
  // Marks the folder as a package for the installer, and names the version the setup dialog shows.
  writeFileSync(join(setup, "PACKAGED"), `${pkg.version}\n`);

  mkdirSync(DIST, { recursive: true });
  const cli = join(REPO, "node_modules", ".bin", "streamdeck");
  execFileSync(cli, ["pack", plugin, "--output", DIST, "--force", "--no-update-check", "--no-file-list"], { stdio: "inherit" });
} finally {
  rmSync(stage, { recursive: true, force: true });
}

const out = join(DIST, `${PLUGIN.replace(/\.sdPlugin$/, "")}.streamDeckPlugin`);
if (!existsSync(out)) fail(`streamdeck pack did not write ${relative(REPO, out)}`);
console.log(`${relative(REPO, out)}  (${pkg.version}, companion ${ext.version}, ${(statSync(out).size / 1024).toFixed(0)} KB)`);
