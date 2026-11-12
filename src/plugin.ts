import streamDeck from "@elgato/streamdeck";
import { AllowKey, DecideInKiroKey, DenyKey } from "./actions/decision";
import { AutonomyKey, EffortKey, ModelKey, PromptKey, StopKey } from "./actions/deck-keys";
import { GateKey } from "./actions/gate";
import { InboxKey } from "./actions/inbox";
import { LockdownKey } from "./actions/lockdown";
import { RequestKey } from "./actions/request";
import { SessionTile } from "./actions/session-tile";
import { UsageKey } from "./actions/usage";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Bridge } from "./bridge";
import { Setup } from "./bridge/setup";
import { toolEnv } from "./bridge/system";
import { installedCount, profileFor, switchWhenInstalled } from "./profiles";

/** The plugin's version; `make version` (scripts/version.mjs) sets it with package.json. */
const VERSION = "0.12.0";

const log = streamDeck.logger.createScope("bridge");
const logger = {
  debug: (m: string) => log.debug(m),
  info: (m: string) => log.info(m),
  warn: (m: string) => log.warn(m),
  error: (m: string) => log.error(m),
};
const bridge = new Bridge({ version: VERSION, logger });

// A packaged plugin (dist/*.streamDeckPlugin) carries the Kiro side in its setup/ folder and
// offers to install it; one linked from the repo has none and never asks (src/bridge/setup.ts).
const setup = new Setup({
  pluginDir: dirname(dirname(fileURLToPath(import.meta.url))), // <uuid>.sdPlugin/bin/plugin.js
  base: bridge.paths.base,
  home: homedir(),
  log: logger,
  env: toolEnv(),
});

streamDeck.actions.registerAction(new SessionTile(bridge));
streamDeck.actions.registerAction(new InboxKey(bridge, setup));
streamDeck.actions.registerAction(new AllowKey(bridge));
streamDeck.actions.registerAction(new DenyKey(bridge));
streamDeck.actions.registerAction(new DecideInKiroKey(bridge));
streamDeck.actions.registerAction(new LockdownKey(bridge));
streamDeck.actions.registerAction(new UsageKey(bridge));
streamDeck.actions.registerAction(new GateKey(bridge));
streamDeck.actions.registerAction(new RequestKey(bridge));
streamDeck.actions.registerAction(new ModelKey(bridge));
streamDeck.actions.registerAction(new EffortKey(bridge));
streamDeck.actions.registerAction(new AutonomyKey(bridge));
streamDeck.actions.registerAction(new StopKey(bridge));
streamDeck.actions.registerAction(new PromptKey(bridge));
streamDeck.system.onApplicationDidTerminate((ev) => bridge.applicationTerminated(ev.application));

// `ki-deck profiles` opens streamdeck://plugins/message/net.streiner.ki-deck/profiles:
// switch every connected device to its Kiro profile. Stream Deck asks before installing one.
// Right after Stream Deck starts, devices connect a few seconds late (the phone when its app
// opens), so the request stays open for two minutes and also covers devices that connect then.
const PROFILE_REQUEST_MS = 120_000;
let profileRequestUntil = 0;
const switchedDevices = new Set<string>();
const PROFILES_DIR = join(homedir(), "Library", "Application Support", "com.elgato.StreamDeck", "ProfilesV3");
const PLUGIN_UUID = "net.streiner.ki-deck";

function switchToKiroProfile(device: { id: string; name: string; type: number; size: { columns: number; rows: number } }): boolean {
  const profile = profileFor(device);
  if (!profile || switchedDevices.has(device.id)) return false;
  switchedDevices.add(device.id);
  log.info(`switching ${device.name} (type ${device.type}) to ${profile}`);
  const switchNow = () => streamDeck.profiles.switchToProfile(device.id, profile).catch((err: unknown) => log.warn(`switch failed: ${String(err)}`));
  const count = () => installedCount(PROFILES_DIR, PLUGIN_UUID, profile);
  // Not installed yet: Stream Deck asks, installs it and stays on the current profile, so switch
  // again once it is there (while the user answers its question, for as long as the request).
  if (count() === 0) {
    switchWhenInstalled(
      count,
      () => {
        log.info(`${profile} installed for ${device.name}; switching to it`);
        void switchNow();
      },
      { intervalMs: 2000, timeoutMs: PROFILE_REQUEST_MS },
    );
  }
  void switchNow();
  return true;
}

/** Switches every connected device, and those connecting in the next two minutes, to its Kiro profile. */
function requestKiroProfiles(reason: string): void {
  profileRequestUntil = Date.now() + PROFILE_REQUEST_MS;
  switchedDevices.clear();
  let any = false;
  for (const device of streamDeck.devices) if (device.isConnected) any = switchToKiroProfile(device) || any;
  if (!any) log.info(`profiles (${reason}): no device connected yet; each one switches when it connects (next 2 minutes)`);
}

streamDeck.system.onDidReceiveDeepLink((ev) => {
  if (ev.url.path === "/profiles") requestKiroProfiles("ki-deck profiles");
});

// The installer package copies the plugin into place, so Stream Deck's own "install the bundled
// profiles?" step never runs. After the package's setup, offer them the way `profiles` does.
setup.on("packageInstalled", () => requestKiroProfiles("installer package"));

streamDeck.devices.onDeviceDidConnect((ev) => {
  if (Date.now() < profileRequestUntil) switchToKiroProfile(ev.device);
});

bridge.start().catch((err: unknown) => {
  streamDeck.logger.error(`bridge did not start: ${err instanceof Error ? err.message : String(err)}`);
});

// Kiro shows its own prompt for anything still waiting when Stream Deck stops the plugin.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void bridge.stop().finally(() => process.exit(0)));
}

streamDeck
  .connect()
  .then(() => {
    bridge.streamDeckConnected = true;
    void setup.offer().catch((err: unknown) => log.warn(`setup: ${String(err)}`)); // packaged, Kiro side missing or older: ask once
  })
  .catch((err: unknown) => streamDeck.logger.error(`could not connect to Stream Deck: ${String(err)}`));
