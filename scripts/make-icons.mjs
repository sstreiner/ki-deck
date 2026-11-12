#!/usr/bin/env node
// Writes the plugin's images into net.streiner.ki-deck.sdPlugin/imgs.
// The marketplace icon must be PNG, so it is rasterized here (no image tools needed);
// everything else is SVG. Run by `npm run build`.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const IMGS = join(dirname(fileURLToPath(import.meta.url)), "..", "net.streiner.ki-deck.sdPlugin", "imgs");
const PURPLE = [0x90, 0x46, 0xff];
const WHITE = [0xff, 0xff, 0xff];
const AMBER = [0xe3, 0xb3, 0x41];

// ---- PNG -------------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Rounded rectangles in 512-unit coordinates, drawn back to front with 4x4 supersampling. */
function rasterize(size, shapes) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = 512 / size;
  const inside = (px, py, { x, y, w, h, r }) => {
    if (px < x || py < y || px > x + w || py > y + h) return false;
    const dx = Math.max(x + r - px, 0, px - (x + w - r));
    const dy = Math.max(y + r - py, 0, py - (y + h - r));
    return dx * dx + dy * dy <= r * r;
  };
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const ux = (px + (sx + 0.5) / 4) * scale;
          const uy = (py + (sy + 0.5) / 4) * scale;
          const hit = shapes.findLast((s) => inside(ux, uy, s));
          if (hit) [r, g, b, a] = [r + hit.color[0], g + hit.color[1], b + hit.color[2], a + 1];
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) rgba.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round((a / 16) * 255)], i);
    }
  }
  return encodePng(size, rgba);
}

function marketplaceShapes() {
  const shapes = [{ x: 0, y: 0, w: 512, h: 512, r: 96, color: PURPLE }];
  const [key, gap] = [112, 28];
  const left = (512 - (3 * key + 2 * gap)) / 2;
  const top = (512 - (2 * key + gap)) / 2;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const color = row === 0 && col === 1 ? AMBER : WHITE;
      shapes.push({ x: left + col * (key + gap), y: top + row * (key + gap), w: key, h: key, r: 20, color });
    }
  }
  return shapes;
}

// ---- SVG -------------------------------------------------------------------------------

// `scale`: declared size over drawing size. Key images say twice their 144 px, like the ones the
// plugin draws (src/render/tiles.ts), so large keys (Stream Deck Mobile) rasterize them sharp.
const svg = (size, body, scale = 1) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size * scale}" height="${size * scale}" viewBox="0 0 ${size} ${size}">${body}</svg>\n`;
const keySvg = (body) => svg(144, body, 2);

const CATEGORY_ICON = svg(
  28,
  [0, 1, 2]
    .flatMap((c) => [0, 1].map((r) => `<rect x="${3 + c * 8}" y="${7 + r * 8}" width="6" height="6" rx="1.5" fill="#ffffff"/>`))
    .join(""),
);

const SESSION_ICON = svg(
  20,
  '<rect x="2" y="3" width="16" height="14" rx="2.5" fill="none" stroke="#ffffff" stroke-width="1.8"/>' +
    '<circle cx="6" cy="7" r="1.4" fill="#ffffff"/><rect x="5" y="11" width="10" height="2" rx="1" fill="#ffffff"/>',
);

const INBOX_ICON = svg(
  20,
  '<path d="M3 11 L5.5 4 H14.5 L17 11 V16 H3 Z" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/>' +
    '<path d="M3 11 H7.5 L8.5 13 H11.5 L12.5 11 H17" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/>',
);

const STROKE = 'fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const ALLOW_ICON = svg(20, `<path d="M4 10.5 L8.5 15 L16 5.5" ${STROKE}/>`);
const DENY_ICON = svg(20, `<path d="M5 5 L15 15 M15 5 L5 15" ${STROKE}/>`);
const DECIDE_ICON = svg(20, `<rect x="2" y="4" width="16" height="12" rx="2" ${STROKE}/><path d="M6 10 H13 M10 7 L13 10 L10 13" ${STROKE}/>`);
const LOCK_ICON = svg(20, `<path d="M6.5 9 V6.5 a3.5 3.5 0 0 1 7 0 V9" ${STROKE}/><rect x="4" y="9" width="12" height="8" rx="1.5" fill="#ffffff"/>`);
// A gate: two posts with a bar.
const GATE_ICON = svg(20, `<path d="M4 17 V4 M16 17 V4 M4 8 H16 M4 12 H16" ${STROKE}/>`);
// A request: a text banner.
const REQUEST_ICON = svg(20, `<rect x="2" y="4" width="16" height="12" rx="2" ${STROKE}/><path d="M5 8 H15 M5 12 H11" ${STROKE}/>`);
// A gauge: an arc with a needle.
const USAGE_ICON = svg(20, `<path d="M3.5 14.5 A7 7 0 1 1 16.5 14.5" ${STROKE}/><path d="M10 12 L13.5 7" ${STROKE}/><circle cx="10" cy="12" r="1.5" fill="#ffffff"/>`);
// Deck session keys (M4). Model: a chip. Effort: rising bars. Autonomy: a steering wheel.
const MODEL_ICON = svg(20, `<rect x="5" y="5" width="10" height="10" rx="1.5" ${STROKE}/><path d="M8 2.5 V5 M12 2.5 V5 M8 15 V17.5 M12 15 V17.5 M2.5 8 H5 M2.5 12 H5 M15 8 H17.5 M15 12 H17.5" ${STROKE}/>`);
const EFFORT_ICON = svg(20, `<path d="M4 16 V12 M8 16 V9 M12 16 V6 M16 16 V3" ${STROKE}/>`);
const AUTONOMY_ICON = svg(20, `<circle cx="10" cy="10" r="7" ${STROKE}/><circle cx="10" cy="10" r="2" fill="#ffffff"/><path d="M3 10 H8 M12 10 H17 M10 12 V17" ${STROKE}/>`);
const STOP_ICON = svg(20, `<rect x="4.5" y="4.5" width="11" height="11" rx="2" fill="#ffffff"/>`);
const PROMPT_ICON = svg(20, `<path d="M3 4 H17 V13 H9 L5 16.5 V13 H3 Z" ${STROKE}/>`);

