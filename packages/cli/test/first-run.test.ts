import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { firstRunIssue } from "../src/first-run.ts";

// Synthetic panes preserve the owner-recorded phrases; paths, versions and menus are invented.
const screen = (name: string) => readFile(new URL(`./fixtures/first-run/${name}.txt`, import.meta.url), "utf8");

test("recognises the owner's recorded Claude and Codex first-run screens without echoing their contents", async () => {
  for (const [name, harness, kind] of [
    ["claude-trust", "claude", "trust"],
    ["claude-mcp", "claude", "mcp"],
    ["codex-update", "codex", "update"],
    ["codex-trust", "codex", "trust"],
    ["codex-model", "codex", "model"],
  ] as const) {
    const text = await screen(name);
    const issue = firstRunIssue(harness, `\x1b[33m${text}\x1b[0m\nCANARY_private`);
    expect(issue?.kind).toBe(kind);
    expect(issue?.message).not.toContain("CANARY");
    expect(issue?.message).not.toContain("/work");
  }
});

test("checks each native harness and only recognises its own known screens", async () => {
  const claude = await screen("claude-trust");
  expect(firstRunIssue("codex", claude)).toBeNull();
  expect(firstRunIssue("opencode", claude)).toBeNull();
  expect(firstRunIssue("deepseek", "Select a provider to connect")).toMatchObject({ kind: "sign-in" });
  expect(firstRunIssue("codex", "Sign in with ChatGPT\nUse an API key")).toMatchObject({ kind: "sign-in" });
  for (const harness of ["claude", "codex", "opencode", "deepseek"] as const)
    expect(firstRunIssue(harness, "Ready to work\n> ")).toBeNull();
});
