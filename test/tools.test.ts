import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { categorize, describe as describeCall, gateCategory, redact, summarize } from "../src/bridge/tools";

describe("gateCategory (which tools Kiro's gate hooks run for)", () => {
  it.each([
    ["execute_bash", "shell"],
    ["control_bash_process", "shell"],
    ["get_process_output", "shell"],
    ["fs_write", "write"],
    ["str_replace", "write"],
    ["delete_file", "write"],
    ["create_artifact", "write"],
    ["mcp_postgres_query", "mcp"],
    ["list_processes", undefined], // checked live: Kiro runs no gate hook for these
    ["smart_relocate", undefined],
    ["semantic_rename", undefined],
    ["read_file", undefined],
    ["web_fetch", undefined],
  ])("%s -> %s", (name, gate) => {
    expect(gateCategory(name)).toBe(gate);
  });
});

describe("describe (the whole request, for the banner)", () => {
  it("keeps every line of a command, redacted", () => {
    expect(describeCall("execute_bash", { command: "cd app &&\n  TOKEN=abc123 npm   publish" })).toBe("cd app && ⏎ TOKEN=••• npm publish");
  });

  it("shows the full path, with ~ for home", () => {
    expect(describeCall("fs_write", { path: `${homedir()}/code/shop/src/index.ts`, text: "x" })).toBe("~/code/shop/src/index.ts");
  });

  it("shows other tools with their input, and clips long text", () => {
    expect(describeCall("mcp_db_query", { sql: "select 1" })).toBe('mcp_db_query {"sql":"select 1"}');
    const long = describeCall("execute_bash", { command: "echo hi ".repeat(100) }, 20);
    expect(long).toHaveLength(20);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("categorize", () => {
  it.each([
    ["execute_bash", "shell"],
    ["shell", "shell"],
    ["control_bash_process", "shell"],
    ["fs_write", "write"],
    ["str_replace", "write"],
    ["fs_append", "write"],
    ["delete_file", "write"],
    ["smart_relocate", "write"],
    ["read_file", "read"],
    ["grep_search", "read"],
    ["file_search", "read"],
    ["list_directory", "read"],
    ["web_fetch", "web"],
    ["remote_web_search", "web"],
    ["mcp_postgres_query", "mcp"],
    ["invoke_sub_agent", "other"],
  ])("%s is %s", (name, category) => {
    expect(categorize(name)).toBe(category);
  });
});

describe("summarize", () => {
  it("uses the first line of a command", () => {
    expect(summarize("execute_bash", { command: "npm test\necho done" })).toBe("npm test");
  });

  it("shortens paths to parent/name", () => {
    expect(summarize("fs_write", { path: "/Users/me/project/src/index.ts", text: "..." })).toBe("src/index.ts");
  });

  it("falls back to the tool name", () => {
    expect(summarize("invoke_sub_agent", { prompt: "x" })).toBe("invoke_sub_agent");
    expect(summarize("tool", "not an object")).toBe("tool");
  });
});

describe("redact", () => {
  it("masks credential shapes", () => {
    expect(redact("curl -H 'Authorization: Bearer abc.def' x")).toBe("curl -H 'Authorization: Bearer •••' x");
    expect(redact("export API_KEY=supersecret")).toBe("export API_KEY=•••");
    expect(redact("gh auth login --with-token ghp_abcdefghijklmnop1234")).toBe("gh auth login --with-token •••");
    expect(redact("echo AKIAABCDEFGHIJKLMNOP")).toBe("echo •••");
  });

  it("leaves ordinary commands alone", () => {
    expect(redact("git status --short")).toBe("git status --short");
  });
});