const KEY_TEXT = (y, size, value, extra = "") =>
  `<text x="72" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" fill="#e6edf3" text-anchor="middle"${extra}>${value}</text>`;
const PLAIN_KEY = (title, subtitle, fill = "#21262d") =>
  keySvg(`<rect width="144" height="144" fill="${fill}"/>${KEY_TEXT(64, 24, title, ' font-weight="bold"')}${KEY_TEXT(96, 17, subtitle, ' fill-opacity="0.6"')}`);

const SESSION_KEY = keySvg(`<rect width="144" height="144" fill="#161b22"/>${KEY_TEXT(80, 17, "No session", ' fill-opacity="0.6"')}`);
const INBOX_KEY = keySvg(
  `<rect width="144" height="144" fill="#30363d"/>${KEY_TEXT(30, 18, "Inbox", ' font-weight="bold"')}${KEY_TEXT(84, 52, "0", ' font-weight="bold"')}${KEY_TEXT(110, 17, "all clear")}`,
);

// ---- Write -----------------------------------------------------------------------------

const files = {
  "plugin/marketplace.png": rasterize(256, marketplaceShapes()),
  "plugin/marketplace@2x.png": rasterize(512, marketplaceShapes()),
  "plugin/category-icon.svg": CATEGORY_ICON,
  "actions/session/icon.svg": SESSION_ICON,
  "actions/session/key.svg": SESSION_KEY,
  "actions/inbox/icon.svg": INBOX_ICON,
  "actions/inbox/key.svg": INBOX_KEY,
  "actions/allow/icon.svg": ALLOW_ICON,
  "actions/allow/key.svg": PLAIN_KEY("Allow", "nothing waiting"),
  "actions/deny/icon.svg": DENY_ICON,
  "actions/deny/key.svg": PLAIN_KEY("Deny", "nothing waiting"),
  "actions/decide-in-kiro/icon.svg": DECIDE_ICON,
  "actions/decide-in-kiro/key.svg": PLAIN_KEY("In Kiro", "nothing waiting"),
  "actions/lockdown/icon.svg": LOCK_ICON,
  "actions/lockdown/key.svg": PLAIN_KEY("Lockdown", "off", "#30363d"),
  "actions/lockdown/key-on.svg": PLAIN_KEY("LOCKED", "press to unlock", "#d1242f"),
  "actions/usage/icon.svg": USAGE_ICON,
  "actions/usage/key.svg": PLAIN_KEY("Credits", "loading…", "#30363d"),
  "actions/gate/icon.svg": GATE_ICON,
  "actions/gate/key.svg": PLAIN_KEY("Gate", "off", "#30363d"),
  "actions/gate/key-on.svg": PLAIN_KEY("Gate", "on", "#0969da"),
  "actions/request/icon.svg": REQUEST_ICON,
  "actions/request/key.svg": PLAIN_KEY("Request", "nothing waiting"),
  "actions/model/icon.svg": MODEL_ICON,
  "actions/model/key.svg": PLAIN_KEY("Model", "no deck session"),
  "actions/effort/icon.svg": EFFORT_ICON,
  "actions/effort/key.svg": PLAIN_KEY("Effort", "no deck session"),
  "actions/autonomy/icon.svg": AUTONOMY_ICON,
  "actions/autonomy/key.svg": PLAIN_KEY("Supervised", "asks first", "#9a6700"),
  "actions/autonomy/key-on.svg": PLAIN_KEY("Autopilot", "runs tools", "#1a7f37"),
  "actions/stop/icon.svg": STOP_ICON,
  "actions/stop/key.svg": PLAIN_KEY("Stop", "not running"),
  "actions/prompt/icon.svg": PROMPT_ICON,
  "actions/prompt/key.svg": PLAIN_KEY("Prompt", "no deck session"),
};

for (const [path, content] of Object.entries(files)) {
  const target = join(IMGS, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
console.log(`icons: wrote ${Object.keys(files).length} files to ${IMGS}`);
