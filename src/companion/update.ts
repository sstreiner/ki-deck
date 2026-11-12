// Kiro keeps running an extension's old copy in every open window until that window reloads,
// so after an update the companion in an old window keeps observing only (0.1.0) or misses
// fixes. The companion looks for a newer installed copy of itself and offers the reload.
// No `vscode` import here, so it is unit-tested directly.

/** `[major, minor, patch]` of "1.2.3"; missing parts are 0, anything else is not a version. */
export function parseVersion(value: string): [number, number, number] | undefined {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : undefined;
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/**
 * The newest version among installed extension folders named `<id>-<version>` that is newer
 * than `current`, or undefined. Kiro installs each version into its own folder.
 */
export function newerInstalled(folderNames: readonly string[], id: string, current: string): string | undefined {
  const prefix = `${id}-`;
  const versions = folderNames
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length).replace(/-.*$/, "")) // "0.3.0" or "0.3.0-universal"
    .filter((v) => parseVersion(v) !== undefined && compareVersions(v, current) > 0)
    .sort(compareVersions);
  return versions.at(-1);
}
