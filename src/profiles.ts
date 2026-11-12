// Which bundled profile fits which device. Names are the manifest's Profiles[].Name values
// (written by scripts/build-profiles.mjs); a test keeps the two in sync.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DeviceShape {
  type: number;
  size: { columns: number; rows: number };
}

const BY_DEVICE_TYPE: Readonly<Record<number, string>> = {
  0: "profiles/kiro-stream-deck",
  1: "profiles/kiro-mini",
  2: "profiles/kiro-xl",
  3: "profiles/kiro-mobile",
  5: "profiles/kiro-pedal",
  7: "profiles/kiro-plus",
  9: "profiles/kiro-neo",
  13: "profiles/kiro-plus-xl",
};

/** The bundled profile for a device, or undefined when there is none (for example Virtual Stream Deck). */
export function profileFor(device: DeviceShape): string | undefined {
  // Stream Deck Mobile on the free tier has 6 keys.
  if (device.type === 3 && device.size.columns * device.size.rows <= 6) return "profiles/kiro-mobile-6";
  return BY_DEVICE_TYPE[device.type];
}

export const BUNDLED_PROFILES: readonly string[] = [...Object.values(BY_DEVICE_TYPE), "profiles/kiro-mobile-6"];

/**
 * How many profiles Stream Deck installed from the plugin's bundled profile `name`: the
 * `<id>.sdProfile/manifest.json` files in its ProfilesV3 folder that name the plugin
 * (`InstalledByPluginUUID`) and the bundled profile (`PreconfiguredName`). Read-only.
 */
export function installedCount(profilesDir: string, pluginUuid: string, name: string): number {
  let dirs: string[];
  try {
    dirs = readdirSync(profilesDir).filter((d) => d.endsWith(".sdProfile"));
  } catch {
    return 0;
  }
  let count = 0;
  for (const dir of dirs) {
    try {
      const manifest = JSON.parse(readFileSync(join(profilesDir, dir, "manifest.json"), "utf8")) as { InstalledByPluginUUID?: unknown; PreconfiguredName?: unknown };
      if (manifest.InstalledByPluginUUID === pluginUuid && manifest.PreconfiguredName === name) count++;
    } catch {
      // not a readable profile
    }
  }
  return count;
}

/**
 * On a switch request for a bundled profile that is not installed yet, Stream Deck asks, installs
 * it, and then stays where it is: the manifest says `DontAutoSwitchWhenInstalled`, so that
 * installing the plugin never takes over a device, and Stream Deck applies that here too (seen
 * 2026-11-12: "installed" in its log, the device still on its old profile). This calls
 * `switchAgain` once a new copy shows up, checking every `intervalMs` for at most `timeoutMs`.
 * Returns a function that stops the watch.
 */
export function switchWhenInstalled(count: () => number, switchAgain: () => void, { intervalMs, timeoutMs }: { intervalMs: number; timeoutMs: number }): () => void {
  const before = count();
  const started = Date.now();
  const timer = setInterval(() => {
    if (count() > before) {
      clearInterval(timer);
      switchAgain();
    } else if (Date.now() - started >= timeoutMs) {
      clearInterval(timer);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
