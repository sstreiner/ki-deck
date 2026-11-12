#!/usr/bin/env node
// Builds the macOS installer package dist/ki-deck-<version>.pkg. Run by `make pkg`.
//
// It wraps the plugin package (dist/net.streiner.ki-deck.streamDeckPlugin, from
// `npm run package`), so both downloads carry exactly the same plugin, and installs "for me only":
//   ~/Library/Application Support/com.elgato.StreamDeck/Plugins/net.streiner.ki-deck.sdPlugin/
//   ~/Applications/Uninstall ki-deck.app   (scripts/pkg/install/uninstaller.applescript,
//                                                       with a copy of bin/ki-deck inside)
// preinstall quits Stream Deck and removes the old copies, postinstall leaves a one-time consent,
// updates older Kiro profiles and starts Stream Deck again, and the plugin then sets up the Kiro
// side without asking (src/bridge/setup.ts).
//
//   node scripts/pkg/build.mjs            build. SIGN_ID ("Developer ID Installer: ...") signs the
//                                         package, SIGN_APP_ID ("Developer ID Application: ...") the
//                                         uninstaller app; both identities in the keychain
//   node scripts/pkg/build.mjs notarize   send the signed package to Apple (notarytool keychain
//                                         profile in NOTARY_PROFILE), wait, staple and check it

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HERE = join(REPO, "scripts", "pkg", "install");
const DIST = join(REPO, "dist");
const STAGE = join(REPO, "build", "pkg");
const PLUGIN_UUID = "net.streiner.ki-deck";
// bin/ki-deck (uninstall) and scripts/pkg/install/preinstall know both names too.
const UNINSTALLER_APP = "Uninstall ki-deck.app";
const UNINSTALLER_ID = `${PLUGIN_UUID}.uninstaller`;

const version = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
const plugin = join(DIST, `${PLUGIN_UUID}.streamDeckPlugin`);
const output = join(DIST, `ki-deck-${version}.pkg`);
const signId = process.env.SIGN_ID ?? "";
const appSignId = process.env.SIGN_APP_ID ?? "";
const notaryProfile = process.env.NOTARY_PROFILE ?? "";

const fail = (message) => {
  console.error(`pkg: ${message}`);
  process.exit(1);
};
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
const capture = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const plist = (file, key, type, value) => run("/usr/bin/plutil", ["-replace", key, `-${type}`, value, file]);

/** The plugin package unpacked where Stream Deck looks for plugins. */
function stagePlugin(root) {
  if (!existsSync(plugin)) fail(`missing ${relative(REPO, plugin)}: run make plugin (npm run package) first`);
  const plugins = join(root, "Library", "Application Support", "com.elgato.StreamDeck", "Plugins");
  mkdirSync(plugins, { recursive: true });
  // ditto keeps the modes the plugin package stored (kd-hook and the command are executable).
  run("/usr/bin/ditto", ["-x", "-k", plugin, plugins]);
  const packaged = readFileSync(join(plugins, `${PLUGIN_UUID}.sdPlugin`, "setup", "PACKAGED"), "utf8").trim();
  if (packaged !== version) fail(`${relative(REPO, plugin)} is ${packaged}, package.json says ${version}: run make plugin again`);
}

/** The uninstaller app in ~/Applications: an AppleScript applet with the command inside. */
function stageUninstaller(root) {
  const app = join(root, "Applications", UNINSTALLER_APP);
  mkdirSync(dirname(app), { recursive: true });
  run("/usr/bin/osacompile", ["-o", app, join(HERE, "uninstaller.applescript")]);
  const info = join(app, "Contents", "Info.plist");
  plist(info, "CFBundleIdentifier", "string", UNINSTALLER_ID);
  plist(info, "CFBundleShortVersionString", "string", version);
  plist(info, "CFBundleVersion", "string", version);
  plist(info, "NSAppleEventsUsageDescription", "string", "ki-deck asks Stream Deck to quit while it removes the Kiro plugin.");
  const command = join(app, "Contents", "Resources", "ki-deck");
  copyFileSync(join(REPO, "bin", "ki-deck"), command);
  chmodSync(command, 0o755);
  // Adding files broke osacompile's ad-hoc signature, and Apple silicon will not start an app
  // with a broken one: sign it again, for notarization with the hardened runtime.
  const sign = appSignId
    ? ["--force", "--options", "runtime", "--timestamp", "--entitlements", join(HERE, "uninstaller.entitlements"), "--sign", appSignId]
    : ["--force", "--sign", "-"];
  run("/usr/bin/codesign", [...sign, app]);
  run("/usr/bin/codesign", ["--verify", "--strict", app]);
  if (signId && !appSignId) console.warn("pkg: SIGN_APP_ID is not set, so the uninstaller app is only signed ad hoc and notarization will reject the package");
}

