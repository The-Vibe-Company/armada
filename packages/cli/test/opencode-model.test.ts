import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Io } from "../src/io.ts";
import { verifyOpenCodeModel } from "../src/opencode-model.ts";

// Identity fields recorded from OpenCode 1.18.34 on 2026-10-03. Provider
// options, keys and unrelated catalog fields are deliberately not retained.
const metadata = readFileSync(new URL("./fixtures/opencode-models.txt", import.meta.url), "utf8");
const providers = readFileSync(new URL("./fixtures/opencode-providers.json", import.meta.url), "utf8");
const deepseek = "Build · DeepSeek V4.1 Flash OpenCode Zen";
const gemini = "Build · Gemini 3.1 Pro Preview OpenCode Zen";
const fallback = "Build · GLM-5.3-Flash Z.AI Coding Plan";

function probe(panes: string[], catalog = providers, config = "{}") {
  let clock = 0;
  let reads = 0;
  const io: Io = {
    cwd: "/work",
    env: {},
    readFile: async () => null,
    stdout: () => {},
    stderr: () => {},
    ghToken: () => null,
    now: () => new Date(clock),
    sleep: async (ms: number) => {
      clock += ms;
    },
    exec: async (command: string, args: string[]) => {
      if (command === "opencode")
        return {
          code: 0,
          stdout: args[0] === "models" ? metadata : args[1] === "config" ? config : catalog,
          stderr: "",
        };
      reads++;
      return { code: 0, stdout: panes[Math.min(reads - 1, panes.length - 1)] ?? "", stderr: "" };
    },
  };
  return { io, reads: () => reads, elapsed: () => clock };
}

test("recorded DeepSeek and Gemini footers resolve model AND provider display names", async () => {
  for (const [id, footer] of [
    ["opencode/deepseek-v4.1-flash", deepseek],
    ["opencode/gemini-3.1-pro", gemini],
    ["opencode-go/deepseek-v4.1-flash", deepseek.replace("OpenCode Zen", "OpenCode Go")],
  ]) {
    const f = probe([footer ?? ""]);
    await verifyOpenCodeModel(f.io, "w8:p9", id ?? "");
    expect(f.reads()).toBe(1);
  }
});

test("splash screen is polled until the recorded footer appears", async () => {
  const f = probe(["OpenCode", "", deepseek]);
  await verifyOpenCodeModel(f.io, "w8:p9", "opencode/deepseek-v4.1-flash");
  expect(f.reads()).toBe(3);
  expect(f.elapsed()).toBe(500);
});

test("GLM fallback and the same model on another provider are real mismatches", async () => {
  for (const footer of [fallback, deepseek.replace("OpenCode Zen", "OpenCode Go")]) {
    const f = probe([footer]);
    await expect(verifyOpenCodeModel(f.io, "w8:p9", "opencode/deepseek-v4.1-flash")).rejects.toThrow(
      "differs from profile",
    );
    expect(f.reads()).toBe(1);
  }
});

test("unknown provider, model-name prefix, and command echoes never verify", async () => {
  for (const footer of [
    deepseek.replace("OpenCode Zen", "Unknown Provider"),
    deepseek.replace("Flash OpenCode", "Flash Extra OpenCode"),
    "opencode --model opencode/deepseek-v4.1-flash\nDeepSeek V4.1 Flash OpenCode Zen",
  ]) {
    const f = probe([footer]);
    await expect(verifyOpenCodeModel(f.io, "w8:p9", "opencode/deepseek-v4.1-flash")).rejects.toThrow(
      "could not verify",
    );
    expect(f.reads()).toBe(20);
    expect(f.elapsed()).toBe(5_000);
  }
});

test("unavailable provider catalog fails closed without surfacing metadata", async () => {
  const f = probe([deepseek], "CANARY_private_provider_key");
  await expect(verifyOpenCodeModel(f.io, "w8:p9", "opencode/deepseek-v4.1-flash")).rejects.toThrow("could not verify");
});

// `debug v2` uses a separate catalog; the interactive TUI still applies V1
// provider-name overrides from its resolved configuration.
test("resolved provider display-name overrides match the TUI identity", async () => {
  const f = probe(
    [deepseek.replace("OpenCode Zen", "Custom Provider")],
    providers,
    JSON.stringify({ provider: { opencode: { name: "Custom Provider" } } }),
  );
  await verifyOpenCodeModel(f.io, "w8:p9", "opencode/deepseek-v4.1-flash");
  expect(f.reads()).toBe(1);
});
