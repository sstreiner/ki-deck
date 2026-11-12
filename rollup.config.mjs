// Bundles src/plugin.ts into the plugin folder, as the official Stream Deck template does, and
// src/companion/extension.ts into the Kiro companion extension.
// Not minified, so stack traces in the logs stay readable. tsconfig.build.json leaves out the
// JavaScript that tsconfig.json type-checks (the installer), which the bundles do not contain.
import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const sdPlugin = "net.streiner.ki-deck.sdPlugin";

/** @type {import('rollup').RollupOptions[]} */
export default [
  {
    input: "src/plugin.ts",
    output: { file: `${sdPlugin}/bin/plugin.js`, sourcemap: true },
    plugins: [
      // Only the extension entry needs `vscode`; deck sessions share the permission parser (ask.ts).
      typescript({ tsconfig: "tsconfig.build.json", include: ["src/**/*.ts"], exclude: ["test/**", "src/companion/extension.ts"] }),
      nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
      commonjs(),
      {
        name: "emit-module-package-file",
        generateBundle() {
          this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
        },
      },
    ],
  },
  {
    // Kiro loads extensions as CommonJS; `vscode` is provided by Kiro at runtime.
    input: "src/companion/extension.ts",
    output: { file: "extension/dist/extension.js", format: "cjs", sourcemap: true },
    external: ["vscode"],
    plugins: [
      typescript({ tsconfig: "tsconfig.build.json", include: ["src/companion/**/*.ts"], exclude: ["test/**"] }),
      nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
    ],
  },
];
