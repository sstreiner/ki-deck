#!/usr/bin/env node
// @ts-check
// Entry point of the installer (scripts/install/core.mjs). From the repository, run it through
// scripts/install.sh. A packaged plugin's setup runs it with Stream Deck's Node from setup/.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { install } from "./install/core.mjs";
import { macos } from "./install/macos.mjs";

if (process.platform !== "darwin") {
  console.error("install: macOS only for now (MULTIOS.md has the plan for Windows)");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = homedir();

/** Resolves once everything written to stdout so far has been flushed, so child output follows it. */
const flushed = () => new Promise((resolve) => process.stdout.write("", () => resolve(undefined)));

/** @type {import("./install/core.mjs").Runner} */
const run = async (cmd, args, options = {}) => {
  if (options.inherit) await flushed();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ ok: false, stdout, stderr: stderr || error.message }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
  });
};

/** Asks one question. End of input (Ctrl-D) counts as no; Ctrl-C stops the installer, as in a shell. @param {string} question @returns {Promise<string>} */
const ask = (question) =>
  new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("SIGINT", () => {
      process.stdout.write("\n");
      process.exit(130);
    });
    let answered = false;
    rl.on("close", () => {
      if (!answered) process.stdout.write("\n");
      resolve("");
    });
    rl.question(question, (answer) => {
      answered = true;
      resolve(answer);
      rl.close();
    });
  });

process.exitCode = await install(process.argv.slice(2), {
  root,
  home,
  env: process.env,
  nodeVersion: process.versions.node,
  interactive: Boolean(process.stdin.isTTY),
  ask,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  run,
  platform: macos(home, process.env),
});
