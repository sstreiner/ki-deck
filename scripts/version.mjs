#!/usr/bin/env node
// Sets the plugin's version everywhere it is written: package.json, package-lock.json, the
// Stream Deck manifest (four parts there: 0.11.0 -> "0.11.0.0") and the VERSION constant in
// src/plugin.ts (what the bridge reports on /v1/health). Run by `make version V=0.11.0`;
// test/version.test.ts fails when they disagree.
// The companion extension keeps its own version (extension/package.json): bump it only when
// src/companion/ changes, since open Kiro windows offer a reload for every new companion.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const version = process.argv[2] ?? "";
if (!SEMVER.test(version)) {
  console.error(`version: give a version like 0.11.0 (got '${version}'): make version V=0.11.0`);
  process.exit(1);
}

/** Rewrites a JSON file with the same layout npm and the manifest use: two spaces, final newline. */
function update(file, change) {
  const path = join(REPO, file);
  const data = JSON.parse(readFileSync(path, "utf8"));
  change(data);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

const before = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
update("package.json", (p) => (p.version = version));
update("package-lock.json", (lock) => {
  lock.version = version;
  lock.packages[""].version = version;
});
update("net.streiner.ki-deck.sdPlugin/manifest.json", (m) => (m.Version = `${version}.0`));

const pluginTs = join(REPO, "src", "plugin.ts");
const source = readFileSync(pluginTs, "utf8");
const CONSTANT = /^const VERSION = "[^"]*";$/m;
if (!CONSTANT.test(source)) {
  console.error('version: src/plugin.ts has no line `const VERSION = "...";` to update');
  process.exit(1);
}
writeFileSync(pluginTs, source.replace(CONSTANT, `const VERSION = "${version}";`));
console.log(`version: ${before} -> ${version} (package.json, package-lock.json, manifest ${version}.0, src/plugin.ts)`);
