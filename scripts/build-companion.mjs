#!/usr/bin/env node
// Packs the Kiro companion extension (extension/) into a .vsix that `kiro --install-extension`
// accepts. A .vsix is a zip: [Content_Types].xml, extension.vsixmanifest, extension/*.
// Run after `npm run build`, which bundles extension/dist/extension.js.
// No dependencies beyond Node.js and macOS's /usr/bin/zip.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(REPO, "extension");
const pkg = JSON.parse(readFileSync(join(EXT, "package.json"), "utf8"));
const FILES = ["package.json", "dist/extension.js"];
const out = join(EXT, `${pkg.name}-${pkg.version}.vsix`);

for (const f of FILES) {
  if (!existsSync(join(EXT, f))) {
    console.error(`missing extension/${f}: run npm run build first`);
    process.exit(1);
  }
}

const xml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>
`;

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(pkg.name)}" Version="${xml(pkg.version)}" Publisher="${xml(pkg.publisher)}" />
    <DisplayName>${xml(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${xml(pkg.description)}</Description>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`;

const stage = mkdtempSync(join(tmpdir(), "kiro-companion-"));
try {
  writeFileSync(join(stage, "[Content_Types].xml"), contentTypes);
  writeFileSync(join(stage, "extension.vsixmanifest"), manifest);
  for (const f of FILES) {
    mkdirSync(dirname(join(stage, "extension", f)), { recursive: true });
    copyFileSync(join(EXT, f), join(stage, "extension", f));
  }
  rmSync(out, { force: true }); // zip adds to an existing archive instead of replacing it
  execFileSync("/usr/bin/zip", ["-q", "-X", "-r", out, "[Content_Types].xml", "extension.vsixmanifest", "extension"], { cwd: stage });
} finally {
  rmSync(stage, { recursive: true, force: true });
}
console.log(`${relative(REPO, out)}  (${pkg.publisher}.${pkg.name} ${pkg.version})`);
