// The plugin's version is written in four places (scripts/version.mjs sets them all); they must agree.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(__dirname, "..");
const json = (file: string) => JSON.parse(readFileSync(join(REPO, file), "utf8"));

describe("version", () => {
  it("is the same in package.json, package-lock.json, the manifest and src/plugin.ts", () => {
    const version = json("package.json").version as string;
    const lock = json("package-lock.json");
    expect(lock.version).toBe(version);
    expect(lock.packages[""].version).toBe(version);
    expect(json("net.streiner.ki-deck.sdPlugin/manifest.json").Version).toBe(`${version}.0`);
    expect(readFileSync(join(REPO, "src", "plugin.ts"), "utf8")).toContain(`const VERSION = "${version}";`);
  });
});
