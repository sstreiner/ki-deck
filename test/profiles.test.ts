import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_PROFILES, installedCount, profileFor, switchWhenInstalled } from "../src/profiles";

const manifest = JSON.parse(readFileSync(new URL("../net.streiner.ki-deck.sdPlugin/manifest.json", import.meta.url), "utf8"));

describe("bundled profiles", () => {
  it("match the manifest's Profiles list", () => {
    const declared = manifest.Profiles.map((p: { Name: string }) => p.Name);
    expect([...BUNDLED_PROFILES].sort()).toEqual([...declared].sort());
  });

  it("pick a profile with the device's own type", () => {
    const types = Object.fromEntries(manifest.Profiles.map((p: { Name: string; DeviceType: number }) => [p.Name, p.DeviceType]));
    for (const type of [0, 1, 2, 3, 5, 7, 9, 13]) {
      const profile = profileFor({ type, size: { columns: 5, rows: 3 } });
      expect(profile && types[profile]).toBe(type);
    }
  });

  it("use the 6-key Mobile profile on the free tier, and none for unknown devices", () => {
    expect(profileFor({ type: 3, size: { columns: 3, rows: 2 } })).toBe("profiles/kiro-mobile-6");
    expect(profileFor({ type: 3, size: { columns: 5, rows: 3 } })).toBe("profiles/kiro-mobile");
    expect(profileFor({ type: 11, size: { columns: 8, rows: 4 } })).toBeUndefined();
  });
});

describe("installed bundled profiles", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  function profilesDir() {
    const dir = mkdtempSync(join(tmpdir(), "sdk-profiles-"));
    roots.push(dir);
    return dir;
  }
  function add(dir: string, id: string, manifestJson: Record<string, unknown>) {
    mkdirSync(join(dir, `${id}.sdProfile`), { recursive: true });
    writeFileSync(join(dir, `${id}.sdProfile`, "manifest.json"), JSON.stringify(manifestJson));
  }

  it("counts only profiles the plugin installed from that bundled profile", () => {
    const dir = profilesDir();
    add(dir, "A", { InstalledByPluginUUID: "net.streiner.ki-deck", PreconfiguredName: "profiles/kiro-mini", Name: "Kiro (Mini)" });
    add(dir, "B", { InstalledByPluginUUID: "net.streiner.ki-deck", PreconfiguredName: "profiles/kiro-mobile" });
    add(dir, "C", { Name: "Default Profile" });
    add(dir, "D", { InstalledByPluginUUID: "com.other.plugin", PreconfiguredName: "profiles/kiro-mini" });
    mkdirSync(join(dir, "E.sdProfile")); // no manifest
    expect(installedCount(dir, "net.streiner.ki-deck", "profiles/kiro-mini")).toBe(1);
    expect(installedCount(dir, "net.streiner.ki-deck", "profiles/kiro-xl")).toBe(0);
    expect(installedCount(join(dir, "missing"), "net.streiner.ki-deck", "profiles/kiro-mini")).toBe(0);
  });

  it("switches again once Stream Deck has installed the profile, and only once", () => {
    vi.useFakeTimers();
    let installed = 0;
    const switchAgain = vi.fn();
    switchWhenInstalled(() => installed, switchAgain, { intervalMs: 2000, timeoutMs: 120_000 });
    vi.advanceTimersByTime(10_000); // the user is still reading Stream Deck's question
    expect(switchAgain).not.toHaveBeenCalled();
    installed = 1; // "Install"
    vi.advanceTimersByTime(2000);
    expect(switchAgain).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(switchAgain).toHaveBeenCalledTimes(1);
  });

  it("gives up when the profile never arrives (the question was declined)", () => {
    vi.useFakeTimers();
    let installed = 0;
    const switchAgain = vi.fn();
    switchWhenInstalled(() => installed, switchAgain, { intervalMs: 2000, timeoutMs: 120_000 });
    vi.advanceTimersByTime(122_000);
    installed = 1; // installed by hand much later: not ours to act on
    vi.advanceTimersByTime(10_000);
    expect(switchAgain).not.toHaveBeenCalled();
  });
});
