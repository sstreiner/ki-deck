#!/usr/bin/env node
// Turns docs/HANDBOOK.md into dist/HANDBOOK.pdf (and dist/HANDBOOK.html): Markdown to HTML with
// `marked`, every picture inlined, a print stylesheet, then printed by a headless Chromium.
//
//   npm run handbook:pdf            after npm run handbook (the pictures)
//   CHROME=/path/to/chrome npm run handbook:pdf
//
// Uses the first browser it finds: $CHROME, Google Chrome, Chromium, Microsoft Edge, Brave, or a
// Chromium that Playwright downloaded (~/Library/Caches/ms-playwright). It runs with a throwaway
// profile, so an open browser and its data are not touched.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { marked } from "marked";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(REPO, "docs");
const DIST = join(REPO, "dist");
const SOURCE = join(DOCS, "HANDBOOK.md");
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));

const MIME = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif" };

/** Every local picture as a data URL, so the HTML stands alone. */
function inlineImages(html) {
  return html.replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/g, (whole, before, src, after) => {
    if (/^(data:|https?:)/.test(src)) return whole;
    const file = resolve(DOCS, decodeURI(src));
    const mime = MIME[extname(file).toLowerCase()];
    if (!mime || !existsSync(file)) {
      console.warn(`handbook-pdf: picture not found: ${src}`);
      return whole;
    }
    return `${before}data:${mime};base64,${readFileSync(file).toString("base64")}${after}`;
  });
}

/** Links into the README or other files do not work on paper: keep their text, drop the link. */
function unlinkFiles(html) {
  return html.replace(/<a href="(?!https?:|#|mailto:)[^"]*">([\s\S]*?)<\/a>/g, "$1");
}

const STYLE = `
@page { size: A4; margin: 16mm 15mm 18mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font: 10.5pt/1.5 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif; color: #1f2328; margin: 0; }
.cover { height: 250mm; display: flex; flex-direction: column; justify-content: center; break-after: page; }
.cover h1 { font-size: 34pt; margin: 0 0 6mm; border: 0; }
.cover p { font-size: 13pt; color: #59636e; margin: 0 0 2mm; }
h1 { font-size: 22pt; margin: 0 0 4mm; }
h2 { font-size: 16pt; margin: 9mm 0 3mm; padding-bottom: 1.5mm; border-bottom: 1px solid #d1d9e0; break-after: avoid; }
h2:not(:first-of-type) { break-before: page; margin-top: 0; }
h3 { font-size: 12.5pt; margin: 6mm 0 2mm; break-after: avoid; }
p, li { orphans: 3; widows: 3; }
a { color: #0969da; text-decoration: none; }
code { font: 9pt Menlo, Monaco, monospace; background: #f6f8fa; padding: 0.5mm 1.2mm; border-radius: 3px; }
pre { background: #f6f8fa; border: 1px solid #d1d9e0; border-radius: 6px; padding: 3mm 4mm; white-space: pre-wrap; break-inside: avoid; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 3mm 0; break-inside: avoid; font-size: 9.5pt; }
th, td { border: 1px solid #d1d9e0; padding: 1.5mm 2mm; vertical-align: top; text-align: left; }
th { background: #f6f8fa; }
th:empty { display: none; }
thead:has(th:empty:only-child), thead:not(:has(th:not(:empty))) { display: none; }
td img { display: block; margin: 0 auto; }
img { max-width: 100%; height: auto; break-inside: avoid; }
blockquote { margin: 3mm 0; padding: 1mm 4mm; border-left: 3px solid #d1d9e0; color: #59636e; }
hr { border: 0; border-top: 1px solid #d1d9e0; margin: 6mm 0; }
`;

function buildHtml() {
  const markdown = readFileSync(SOURCE, "utf8");
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1] ?? "Handbook";
  const body = marked.parse(markdown.replace(/^#\s+.+\n/m, ""), { gfm: true, async: false });
  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${STYLE}</style></head>
<body>
<section class="cover"><h1>${title}</h1><p>ki-deck ${pkg.version}</p><p>${date}</p></section>
${unlinkFiles(inlineImages(body))}
</body></html>
`;
}

/** The newest Playwright build of a kind, e.g. chromium_headless_shell-1248. */
function playwright(kind, inner) {
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  if (!existsSync(cache)) return [];
  return readdirSync(cache)
    .filter((d) => d.startsWith(`${kind}-`))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    .flatMap((d) => inner.map((p) => join(cache, d, p)));
}

function findChrome() {
  const apps = ["/Applications", join(homedir(), "Applications")];
  const candidates = [
    process.env.CHROME,
    ...apps.flatMap((dir) => [
      join(dir, "Google Chrome.app/Contents/MacOS/Google Chrome"),
      join(dir, "Chromium.app/Contents/MacOS/Chromium"),
      join(dir, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
      join(dir, "Brave Browser.app/Contents/MacOS/Brave Browser"),
    ]),
    ...playwright("chromium_headless_shell", ["chrome-headless-shell-mac-arm64/chrome-headless-shell", "chrome-headless-shell-mac-x64/chrome-headless-shell"]),
    ...playwright("chromium", [
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    ]),
  ];
  return candidates.find((p) => p && existsSync(p));
}

mkdirSync(DIST, { recursive: true });
const htmlFile = join(DIST, "HANDBOOK.html");
const pdfFile = join(DIST, "HANDBOOK.pdf");
writeFileSync(htmlFile, buildHtml());

const chrome = findChrome();
if (!chrome) {
  console.error(
    [
      `handbook-pdf: wrote ${relative(REPO, htmlFile)}, but found no Chromium to print it.`,
      "Install Google Chrome, or set CHROME=/path/to/chrome, or download Playwright's headless Chromium:",
      "  npx playwright install chromium-headless-shell",
      `Or open ${relative(REPO, htmlFile)} in Safari and use File > Export as PDF.`,
    ].join("\n"),
  );
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "ki-deck-pdf-"));
try {
  execFileSync(
    chrome,
    [
      "--headless",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      "--no-pdf-header-footer",
      "--virtual-time-budget=5000",
      `--print-to-pdf=${pdfFile}`,
      pathToFileURL(htmlFile).href,
    ],
    { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 },
  );
} finally {
  rmSync(profile, { recursive: true, force: true });
}
if (!existsSync(pdfFile)) {
  console.error("handbook-pdf: the browser wrote no PDF");
  process.exit(1);
}
console.log(`${relative(REPO, pdfFile)}  (${(statSync(pdfFile).size / 1024).toFixed(0)} KB, printed with ${relative(homedir(), chrome).startsWith("..") ? chrome : `~/${relative(homedir(), chrome)}`})`);
