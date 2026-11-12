#!/usr/bin/env node
// Builds the Stream Deck profiles bundled with the Kiro plugin from profiles/layouts.mjs.
//
//   node scripts/build-profiles.mjs             write <plugin>.sdPlugin/profiles/*.streamDeckProfile
//   node scripts/build-profiles.mjs --preview   print every layout, write nothing
//   node scripts/build-profiles.mjs --manifest  print the plugin manifest "Profiles" entries
//
// Output format: the "Version 3.0" profile that Stream Deck 7.x writes to ProfilesV3 and loads
// from plugins: a zip holding <UUID>.sdProfile/manifest.json plus one Profiles/<UUID>/manifest.json
// per page or folder. UUIDs are derived from the layout, so rebuilding does not change them.
// No dependencies beyond Node.js and macOS's /usr/bin/zip.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIONS, DEVICES, PLUGIN, PROFILES } from "../profiles/layouts.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(REPO, `${PLUGIN.uuid}.sdPlugin`, "profiles");
const FIXED_TIME = new Date("2026-01-01T00:00:00Z"); // stable zip timestamps

const FOLDER_UUID = "com.elgato.streamdeck.profile.openchild";
const BACK_UUID = "com.elgato.streamdeck.profile.backtoparent";

/** UUID (v4 layout) derived from `parts`, so the same layout always gets the same IDs. */
function stableUuid(...parts) {
  const h = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Resolves a profile entry into its device, grid and pages (main page first, then folders). */
function resolve(profile) {
  const device = DEVICES[profile.device];
  if (!device) throw new Error(`${profile.file}: unknown device "${profile.device}"`);
  const grid = profile.grid ?? device.grid;
  const { layout } = profile;
  const pages = [
    { id: "main", keys: layout.keys },
    ...Object.entries(layout.folders ?? {}).map(([id, f]) => ({ id, keys: f.keys })),
  ];
  return { device, grid, layout, pages };
}

function validate(profile) {
  const { device, grid, layout, pages } = resolve(profile);
  const errors = [];
  const fail = (msg) => errors.push(`${profile.file}: ${msg}`);

  if (device.maxGrid && (grid[0] > device.maxGrid[0] || grid[1] > device.maxGrid[1])) {
    fail(`grid ${grid.join("x")} exceeds ${device.label} maximum ${device.maxGrid.join("x")}`);
  }
  const folderIds = new Set(Object.keys(layout.folders ?? {}));
  const usedFolders = new Set();

  const checkAction = (cell, controller, where) => {
    const def = ACTIONS[cell.action];
    if (!def) return fail(`${where}: unknown action "${cell.action}"`);
    if (!def.controllers.includes(controller)) fail(`${where}: "${cell.action}" does not support ${controller}`);
  };

  for (const page of pages) {
    if (page.keys.length > grid[1]) fail(`${page.id}: ${page.keys.length} rows, grid has ${grid[1]}`);
    page.keys.forEach((row, r) => {
      if (row.length > grid[0]) fail(`${page.id} row ${r}: ${row.length} keys, grid has ${grid[0]}`);
      row.forEach((cell, c) => {
        if (!cell) return;
        const where = `${page.id} key ${c},${r}`;
        if (cell.back) {
          if (page.id === "main" || c !== 0 || r !== 0) fail(`${where}: Back belongs at 0,0 of a folder`);
        } else if (cell.folder) {
          if (!folderIds.has(cell.folder)) fail(`${where}: unknown folder "${cell.folder}"`);
          if (cell.folder === page.id) fail(`${where}: folder opens itself`);
          usedFolders.add(cell.folder);
        } else {
          checkAction(cell, "Keypad", where);
        }
      });
    });
    if (page.id !== "main" && !page.keys[0]?.[0]?.back) fail(`${page.id}: folder has no Back key at 0,0`);
  }
  for (const id of folderIds) if (!usedFolders.has(id)) fail(`folder "${id}" is never opened`);

  if (layout.dials) {
    if (!device.dials) fail(`${device.label} has no dials`);
    else if (layout.dials.length > device.dials) fail(`${layout.dials.length} dials, device has ${device.dials}`);
    layout.dials.forEach((cell, i) => cell && checkAction(cell, "Encoder", `dial ${i}`));
  }
  if (layout.infobar) {
    if (!device.infobar) fail(`${device.label} has no infobar`);
    else checkAction(layout.infobar, "Neo", "infobar");
  }
  return errors;
}

// ---- Only what the plugin has ------------------------------------------------------------

const MANIFEST_PATH = join(REPO, `${PLUGIN.uuid}.sdPlugin`, "manifest.json");

function readManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

/** Action name (as used in layouts.mjs) -> the controllers the plugin manifest declares for it. */
function availableActions(manifest) {
  const prefix = `${PLUGIN.uuid}.`;
  return new Map(
    manifest.Actions.filter((a) => a.UUID.startsWith(prefix)).map((a) => [a.UUID.slice(prefix.length), new Set(a.Controllers ?? ["Keypad"])]),
  );
}

/**
 * Copy of a profile with cells emptied whose action the manifest does not declare for that
 * controller (a key, a dial or the Neo infobar), and folders that end up holding only their
 * Back key removed together with the keys that opened them.
 */
function prune(profile, available) {
  const keepOn = (controller) => (cell) => (cell && cell.action && !available.get(cell.action)?.has(controller) ? null : cell);
  const keep = keepOn("Keypad");
  let folders = Object.fromEntries(
    Object.entries(profile.layout.folders ?? {}).map(([id, f]) => [id, { keys: f.keys.map((row) => row.map(keep)) }]),
  );
  const strip = (keys, live) => keys.map((row) => row.map((cell) => (cell?.folder && !live.has(cell.folder) ? null : cell)));
  for (;;) {
    const live = new Set(Object.keys(folders).filter((id) => folders[id].keys.flat().some((c) => c && !c.back)));
    const next = Object.fromEntries([...live].map((id) => [id, { keys: strip(folders[id].keys, live) }]));
    if (Object.keys(next).length === Object.keys(folders).length) {
      folders = next;
      break;
    }
    folders = next;
  }
  const live = new Set(Object.keys(folders));
  const keys = strip(profile.layout.keys.map((row) => row.map(keep)), live);
  // Folders only reachable from a removed folder are unreachable now; drop them too.
  const reachable = new Set();
  const visit = (rows) =>
    rows.flat().forEach((c) => {
      if (c?.folder && !reachable.has(c.folder)) {
        reachable.add(c.folder);
        visit(folders[c.folder].keys);
      }
    });
  visit(keys);
  return {
    ...profile,
    layout: {
      keys,
      folders: Object.fromEntries([...reachable].map((id) => [id, folders[id]])),
      ...(profile.layout.dials ? { dials: profile.layout.dials.map(keepOn("Encoder")) } : {}),
      ...(profile.layout.infobar && keepOn("Neo")(profile.layout.infobar) ? { infobar: profile.layout.infobar } : {}),
    },
  };
}

/** The plugin manifest's Profiles entries for these profiles. */
function manifestProfiles(profiles) {
  return profiles.map((p) => ({
    Name: `profiles/${p.file}`,
    DeviceType: DEVICES[p.device].deviceType,
    Readonly: false,
    DontAutoSwitchWhenInstalled: true,
    AutoInstall: p.autoInstall ?? true,
  }));
}

// ---- Stream Deck profile JSON ------------------------------------------------------------

const PLUGIN_REF = { Name: PLUGIN.name, UUID: PLUGIN.uuid, Version: readManifest().Version };

function entry(cell, actionId, folderUuids) {
  if (cell.back) {
    return {
      ActionID: actionId,
      LinkedTitle: true,
      Name: "Parent Folder",
      Resources: null,
      Settings: {},
      State: 0,
      States: [{}],
      UUID: BACK_UUID,
    };
  }
  if (cell.folder) {
    return {
      ActionID: actionId,
      LinkedTitle: true,
      Name: "Create Folder",
      Plugin: { Name: "Create Folder", UUID: FOLDER_UUID, Version: "1.0" },
      Resources: null,
      Settings: { ProfileUUID: folderUuids[cell.folder] },
      State: 0,
      States: [
        {
          FontFamily: "",
          FontSize: 12,
          FontStyle: "",
          FontUnderline: false,
          OutlineThickness: 2,
          ShowTitle: true,
          Title: cell.title,
          TitleAlignment: "bottom",
          TitleColor: "#ffffff",
        },
      ],
      UUID: FOLDER_UUID,
    };
  }
  const def = ACTIONS[cell.action];
  return {
    ActionID: actionId,
    LinkedTitle: true,
    Name: def.name,
    Plugin: PLUGIN_REF,
    Resources: null,
    Settings: cell.settings,
    State: 0,
    // Empty states on purpose: a title or image stored in the profile counts as user-defined
    // and would override what the plugin draws at runtime (setTitle/setImage).
    States: Array.from({ length: def.states }, () => ({})),
    UUID: `${PLUGIN.uuid}.${cell.action}`,
  };
}

/** Maps cells to "column,row" entries, or null when empty (as Stream Deck writes them). */
function controllerActions(cells, idFor, folderUuids) {
  const actions = {};
  for (const [pos, cell] of cells) if (cell) actions[pos] = entry(cell, idFor(pos), folderUuids);
  return Object.keys(actions).length ? actions : null;
}

function pageManifest(profile, page, folderUuids) {
  const { device, layout } = resolve(profile);
  const id = (controller) => (pos) => stableUuid(profile.file, page?.id ?? "default", controller, pos);
  const keyCells = (page?.keys ?? []).flatMap((row, r) => row.map((cell, c) => [`${c},${r}`, cell]));
  // Dials and the infobar are repeated on every page and folder so they keep working there.
  const dialCells = page ? (layout.dials ?? []).map((cell, i) => [`${i},0`, cell]) : [];
  const infobarCells = page && layout.infobar ? [["1,0", layout.infobar]] : [];

  const controllers = [{ Actions: controllerActions(keyCells, id("Keypad"), folderUuids), Type: "Keypad" }];
  if (device.dials) controllers.push({ Actions: controllerActions(dialCells, id("Encoder"), folderUuids), Type: "Encoder" });
  if (device.infobar) controllers.push({ Actions: controllerActions(infobarCells, id("Neo"), folderUuids), Type: "Neo" });
  return { Controllers: controllers, Icon: "", Name: "" };
}

function profileFiles(profile) {
  const { device, pages } = resolve(profile);
  const root = stableUuid(profile.file, "profile").toUpperCase();
  const uuids = Object.fromEntries([...pages.map((p) => p.id), "default"].map((id) => [id, stableUuid(profile.file, "page", id)]));
  const folderUuids = Object.fromEntries(pages.filter((p) => p.id !== "main").map((p) => [p.id, uuids[p.id]]));

  const files = {
    [`${root}.sdProfile/manifest.json`]: {
      Device: { Model: device.model, UUID: "" },
      Name: profile.name,
      // "Default" is the empty base page Stream Deck itself writes next to the visible pages.
      Pages: { Current: uuids.main, Default: uuids.default, Pages: [uuids.main] },
      Version: "3.0",
    },
    [`${root}.sdProfile/Profiles/${uuids.default.toUpperCase()}/manifest.json`]: pageManifest(profile, null, folderUuids),
  };
  for (const page of pages) {
    files[`${root}.sdProfile/Profiles/${uuids[page.id].toUpperCase()}/manifest.json`] = pageManifest(profile, page, folderUuids);
  }
  return files;
}

function listFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .map((p) => join(dir, p))
    .filter((p) => statSync(p).isFile())
    .map((p) => relative(dir, p))
    .sort();
}

