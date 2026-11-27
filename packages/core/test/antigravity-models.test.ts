import { describe, expect, test } from "bun:test";
import { HARNESS_CAPABILITIES, HARNESS_CATALOG, LaunchError, MODEL_CATALOG, resolveModelChoice } from "../src/index.ts";

describe("Antigravity catalog and reasoning effort selection", () => {
  test("advertises reasoningEffort capability and base Gemini 4 models with per-model efforts", () => {
    expect(HARNESS_CATALOG.antigravity.capabilities.reasoningEffort).toBe(true);
    expect(HARNESS_CAPABILITIES.antigravity.reasoningEffort).toBe(true);
    expect(MODEL_CATALOG.antigravity).toEqual({
      defaultModel: "default",
      defaultReasoningEffort: "default",
      reasoningEfforts: ["default", "low", "medium", "high", "xhigh"],
      models: [
        { id: "default", label: "Account default", reasoningEfforts: ["default", "low", "medium", "high", "xhigh"] },
        {
          id: "gemini-4-neon",
          label: "Gemini 4 Neon",
          reasoningEfforts: ["default", "low", "medium", "high", "xhigh"],
        },
        {
          id: "gemini-4-hydrogen",
          label: "Gemini 4 Hydrogen",
          reasoningEfforts: ["default", "low", "medium", "high", "xhigh"],
        },
        { id: "gemini-4-argon", label: "Gemini 4 Argon", reasoningEfforts: ["default", "low", "medium", "high"] },
        { id: "gemini-4-carbon", label: "Gemini 4 Carbon", reasoningEfforts: ["default", "low", "medium", "high"] },
      ],
    });
  });

  test("resolves defaults and per-model effort bounds for Antigravity", () => {
    expect(resolveModelChoice("antigravity", {})).toEqual({ model: "default", reasoningEffort: "default" });
    expect(resolveModelChoice("antigravity", { model: "gemini-4-neon" })).toEqual({
      model: "gemini-4-neon",
      reasoningEffort: "default",
    });
    expect(resolveModelChoice("antigravity", { model: "gemini-4-neon", reasoningEffort: "high" })).toEqual({
      model: "gemini-4-neon",
      reasoningEffort: "high",
    });
    expect(resolveModelChoice("antigravity", { model: "gemini-4-hydrogen", reasoningEffort: "xhigh" })).toEqual({
      model: "gemini-4-hydrogen",
      reasoningEffort: "xhigh",
    });
    expect(resolveModelChoice("antigravity", { model: "gemini-4-argon", reasoningEffort: "high" })).toEqual({
      model: "gemini-4-argon",
      reasoningEffort: "high",
    });
    expect(resolveModelChoice("antigravity", { model: "gemini-4-carbon", reasoningEffort: "high" })).toEqual({
      model: "gemini-4-carbon",
      reasoningEffort: "high",
    });

    for (const model of ["gemini-4-argon", "gemini-4-carbon"] as const) {
      expect(() => resolveModelChoice("antigravity", { model, reasoningEffort: "xhigh" })).toThrow(LaunchError);
      expect(() => resolveModelChoice("antigravity", { model, reasoningEffort: "xhigh" })).toThrow(
        `That reasoning effort is not available for ${model}. Use one of: default, low, medium, high.`,
      );
    }

    expect(
      resolveModelChoice(
        "antigravity",
        { model: "gemini-4-carbon" },
        { model: "gemini-4-neon", reasoningEffort: "xhigh" },
      ),
    ).toEqual({ model: "gemini-4-carbon", reasoningEffort: "default" });
  });
});
