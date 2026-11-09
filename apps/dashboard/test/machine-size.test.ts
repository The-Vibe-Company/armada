import { describe, expect, test } from "bun:test";
import type { MachineSizePolicy } from "@armada/core";
import {
  defaultOptionLabel,
  describeDefault,
  goldenSizing,
  isSizePolicyResult,
  launchDefault,
  policyFromForm,
  policySummary,
  sizeCaveat,
  sizeOptions,
  sizePolicyBlocker,
  sizeSpec,
} from "../src/lib/machine-size.ts";

const policy: MachineSizePolicy = { version: 1, golden: "medium", repositories: { api: "large" } };

describe("machine sizes in the launch dialog", () => {
  test("each provider shows its own units: Boat vCPU and disk, Modal physical cores with limits", () => {
    expect(sizeOptions("boat").map((option) => option.label)).toEqual([
      "Small · 2 vCPU · 4 GiB",
      "Medium · 4 vCPU · 8 GiB",
      "Large · 8 vCPU · 16 GiB",
      "Extra large · 16 vCPU · 32 GiB",
    ]);
    expect(sizeOptions("modal").map((option) => option.label)).toEqual([
      "Small · 1 physical core · 4 GiB",
      "Medium · 2 physical cores · 8 GiB",
      "Large · 4 physical cores · 16 GiB",
      "Extra large · 8 physical cores · 32 GiB",
    ]);
    expect(sizeSpec("boat", "xlarge")).toBe("16 vCPU · 32 GiB · 251 GB disk");
    expect(sizeSpec("modal", "small")).toBe("1 physical core (2 vCPU) · 4 GiB, capped");
  });

  test("the default follows the selected repository, then the golden, then the provider's own", () => {
    const repository = launchDefault("boat", policy, "api");
    expect(repository).toMatchObject({ effective: "large", source: "repository", requested: null });
    expect(describeDefault("boat", repository)).toBe("Large, the default for api");
    expect(defaultOptionLabel("boat", repository)).toBe("Default · Large (repository)");

    const golden = launchDefault("modal", policy, "web");
    expect(golden).toMatchObject({ effective: "medium", source: "golden" });
    expect(describeDefault("modal", golden)).toBe("Medium, the golden's default");
    expect(launchDefault("boat", policy, "")).toMatchObject({ source: "golden", repositoryDir: null });
    // A policy from JSON is a plain object: a directory named like a prototype key has no default of its own.
    const parsed = JSON.parse(JSON.stringify(policy)) as MachineSizePolicy;
    expect(launchDefault("boat", parsed, "constructor")).toMatchObject({ effective: "medium", source: "golden" });
  });

  test("with no policy no size is invented: the provider decides and Armada says it does not record it", () => {
    const legacy = launchDefault("modal", null, "api");
    expect(legacy).toMatchObject({ effective: null, source: "legacy", capacity: null });
    expect(describeDefault("modal", legacy)).toBe(
      "No default set: Modal uses its own size, which Armada does not record",
    );
    expect(defaultOptionLabel("modal", legacy)).toBe("Default (Modal decides)");
  });

  test("an override warns of the provider outcome that can refuse it, never of a silent change", () => {
    expect(sizeCaveat("boat", null)).toBeNull();
    expect(sizeCaveat("boat", "xlarge")).toBe("Extra large needs a Boat plan that includes it.");
    expect(sizeCaveat("boat", "small")).toBe("Boat refuses a size whose disk cannot hold the golden.");
    expect(sizeCaveat("modal", "xlarge")).toMatch(/same label on Boat is a different machine/);
  });

  test("the defaults form submits a full policy, refusing an unknown size instead of dropping it", () => {
    const form = (fields: Record<string, string>) => (name: string) => fields[name] ?? "";
    expect(
      policyFromForm(form({ golden_size: "medium", "size:api": "large", "size:web": "" }), ["api", "web"]),
    ).toEqual({
      ok: true,
      policy: { version: 1, golden: "medium", repositories: { api: "large" } },
    });
    expect(policyFromForm(form({}), ["api"])).toEqual({
      ok: true,
      policy: { version: 1, golden: null, repositories: {} },
    });
    expect(policyFromForm(form({ "size:api": "huge" }), ["api"])).toMatchObject({ ok: false });
  });

  test("a stored policy is offered only once the server has the column, and an invalid one is shown, not guessed", () => {
    expect(goldenSizing({}, ["api"])).toEqual({ kind: "unsupported" });
    expect(goldenSizing({ size_policy: null }, ["api"])).toEqual({ kind: "ready", policy: null });
    expect(goldenSizing({ size_policy: policy }, ["api"])).toMatchObject({
      kind: "ready",
      policy: { golden: "medium" },
    });
    expect(goldenSizing({ size_policy: policy }, ["web"])).toEqual({
      kind: "unreadable",
      reason: "Unknown configured repository directory.",
    });
    expect(policySummary("boat", policy)).toBe("Golden: Medium · api: Large");
    expect(policySummary("modal", null)).toBe("No defaults: Modal decides");
  });

  test("only the owner of a private golden or an org admin edits defaults, as the server checks", () => {
    const viewer = { id: "u1", isAdmin: false };
    expect(sizePolicyBlocker({ visibility: "private", owner_id: "u1" }, viewer)).toBeNull();
    expect(sizePolicyBlocker({ visibility: "private", owner_id: "u2" }, { ...viewer, isAdmin: true })).toBe(
      "Only its owner changes its size defaults.",
    );
    expect(sizePolicyBlocker({ visibility: "org", owner_id: "u1" }, viewer)).toBe(
      "Only an org admin changes an org golden's size defaults.",
    );
    expect(sizePolicyBlocker({ visibility: "org", owner_id: "u2" }, { ...viewer, isAdmin: true })).toBeNull();
  });

  test("the size-policy answer is checked before it is trusted", () => {
    const answer = { goldenId: "g", provider: "modal", repositories: [], policy: null };
    expect(isSizePolicyResult(answer)).toBe(true);
    expect(isSizePolicyResult({ ...answer, provider: "aws" })).toBe(false);
    expect(isSizePolicyResult({ ...answer, policy: { version: 2 } })).toBe(false);
  });
});
