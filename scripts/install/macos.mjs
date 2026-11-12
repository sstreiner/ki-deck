// @ts-check
// macOS specifics of the installer (core.mjs): app versions, Stream Deck's folders and restart,
// and the PATH a new terminal gets.

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { versionAtLeast } from "./core.mjs";

const STREAM_DECK_BUNDLE = "com.elgato.StreamDeck";
/** What launchd gives a new app; the user's shell profile adds the rest. */
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const PATH_MARKER = "__KI_DECK_PATH__";

/** Output of a quick command, "" when it fails. @param {string} cmd @param {string[]} args */
function quiet(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
  } catch {
    return "";
  }
}

/**
 * @param {string} home
 * @param {NodeJS.ProcessEnv} env
 * @param {{ probeTimeoutMs?: number }} [options]
 * @returns {import("./core.mjs").Platform}
 */
export function macos(home, env, { probeTimeoutMs = 10_000 } = {}) {
  /** @param {string} name */
  const findApp = (name) => [join("/Applications", `${name}.app`), join(home, "Applications", `${name}.app`)].find((app) => existsSync(app));
  const shell = env.SHELL || "/bin/zsh";

  return {
    checkSystem() {
      const version = quiet("/usr/bin/sw_vers", ["-productVersion"]);
      if (!versionAtLeast(version, "13.0")) throw new Error(`macOS ${version || "(unknown version)"} is too old (13 or later required)`);
      return `macOS ${version}`;
    },

    appVersion(name) {
      const app = findApp(name);
      return app ? quiet("/usr/bin/defaults", ["read", join(app, "Contents", "Info.plist"), "CFBundleShortVersionString"]) : "";
    },

    // Kiro's "Install 'kiro' command in PATH" only links this script; it works from where it is.
    bundledKiro() {
      const app = findApp("Kiro");
      const launcher = app && join(app, "Contents", "Resources", "app", "bin", "code");
      return launcher && existsSync(launcher) ? launcher : undefined;
    },

    pluginsDir: join(home, "Library", "Application Support", STREAM_DECK_BUNDLE, "Plugins"),
    // Homebrew's bin folders are on most developers' PATH and writable by them; Kiro links its own
    // `kiro` and `kiro-cli` commands there too.
    sharedBinDirs: ["/opt/homebrew/bin", "/usr/local/bin"],
    shellProfile: basename(shell) === "bash" ? "~/.bash_profile" : basename(shell) === "zsh" ? "~/.zshrc" : "your shell profile",
    streamDeckLog: "~/Library/Logs/ElgatoStreamDeck/StreamDeck.log",

    // An interactive login shell reads the same files a new Terminal window does. It starts from
    // the system PATH, so folders that only Stream Deck's environment has do not count. The answer
    // counts as soon as it is printed: a profile may leave background jobs holding the pipe, and
    // an interactive shell ignores SIGTERM, so a stuck one is killed with its process group.
    loginShellPath() {
      return new Promise((resolve) => {
        /** @type {NodeJS.Timeout | undefined} */
        let timer;
        let done = false;
        let out = "";
        const child = spawn(shell, ["-ilc", `printf '%s%s%s' ${PATH_MARKER} "$PATH" ${PATH_MARKER}`], {
          env: { ...env, PATH: SYSTEM_PATH },
          stdio: ["ignore", "pipe", "ignore"],
          detached: true,
        });
        /** @param {string | undefined} value */
        const finish = (value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          child.stdout.destroy();
          child.unref();
          resolve(value);
        };
        timer = setTimeout(() => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            // already gone
          }
          finish(undefined);
        }, probeTimeoutMs);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          out += chunk;
          const start = out.indexOf(PATH_MARKER);
          const end = start < 0 ? -1 : out.indexOf(PATH_MARKER, start + PATH_MARKER.length);
          if (end > start) finish(out.slice(start + PATH_MARKER.length, end) || undefined);
        });
        child.on("error", () => finish(undefined));
        child.on("close", () => finish(undefined));
      });
    },

    streamDeckRunning() {
      try {
        execFileSync("/usr/bin/pgrep", ["-f", "Elgato Stream Deck.app/Contents/MacOS"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },

    async quitStreamDeck() {
      quiet("/usr/bin/osascript", ["-e", `tell application id "${STREAM_DECK_BUNDLE}" to quit`]);
    },

    async openStreamDeck() {
      quiet("/usr/bin/open", ["-b", STREAM_DECK_BUNDLE]);
    },
  };
}
