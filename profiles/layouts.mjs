// Key layouts for the Stream Deck profiles bundled with the Kiro plugin.
// `node scripts/build-profiles.mjs` turns them into .streamDeckProfile files.
//
// Layouts list keys row by row; `_` is an empty key. Stream Deck addresses keys as "column,row".
// Folders are Stream Deck's built-in folders: a key opens the folder, "Back" (always at the
// top left) returns. Dials and the Neo infobar are repeated inside folders so they keep working.
//
// This is the full design. The build only places actions the plugin manifest declares, so
// keys for actions that are not built yet stay empty and folders left empty are dropped.

// The plugin version written into the profiles comes from the plugin manifest.
export const PLUGIN = { uuid: "net.streiner.ki-deck", name: "ki-deck" };

// Plugin actions the profiles use. Must match the plugin manifest (README section 8.1).
// `states` must equal the number of States the manifest declares for the action.
export const ACTIONS = {
  session: { name: "Session", states: 1, controllers: ["Keypad", "Encoder"] },
  inbox: { name: "Inbox", states: 1, controllers: ["Keypad", "Neo"] },
  request: { name: "Request", states: 1, controllers: ["Keypad"] },
  allow: { name: "Allow", states: 1, controllers: ["Keypad"] },
  deny: { name: "Deny", states: 1, controllers: ["Keypad"] },
  "decide-in-kiro": { name: "Decide in Kiro", states: 1, controllers: ["Keypad"] },
  stop: { name: "Stop", states: 1, controllers: ["Keypad"] },
  lockdown: { name: "Lockdown", states: 2, controllers: ["Keypad"] },
  gate: { name: "Gate", states: 2, controllers: ["Keypad"] },
  autonomy: { name: "Autonomy", states: 2, controllers: ["Keypad"] },
  model: { name: "Model", states: 1, controllers: ["Keypad", "Encoder"] },
  effort: { name: "Effort", states: 1, controllers: ["Keypad", "Encoder"] },
  usage: { name: "Usage", states: 1, controllers: ["Keypad", "Encoder"] },
  prompt: { name: "Prompt", states: 1, controllers: ["Keypad"] },
};

// Device models as written by Stream Deck 7.6.1 (its bundled default profiles and device list).
// `grid` is fixed by the hardware; Stream Deck Mobile's grid is set in the app, so its
// profiles state their own grid.
export const DEVICES = {
  "stream-deck": { label: "Stream Deck", deviceType: 0, model: "20GBA9901", grid: [5, 3] },
  mini: { label: "Stream Deck Mini", deviceType: 1, model: "20GAI9901", grid: [3, 2] },
  xl: { label: "Stream Deck XL", deviceType: 2, model: "20GAT9901", grid: [8, 4] },
  mobile: { label: "Stream Deck Mobile", deviceType: 3, model: "VSD2/WiFi", maxGrid: [8, 8] },
  pedal: { label: "Stream Deck Pedal", deviceType: 5, model: "20GBF9901", grid: [3, 1] },
  plus: { label: "Stream Deck +", deviceType: 7, model: "20GBD9901", grid: [4, 2], dials: 4 },
  neo: { label: "Stream Deck Neo", deviceType: 9, model: "20GBJ9901", grid: [4, 2], infobar: true },
  "plus-xl": { label: "Stream Deck + XL", deviceType: 13, model: "20GBX9901", grid: [9, 4], dials: 6 },
};

const _ = null;
const BACK = { back: true };
const act = (action, settings = {}) => ({ action, settings });
const folder = (title, id) => ({ folder: id, title });