/**
 * pkgbuild marks every app bundle as relocatable: Installer would then update a copy with the
 * same bundle identifier wherever it finds one, instead of ~/Applications. Keep it in place.
 */
function componentPlist(root, stage) {
  const file = join(stage, "component.plist");
  run("/usr/bin/pkgbuild", ["--analyze", "--root", root, "--quiet", file]);
  const bundles = JSON.parse(capture("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]));
  if (!bundles.some((b) => b.RootRelativeBundlePath?.endsWith(UNINSTALLER_APP))) fail(`pkgbuild did not find ${UNINSTALLER_APP} as a bundle`);
  for (const bundle of bundles) bundle.BundleIsRelocatable = false;
  writeFileSync(file, JSON.stringify(bundles));
  run("/usr/bin/plutil", ["-convert", "xml1", file]);
  return file;
}

function build() {
  if (process.platform !== "darwin") fail("macOS only: pkgbuild, productbuild and osacompile come with macOS");
  rmSync(STAGE, { recursive: true, force: true });
  const root = join(STAGE, "root");
  mkdirSync(root, { recursive: true });
  stagePlugin(root);
  stageUninstaller(root);

  const scripts = join(STAGE, "scripts");
  mkdirSync(scripts);
  for (const name of ["preinstall", "postinstall"]) {
    copyFileSync(join(HERE, name), join(scripts, name));
    chmodSync(join(scripts, name), 0o755);
  }
  const component = join(STAGE, "plugin.pkg");
  run("/usr/bin/pkgbuild", ["--root", root, "--component-plist", componentPlist(root, STAGE), "--identifier", PLUGIN_UUID, "--version", version, "--install-location", "/", "--scripts", scripts, "--quiet", component]);

  const distribution = join(STAGE, "distribution.xml");
  writeFileSync(distribution, readFileSync(join(HERE, "distribution.xml"), "utf8").replaceAll("@VERSION@", version));
  const sign = signId ? ["--sign", signId, "--timestamp"] : [];
  mkdirSync(DIST, { recursive: true });
  run("/usr/bin/productbuild", ["--distribution", distribution, "--resources", join(HERE, "resources"), "--package-path", STAGE, ...sign, "--quiet", output]);
  if (signId) run("/usr/sbin/pkgutil", ["--check-signature", output]);
  const kb = (statSync(output).size / 1024).toFixed(0);
  console.log(`${relative(REPO, output)}  (${version}, ${kb} KB, ${signId ? `signed by ${signId}` : "unsigned: set SIGN_ID to sign"})`);
}

function notarize() {
  if (!existsSync(output)) fail(`missing ${relative(REPO, output)}: run make pkg first`);
  if (!notaryProfile) fail("set NOTARY_PROFILE to a notarytool keychain profile (xcrun notarytool store-credentials <name> ...)");
  try {
    capture("/usr/sbin/pkgutil", ["--check-signature", output]);
  } catch {
    fail(`${relative(REPO, output)} is not signed: build it with SIGN_ID (and SIGN_APP_ID) set`);
  }
  // --wait blocks until Apple has an answer (usually a few minutes); a rejection exits non-zero.
  const result = JSON.parse(capture("/usr/bin/xcrun", ["notarytool", "submit", output, "--keychain-profile", notaryProfile, "--wait", "--output-format", "json"]));
  console.log(`notarytool: ${relative(REPO, output)} ${result.status} (${result.id})`);
  if (result.status !== "Accepted") {
    run("/usr/bin/xcrun", ["notarytool", "log", result.id, "--keychain-profile", notaryProfile]);
    fail("notarization was not accepted; the log above says why");
  }
  run("/usr/bin/xcrun", ["stapler", "staple", output]);
  // What Gatekeeper will say on a colleague's Mac: "accepted, source=Notarized Developer ID".
  run("/usr/sbin/spctl", ["--assess", "--type", "install", "-vv", output]);
}

const command = process.argv[2] ?? "build";
if (command === "build") build();
else if (command === "notarize") notarize();
else fail(`unknown command '${command}' (build or notarize)`);