function build(profile) {
  const stage = mkdtempSync(join(tmpdir(), "kiro-profile-"));
  try {
    for (const [path, json] of Object.entries(profileFiles(profile))) {
      mkdirSync(join(stage, dirname(path)), { recursive: true });
      writeFileSync(join(stage, path), `${JSON.stringify(json, null, 2)}\n`);
    }
    const files = listFiles(stage);
    for (const p of [...files, ...new Set(files.flatMap((f) => ancestors(f)))]) utimesSync(join(stage, p), FIXED_TIME, FIXED_TIME);

    const out = join(OUT_DIR, `${profile.file}.streamDeckProfile`);
    rmSync(out, { force: true }); // zip adds to an existing archive instead of replacing it
    execFileSync("/usr/bin/zip", ["-q", "-X", "-D", out, ...files], { cwd: stage });
    return { out, folders: resolve(profile).pages.length - 1 };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function ancestors(path) {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

// ---- Preview -----------------------------------------------------------------------------

function label(cell) {
  if (!cell) return "·";
  if (cell.back) return "Back";
  if (cell.folder) return `[${cell.title}]`;
  const s = cell.settings;
  switch (cell.action) {
    case "session": return s.slot === undefined ? "Session" : `S${s.slot + 1}`;
    case "request": return `Req ${s.part + 1}/${s.parts}`;
    case "deny": return s.reasonIndex === undefined ? "Deny" : `Reason ${s.reasonIndex + 1}`;
    case "model": return s.slot === undefined ? "Model" : `M${s.slot + 1}`;
    case "usage": return s.view === "today" ? "Today" : "Credits";
    case "prompt": return `Prompt ${s.promptIndex + 1}`;
    case "launch": return { agents: "Agents", cli: "New CLI", "ide-session": "New chat" }[s.target];
    case "decide-in-kiro": return "In Kiro";
    case "gate": return `Gate ${s.category}`;
    default: return ACTIONS[cell.action].name;
  }
}

function preview(profile) {
  const { device, grid, layout, pages } = resolve(profile);
  const lines = [`${profile.file}.streamDeckProfile  (${device.label}, ${grid.join("x")} keys${device.dials ? `, ${device.dials} dials` : ""}${device.infobar ? ", infobar" : ""})`];
  for (const page of pages) {
    lines.push(`  ${page.id === "main" ? "main page" : `folder "${page.id}"`}`);
    for (let r = 0; r < grid[1]; r++) {
      const row = Array.from({ length: grid[0] }, (_, c) => label(page.keys[r]?.[c]).padEnd(10));
      lines.push(`    ${row.join(" ").trimEnd()}`);
    }
  }
  if (layout.dials) lines.push(`  dials: ${layout.dials.map(label).join(" | ")}`);
  if (layout.infobar) lines.push(`  infobar: ${label(layout.infobar)}`);
  return lines.join("\n");
}

// ---- Main --------------------------------------------------------------------------------

const arg = process.argv[2];
if (arg === "--help" || arg === "-h") {
  console.log("Usage: node scripts/build-profiles.mjs [--preview | --manifest]");
  process.exit(0);
}
if (arg && !["--preview", "--design", "--manifest"].includes(arg)) {
  console.error(`unknown option: ${arg}`);
  process.exit(1);
}

const names = new Set();
const errors = PROFILES.flatMap((p) => {
  const dup = names.has(p.file) ? [`${p.file}: duplicate file name`] : [];
  names.add(p.file);
  return [...dup, ...validate(p)];
});
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

const manifest = readManifest();
const available = availableActions(manifest);
const built = PROFILES.map((p) => prune(p, available));

if (arg === "--design") {
  console.log(PROFILES.map(preview).join("\n\n"));
} else if (arg === "--preview") {
  console.log(`Actions in the manifest: ${[...available.keys()].join(", ")}\n`);
  console.log(built.map(preview).join("\n\n"));
} else if (arg === "--manifest") {
  console.log(JSON.stringify({ Profiles: manifestProfiles(built) }, null, 2));
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const profile of built) {
    const { out, folders } = build(profile);
    console.log(`${relative(REPO, out)}  (${DEVICES[profile.device].label}, ${folders} folders)`);
  }
  const profiles = manifestProfiles(built);
  if (JSON.stringify(manifest.Profiles) !== JSON.stringify(profiles)) {
    writeFileSync(MANIFEST_PATH, `${JSON.stringify({ ...manifest, Profiles: profiles }, null, 2)}\n`);
    console.log(`updated the Profiles list in ${relative(REPO, MANIFEST_PATH)}`);
  }
}