const session = (slot) => act("session", { slot }); // nth session: needs you, then working, then most recent
const sessionDial = () => act("session"); // rotate: pick a session, push: focus it
const inbox = () => act("inbox"); // count of waiting items; press focuses the next one
const request = (part, parts) => act("request", { part, parts }); // the waiting call, spread over `parts` keys
const allow = () => act("allow");
const deny = () => act("deny");
const reason = (i) => act("deny", { reasonIndex: i }); // deny with config.json denyReasons[i]
const reasons = () => [reason(0), reason(1), reason(2), reason(3)];
const decide = () => act("decide-in-kiro");
const stop = () => act("stop");
const lockdown = () => act("lockdown");
const gate = (category) => act("gate", { category }); // "shell", "write" or "mcp": press turns it on or off
const gates = () => [gate("shell"), gate("write"), gate("mcp")];
const autonomy = () => act("autonomy");
const model = () => act("model"); // the target deck session's model; on a dial: rotate to choose, push to apply
const modelSlot = (slot) => act("model", { slot }); // nth pinned or advertised model; press applies
const modelSlots = (from, count) => Array.from({ length: count }, (_x, i) => modelSlot(from + i));
const effort = () => act("effort");
const credits = () => act("usage", { view: "credits" });
const today = () => act("usage", { view: "today" });
const prompt = (i) => act("prompt", { promptIndex: i }); // send config.json cannedPrompts[i]
const prompts = () => [prompt(0), prompt(1), prompt(2)];
const banner = (parts) => Array.from({ length: parts }, (_x, i) => request(i, parts));

// One design for every device, in three zones:
// 1. Watch: Session keys and the Inbox. Sessions fill in order of what needs you.
// 2. Answer: Allow and Deny, always on the first page, and Stop for deck sessions.
// 3. Account and safety: Credits and Lockdown.
// Folders group by topic, the same names on every device:
// - Reasons: the four deny-with-reason keys next to the whole request (a banner), and Allow/Deny.
// - Deck: everything for deck sessions (model, effort, autonomy, prompts, model keys), with
//   Allow and Deny again, because a deck session asks while you steer it.
// - Safety: the three gate switches (and Lockdown on devices with room).
// - More: extra sessions and Today on small devices.
// Stream Deck + puts sessions, model, effort and credits on the dials; Neo puts the Inbox and
// credits on its infobar.

// 15 keys: Stream Deck, and Stream Deck Mobile at 5 x 3.
// Row 1 watches, row 2 answers, row 3 is the account, lockdown and folders.
const KEYS_15 = {
  keys: [
    [session(0), session(1), session(2), session(3), inbox()],
    [allow(), deny(), folder("Reasons", "reasons"), decide(), stop()],
    [credits(), today(), lockdown(), folder("Deck", "deck"), folder("More", "more")],
  ],
  folders: {
    reasons: {
      keys: [
        [BACK, ...reasons()],
        [...banner(3), allow(), deny()],
        [_, _, _, decide(), inbox()],
      ],
    },
    deck: {
      keys: [
        [BACK, model(), effort(), autonomy(), stop()],
        modelSlots(0, 5),
        [...prompts(), allow(), deny()],
      ],
    },
    more: {
      keys: [
        [BACK, session(4), session(5), session(6), session(7)],
        [...gates(), lockdown(), decide()],
        [...banner(4), inbox()],
      ],
    },
  },
};

// 6 keys: Stream Deck Mini, and Stream Deck Mobile on the free tier.
// Every folder is one press from More, so nothing is more than two presses away.
const KEYS_6 = {
  keys: [
    [inbox(), allow(), deny()],
    [credits(), lockdown(), folder("More", "more")],
  ],
  folders: {
    more: {
      keys: [
        [BACK, folder("Sessions", "sessions"), folder("Deck", "deck")],
        [folder("Reasons", "reasons"), folder("Safety", "safety"), today()],
      ],
    },
    sessions: {
      keys: [
        [BACK, session(0), session(1)],
        [session(2), session(3), session(4)],
      ],
    },
    deck: {
      keys: [
        [BACK, model(), effort()],
        [autonomy(), stop(), prompt(0)],
      ],
    },
    reasons: {
      keys: [
        [BACK, reason(0), reason(1)],
        [reason(2), reason(3), decide()],
      ],
    },
    safety: {
      keys: [
        [BACK, gate("shell"), gate("write")],
        [gate("mcp"), request(0, 1), inbox()],
      ],
    },
  },
};

// 8 keys: the first page of Stream Deck + and Neo.
const MAIN_8 = [
  [session(0), session(1), inbox(), lockdown()],
  [allow(), deny(), stop(), folder("More", "more")],
];

const REASONS_8 = {
  keys: [
    [BACK, reason(0), reason(1), inbox()],
    [reason(2), reason(3), allow(), deny()],
  ],
};

const SAFETY_8 = { keys: [[BACK, ...gates()]] };

