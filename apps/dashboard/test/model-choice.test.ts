import { describe, expect, test } from "bun:test";
import { launchArgs, OTHER_MODEL, sendOverride } from "../src/lib/model-choice.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const form = { golden: "web", provider: "boat", org: ORG, prompt: "", model: "", otherModel: "", reasoningEffort: "" };

describe("model choice from the dashboard forms", () => {
  test("a launch always names the model and effort, the harness defaults when nothing is chosen", () => {
    expect(launchArgs({ ...form, harness: "claude" })).toEqual({
      ok: true,
      args: {
        golden: "web",
        provider: "boat",
        org: ORG,
        harness: "claude",
        model: "claude-opus-5-5",
        reasoning_effort: "medium",
      },
    });
    expect(launchArgs({ ...form, harness: "codex", prompt: "  Fix it " })).toMatchObject({
      args: { model: "gpt-6.1-sol", reasoning_effort: "medium", prompt: "Fix it" },
    });
    expect(
      launchArgs({
        ...form,
        harness: "codex",
        model: OTHER_MODEL,
        otherModel: "gpt-7-preview",
        reasoningEffort: "ultra",
      }),
    ).toMatchObject({ args: { model: "gpt-7-preview", reasoning_effort: "ultra" } });
  });

  test("a launch the model cannot run is refused with what it accepts", () => {
    const refused = launchArgs({ ...form, harness: "codex", model: "gpt-6-luna", reasoningEffort: "ultra" });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? "" : refused.error).toContain("low, medium, high, xhigh, max");
    expect(launchArgs({ ...form, harness: "opencode" })).toMatchObject({ ok: false });
    expect(launchArgs({ ...form, harness: "claude", provider: "elsewhere" })).toMatchObject({ ok: false });
  });

  test("a send keeps the launch choice unless a field is set, and an effort alone applies to the launch model", () => {
    expect(sendOverride("codex", { model: "", otherModel: "", reasoningEffort: "" }, "gpt-6-luna")).toEqual({
      ok: true,
      args: {},
    });
    expect(sendOverride("codex", { model: "", otherModel: "", reasoningEffort: "high" }, "gpt-6-luna")).toEqual({
      ok: true,
      args: { reasoning_effort: "high" },
    });
    expect(sendOverride("codex", { model: "", otherModel: "", reasoningEffort: "ultra" }, "gpt-6-luna")).toMatchObject({
      ok: false,
    });
    expect(sendOverride("claude", { model: "claude-sonnet-5-5", otherModel: "", reasoningEffort: "" }, null)).toEqual({
      ok: true,
      args: { model: "claude-sonnet-5-5" },
    });
  });
});

describe("the launch repository", () => {
  test("a chosen owner/repo is sent as repo; none keeps the legacy launch", () => {
    expect(launchArgs({ ...form, harness: "claude", repo: " acme/web " })).toMatchObject({
      ok: true,
      args: { repo: "acme/web" },
    });
    const legacy = launchArgs({ ...form, harness: "claude", repo: "" });
    expect(legacy.ok && "repo" in legacy.args).toBe(false);
    expect(launchArgs({ ...form, harness: "claude", repo: "acme/web; rm -rf /" })).toMatchObject({ ok: false });
    expect(launchArgs({ ...form, harness: "claude", repo: "https://github.com/acme/web" })).toMatchObject({
      ok: false,
    });
  });
});

describe("the launch machine size", () => {
  test("an explicit size is sent; none leaves the default to the server; an unknown one is refused", () => {
    expect(launchArgs({ ...form, harness: "claude", size: "xlarge" })).toMatchObject({ args: { size: "xlarge" } });
    const resolved = launchArgs({ ...form, harness: "claude", size: "" });
    expect(resolved.ok && "size" in resolved.args).toBe(false);
    expect(launchArgs({ ...form, harness: "claude", size: "huge" })).toEqual({
      ok: false,
      error: "Choose a machine size from the list.",
    });
  });
});
