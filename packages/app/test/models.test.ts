import { expect, test } from "bun:test";
import type { AuthFrame } from "@armada/protocol";
import {
  applyAuthFrame,
  type CatalogProvider,
  contextLabel,
  markOf,
  modelLabel,
  pickerGroups,
  projectOverride,
  providerOrder,
  providerState,
  selectionLabel,
  startSignIn,
} from "../src/settings/models";

// Settings › Coordinator's pure rules (THE-2070) on a synthetic catalog: the
// providers' order and state words, a model's label, the picker's groups and
// search, a project's override from its rules, a sign-in read from its frames.

const version = { major: 1, minor: 9 };
const model = (id: string, name: string, reasoning = false, contextWindow = 200_000) => ({
  id,
  name,
  reasoning,
  contextWindow,
  inputCost: 0,
  outputCost: 0,
});
const provider = (
  id: string,
  name: string,
  status: CatalogProvider["status"],
  auth: Partial<CatalogProvider["auth"]> = {},
  models = [model(`${id}-one`, `${name} One`)],
): CatalogProvider => ({
  id,
  name,
  status,
  auth: { oauth: false, apiKey: true, envVars: [], ...auth },
  models,
});

const skiff = provider("skiff", "Skiff", "unconfigured");
const ketch = provider("ketch", "Ketch", "unconfigured", { oauth: true });
const brig = provider("brig", "Brig", "key-set");
const yawl = provider("yawl", "Yawl", "env");
const sloop = provider("sloop", "Sloop", "signed-in", { oauth: true }, [
  model("sloop-deep", "Sloop Deep", true, 400_000),
  model("sloop-swift", "Sloop Swift", false, 1_048_576),
]);

test("providers: connected and configured first, then those with a sign-in, then by name", () => {
  expect(providerOrder([skiff, ketch, yawl, sloop, brig]).map((p) => p.id)).toEqual([
    "brig",
    "sloop",
    "yawl",
    "ketch",
    "skiff",
  ]);
});

test("a provider's state in a word on its dot: green when connected, grey from the environment, none otherwise", () => {
  expect(providerState(sloop)).toEqual({ word: "Signed in", ink: "text-green", dot: "bg-green" });
  expect(providerState(brig)).toEqual({ word: "Key set", ink: "text-green", dot: "bg-green" });
  expect(providerState(yawl)).toEqual({ word: "From environment", ink: "text-text-2", dot: "bg-text-3" });
  expect(providerState(skiff)).toBeNull();
});

test("a model reads its name, whether it reasons and its context in k or M", () => {
  expect(contextLabel(400_000)).toBe("400k");
  expect(contextLabel(1_048_576)).toBe("1M");
  expect(contextLabel(1_500_000)).toBe("1.5M");
  expect(contextLabel(0)).toBe("");
  expect(modelLabel(model("sloop-deep", "Sloop Deep", true, 400_000))).toEqual({
    name: "Sloop Deep",
    reasoning: true,
    context: "400k",
    text: "Sloop Deep, reasoning, 400k context",
  });
  // A model without a name reads its id.
  expect(modelLabel(model("raw-id", "", false, 0)).text).toBe("raw-id");
});

test("the picker groups models by provider, usable first; the others dimmed with why; search narrows by every word", () => {
  const groups = pickerGroups([skiff, sloop, ketch]);
  expect(groups.map((g) => [g.provider.id, g.available, g.reason, g.models.map((m) => m.id)])).toEqual([
    ["sloop", true, null, ["sloop-deep", "sloop-swift"]],
    ["ketch", false, "Connect first", ["ketch-one"]],
    ["skiff", false, "Connect first", ["skiff-one"]],
  ]);
  expect(pickerGroups([skiff, sloop], "sloop deep").map((g) => g.models.map((m) => m.id))).toEqual([["sloop-deep"]]);
  // The provider's name matches too; a group nothing matches leaves.
  expect(pickerGroups([skiff, sloop], "SKIFF").map((g) => g.provider.id)).toEqual(["skiff"]);
  expect(pickerGroups([skiff, sloop], "nothing")).toEqual([]);
});

test("a selection reads the model's name, else what the daemon said; a plugin's reads its kind and model", () => {
  expect(selectionLabel({ provider: "sloop", model: "sloop-deep" }, [sloop])).toBe("Sloop Deep");
  expect(selectionLabel({ provider: "sloop", model: "gone" }, [sloop])).toBe("sloop/gone");
  expect(selectionLabel({ kind: "openai-compatible", config: { model: "local-7b" } }, [])).toBe(
    "openai-compatible · local-7b",
  );
  expect(selectionLabel(null, [sloop])).toBeNull();
});

test("a project's override comes from its folded rules; none, or one that does not parse, is the default", () => {
  const state = (coordinatorModel: unknown) => ({ rules: { revision: 2, value: { coordinatorModel } } });
  expect(projectOverride(state({ provider: "sloop", model: "sloop-deep" }))).toEqual({
    provider: "sloop",
    model: "sloop-deep",
  });
  expect(projectOverride(state(undefined))).toBeNull();
  expect(projectOverride(state({ provider: 7 }))).toBeNull();
  expect(projectOverride({})).toBeNull();
  expect(projectOverride(undefined)).toBeNull();
});

test("each maker's providers wear its mark; any other the generic one", () => {
  expect(
    ["openai-codex", "openai", "anthropic", "google-vertex", "xai", "mistral", "github-copilot", "openrouter"].map(
      markOf,
    ),
  ).toEqual(["openai", "openai", "anthropic", "google", "xai", "mistral", "github", "openrouter"]);
  expect(markOf("skiff")).toBe("generic");
  // A prefix alone is not the maker.
  expect(markOf("openaix")).toBe("generic");
});

test("a sign-in reads its frames: the page, the device code, progress and a prompt; terminal output is not shown", () => {
  const event = (e: Extract<AuthFrame, { type: "auth.event" }>["event"]): AuthFrame => ({
    type: "auth.event",
    version,
    flow: "r4",
    event: e,
  });
  let view = startSignIn("sloop");
  view = applyAuthFrame(view, event({ type: "auth_url", url: "https://auth.example.test/authorize?x=1" }));
  view = applyAuthFrame(
    view,
    event({ type: "device_code", userCode: "WXYZ-1234", verificationUri: "https://auth.example.test/device" }),
  );
  view = applyAuthFrame(view, event({ type: "progress", message: "Waiting for the browser" }));
  view = applyAuthFrame(
    view,
    event({ type: "info", message: "Almost there", links: [{ url: "https://help.example.test/" }] }),
  );
  view = applyAuthFrame(view, event({ type: "terminal", output: "typed secret" }));
  const prompt: AuthFrame = {
    type: "auth.prompt",
    version,
    id: "p1",
    flow: "r4",
    promptType: "select",
    message: "Which workspace?",
  };
  view = applyAuthFrame(view, prompt);
  expect(view).toEqual({
    provider: "sloop",
    url: "https://auth.example.test/authorize?x=1",
    instructions: null,
    device: { code: "WXYZ-1234", uri: "https://auth.example.test/device" },
    lines: ["Waiting for the browser", "Almost there"],
    links: [{ url: "https://help.example.test/", label: "https://help.example.test/" }],
    prompt,
    error: null,
  });
  expect(JSON.stringify(view)).not.toContain("typed secret");
});