// Stream Deck +: 8 keys and 4 dials. Sessions, model, effort and credits live on the dials.
const PLUS = {
  keys: MAIN_8,
  dials: [sessionDial(), model(), effort(), credits()],
  folders: {
    more: {
      keys: [
        [BACK, session(2), session(3), decide()],
        [folder("Reasons", "reasons"), folder("Deck", "deck"), folder("Safety", "safety"), today()],
      ],
    },
    reasons: REASONS_8,
    deck: {
      keys: [
        [BACK, autonomy(), stop(), prompt(0)],
        [prompt(1), prompt(2), modelSlot(0), modelSlot(1)],
      ],
    },
    safety: SAFETY_8,
  },
};

// Stream Deck Neo: 8 keys; the infobar shows what waits on you and the credits.
const NEO = {
  keys: MAIN_8,
  infobar: inbox(),
  folders: {
    more: {
      keys: [
        [BACK, session(2), session(3), decide()],
        [folder("Reasons", "reasons"), folder("Deck", "deck"), folder("Safety", "safety"), today()],
      ],
    },
    reasons: REASONS_8,
    deck: {
      keys: [
        [BACK, model(), effort(), autonomy()],
        [...prompts(), credits()],
      ],
    },
    safety: SAFETY_8,
  },
};

// Stream Deck XL: 32 keys. Row 2 reads and answers the waiting call: Inbox, a 4-key banner with
// the whole request, Allow, Deny, Decide in Kiro. Row 3 denies with a reason or steers.
const XL = {
  keys: [
    [session(0), session(1), session(2), session(3), session(4), session(5), session(6), session(7)],
    [inbox(), ...banner(4), allow(), deny(), decide()],
    [...reasons(), stop(), autonomy(), lockdown(), credits()],
    [model(), effort(), folder("Deck", "deck"), ...prompts(), folder("Safety", "safety"), today()],
  ],
  folders: {
    deck: {
      keys: [
        [BACK, model(), effort(), autonomy(), stop(), ...prompts()],
        modelSlots(0, 8),
        modelSlots(8, 8),
        [...banner(4), allow(), deny(), _, inbox()],
      ],
    },
    safety: { keys: [[BACK, ...gates(), lockdown()]] },
  },
};

// Stream Deck + XL: 36 keys and 6 dials, everything on one page. Two session dials watch two
// sessions side by side.
const PLUS_XL = {
  keys: [
    [session(0), session(1), session(2), session(3), session(4), session(5), session(6), session(7), inbox()],
    [...banner(4), allow(), deny(), decide(), stop(), lockdown()],
    [...reasons(), autonomy(), ...prompts(), credits()],
    [...modelSlots(0, 5), ...gates(), today()],
  ],
  dials: [sessionDial(), sessionDial(), model(), effort(), credits()],
};

// Stream Deck Pedal: hands-free approvals. The middle pedal focuses the next waiting item.
const PEDAL = {
  keys: [[allow(), inbox(), deny()]],
};

// One entry per bundled profile. `file` is also the manifest Profiles[].Name (under profiles/).
// `autoInstall: false` profiles are not offered at plugin install; double-click to import them.
// Names include the device because Stream Deck may offer a profile on more than one kind of device.
export const PROFILES = [
  { file: "kiro-stream-deck", name: "ki-deck (Stream Deck)", device: "stream-deck", layout: KEYS_15 },
  { file: "kiro-mini", name: "ki-deck (Mini)", device: "mini", layout: KEYS_6 },
  { file: "kiro-xl", name: "ki-deck (XL)", device: "xl", layout: XL },
  { file: "kiro-mobile", name: "ki-deck (Mobile)", device: "mobile", grid: [5, 3], layout: KEYS_15 },
  { file: "kiro-mobile-6", name: "ki-deck (Mobile, 6 keys)", device: "mobile", grid: [3, 2], layout: KEYS_6, autoInstall: false },
  { file: "kiro-pedal", name: "ki-deck (Pedal)", device: "pedal", layout: PEDAL },
  { file: "kiro-plus", name: "ki-deck (Stream Deck +)", device: "plus", layout: PLUS },
  { file: "kiro-neo", name: "ki-deck (Neo)", device: "neo", layout: NEO },
  { file: "kiro-plus-xl", name: "ki-deck (Stream Deck + XL)", device: "plus-xl", layout: PLUS_XL },
];
