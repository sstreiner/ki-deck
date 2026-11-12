#!/usr/bin/env node
// Draws the pictures in docs/HANDBOOK.md: every key, dial and infobar state, and every device
// with its bundled layout (one picture per page and folder). It renders with the plugin's own
// code (src/render/tiles.ts, through src/docs/gallery.ts), so the pictures match the keys.
//
//   npm run handbook      writes docs/handbook/img/**.svg

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import typescript from "@rollup/plugin-typescript";
import { rollup } from "rollup";
import { DEVICES, PROFILES } from "../profiles/layouts.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(REPO, "docs", "handbook", "img");
const CACHE = join(REPO, "node_modules", ".cache", "handbook");

// ---- Load the renderers ------------------------------------------------------------------

async function loadGallery() {
  const bundle = await rollup({
    input: join(REPO, "src", "docs", "gallery.ts"),
    external: [/^node:/],
    // tsconfig.build.json: src only, no JavaScript (tsconfig.json's allowJs breaks the plugin).
    plugins: [typescript({ tsconfig: join(REPO, "tsconfig.build.json"), include: ["src/**/*.ts"], exclude: ["test/**", "src/companion/extension.ts"], noEmitOnError: true })],
    onwarn: (w, warn) => (w.code === "CIRCULAR_DEPENDENCY" ? undefined : warn(w)),
  });
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, "gallery.mjs");
  await bundle.write({ file, format: "es" });
  await bundle.close();
  return import(`${pathToFileURL(file).href}?t=${Date.now()}`);
}

// ---- Device pictures -----------------------------------------------------------------------

const KEY = 76; // a key's size in the picture
const GAP = 12;
const PAD = 26;

/** The markup inside an `<svg>` root, so keys can be nested in the device picture. */
function inner(markup) {
  return markup.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
}

let clipId = 0;

/** One key at (x, y), with rounded corners like the hardware. */
function keyAt(x, y, markup, size = KEY) {
  const id = `k${clipId++}`;
  return (
    `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${size * 0.14}"/></clipPath>` +
    `<g clip-path="url(#${id})"><svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 144 144">${inner(markup)}</svg></g>` +
    `<rect x="${x + 0.5}" y="${y + 0.5}" width="${size - 1}" height="${size - 1}" rx="${size * 0.14}" fill="none" stroke="#ffffff" stroke-opacity="0.08"/>`
  );
}

/** A touch-strip or infobar image of `w` x `h` (its own size) drawn at width `dw`. */
function panelAt(x, y, markup, w, h, dw) {
  const dh = (dw * h) / w;
  const id = `p${clipId++}`;
  return (
    `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${dw}" height="${dh}" rx="6"/></clipPath>` +
    `<g clip-path="url(#${id})"><svg x="${x}" y="${y}" width="${dw}" height="${dh}" viewBox="0 0 ${w} ${h}">${inner(markup)}</svg></g>`
  );
}

function cellMarkup(gallery, cell) {
  if (!cell) return gallery.emptyKeyImage();
  if (cell.back) return gallery.backKeyImage();
  if (cell.folder) return gallery.folderKeyImage(cell.title);
  return gallery.cellImage(cell) ?? gallery.emptyKeyImage();
}

/** A device with one page of its layout: the body, the keys, and dials or the infobar. */
function devicePicture(gallery, profile, page) {
  const device = DEVICES[profile.device];
  const [cols, rows] = profile.grid ?? device.grid;
  const keysW = cols * KEY + (cols - 1) * GAP;
  const keysH = rows * KEY + (rows - 1) * GAP;
  const dials = device.dials ?? 0;
  const segW = 104;
  const dialsW = dials ? dials * segW + (dials - 1) * 6 : 0;
  const innerW = Math.max(keysW, dialsW);
  const phone = profile.device === "mobile";
  let extraH = 0;
  if (dials) extraH = 16 + segW / 2 + 18 + 34;
  if (device.infobar) extraH = 14 + 36;
  const width = innerW + PAD * 2;
  const height = keysH + PAD * 2 + extraH + (phone ? 36 : 0);
  const top = PAD + (phone ? 22 : 0);
  const left = PAD + (innerW - keysW) / 2;

  let body = `<rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="${phone ? 34 : 18}" fill="#16181c" stroke="#30363d" stroke-width="2"/>`;
  if (phone) body += `<rect x="${width / 2 - 30}" y="12" width="60" height="7" rx="3.5" fill="#30363d"/>`;
  page.keys.forEach((row, r) => {
    for (let c = 0; c < cols; c++) body += keyAt(left + c * (KEY + GAP), top + r * (KEY + GAP), cellMarkup(gallery, row[c]));
  });
  for (let r = page.keys.length; r < rows; r++) {
    for (let c = 0; c < cols; c++) body += keyAt(left + c * (KEY + GAP), top + r * (KEY + GAP), gallery.emptyKeyImage());
  }
  let y = top + keysH;
  if (dials) {
    y += 16;
    const x0 = PAD + (innerW - dialsW) / 2;
    const layoutDials = profile.layout.dials ?? [];
    for (let i = 0; i < dials; i++) {
      const x = x0 + i * (segW + 6);
      const markup = gallery.controlImage(layoutDials[i], "dial") ?? gallery.emptyKeyImage().replace('width="144" height="144" viewBox="0 0 144 144"', 'width="200" height="100" viewBox="0 0 200 100"');
      body += panelAt(x, y, markup, 200, 100, segW);
      const cx = x + segW / 2;
      body += `<circle cx="${cx}" cy="${y + segW / 2 + 18 + 15}" r="15" fill="#2d333b" stroke="#444c56" stroke-width="2"/><circle cx="${cx}" cy="${y + segW / 2 + 18 + 4}" r="2" fill="#8b949e"/>`;
    }
  }
  if (device.infobar) {
    y += 14;
    const barW = 160;
    const x = PAD + (innerW - barW) / 2;
    body += `<circle cx="${x - 22}" cy="${y + 17}" r="8" fill="none" stroke="#444c56" stroke-width="2"/><circle cx="${x + barW + 22}" cy="${y + 17}" r="8" fill="none" stroke="#444c56" stroke-width="2"/>`;
    body += panelAt(x, y, gallery.controlImage(profile.layout.infobar, "infobar") ?? "", 232, 50, barW);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>\n`;
}

/** Pages of a profile: the main page, then each folder in layout order. */
function pagesOf(profile) {
  return [{ id: "main", keys: profile.layout.keys }, ...Object.entries(profile.layout.folders ?? {}).map(([id, f]) => ({ id, keys: f.keys }))];
}

// ---- Main ----------------------------------------------------------------------------------

const gallery = await loadGallery();
rmSync(OUT, { recursive: true, force: true });
const written = [];
const write = (path, svg) => {
  const target = join(OUT, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, svg.endsWith("\n") ? svg : `${svg}\n`);
  written.push(path);
};

for (const [group, pictures] of Object.entries(gallery.keyGallery())) {
  for (const p of pictures) write(`keys/${group}/${p.file}.svg`, p.svg);
}
for (const p of gallery.stripGallery()) write(`strips/${p.file}.svg`, p.svg);
for (const profile of PROFILES) {
  for (const page of pagesOf(profile)) write(`devices/${profile.file}/${page.id}.svg`, devicePicture(gallery, profile, page));
}

console.log(`handbook: wrote ${written.length} pictures to ${OUT}`);
const index = Object.fromEntries(readdirSync(join(OUT, "devices")).map((d) => [d, readdirSync(join(OUT, "devices", d)).length]));
console.log(`devices: ${JSON.stringify(index)}`);
