// Brings the window, tab or pane of a session to the front. planFocus is pure: it returns
// alternatives (each a list of commands), tried in order until one fully succeeds.
// AppleScript receives values as argv, never through string building.

import type { Executables } from "./system";
import type { Session } from "./sessions";

export interface Step {
  cmd: string;
  args: string[];
}

export type FocusPlan = Step[][];

const KIRO_BUNDLE = "dev.kiro.desktop";
const OPEN = "/usr/bin/open";
const OSASCRIPT = "/usr/bin/osascript";

const ITERM_SELECT_SESSION = `on run argv
  set wanted to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if unique id of s is wanted then
            select w
            tell t to select
            tell s to select
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "session not found"
end run`;

const TERMINAL_SELECT_TTY = `on run argv
  set wanted to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is wanted then
          set selected of t to true
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  error "tab not found"
end run`;

const activate = (bundle: string): Step => ({ cmd: OPEN, args: ["-b", bundle] });
const openIn = (bundle: string, path: string): Step => ({ cmd: OPEN, args: ["-b", bundle, path] });

/** Longest open IDE workspace folder that contains `cwd`. */
export function ideRootFor(cwd: string, ideRoots: string[]): string | undefined {
  return ideRoots
    .filter((root) => cwd === root || cwd.startsWith(root.endsWith("/") ? root : `${root}/`))
    .sort((a, b) => b.length - a.length)[0];
}

/** `transcript`: a deck session's Markdown transcript, its only window. */
export function planFocus(s: Session, ideRoots: string[], bins: Executables, transcript?: string): FocusPlan {
  const plans: FocusPlan = [];
  const o = s.origin;

  if (s.surface === "deck") {
    // Opened in Kiro, else in the default text editor.
    if (transcript) plans.push([openIn(KIRO_BUNDLE, transcript)], [{ cmd: OPEN, args: ["-t", transcript] }]);
    return plans;
  }

  if (s.surface === "ide") {
    // Opening the folder in the running Kiro raises the window that has it open (tested on
    // Kiro 1.4.121). `open` hands it over in about 0.1 s; the `kiro` launcher takes over 1 s,
    // and Stream Deck reports its short-lived second Kiro process as "Kiro quit".
    if (s.cwd) plans.push([openIn(KIRO_BUNDLE, s.cwd)]);
    plans.push([activate(KIRO_BUNDLE)]);
    return plans;
  }

  if (o.tmuxPane && bins.tmux) {
    const tmux = bins.tmux;
    plans.push([
      { cmd: tmux, args: ["select-window", "-t", o.tmuxPane] },
      { cmd: tmux, args: ["select-pane", "-t", o.tmuxPane] },
      ...(o.bundle ? [activate(o.bundle)] : []),
    ]);
  }
  if (o.term === "iTerm.app" && o.termSession) {
    const uuid = o.termSession.includes(":") ? o.termSession.slice(o.termSession.indexOf(":") + 1) : o.termSession;
    plans.push([{ cmd: OSASCRIPT, args: ["-e", ITERM_SELECT_SESSION, uuid] }]);
  }
  if (o.term === "Apple_Terminal" && o.tty && o.tty !== "??") {
    plans.push([{ cmd: OSASCRIPT, args: ["-e", TERMINAL_SELECT_TTY, `/dev/${o.tty}`] }]);
  }
  if (o.bundle === KIRO_BUNDLE) {
    // kiro-cli inside Kiro's integrated terminal: focus the window whose workspace contains it.
    const root = ideRootFor(s.cwd, ideRoots);
    if (root) plans.push([openIn(KIRO_BUNDLE, root)]);
  }
  if (o.bundle) plans.push([activate(o.bundle)]);
  return plans;
}

/** The app to bring forward from a notification click. */
export function appBundleFor(s: Session): string {
  return s.surface === "ide" || s.surface === "deck" ? KIRO_BUNDLE : s.origin.bundle || "com.apple.Terminal";
}
