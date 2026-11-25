import { describe, expect, test } from "bun:test";
import { costModelsLabel, displayedSandboxModel, turnModelDisplay, turnModelLabel } from "./sandbox-model";

describe("displayedSandboxModel", () => {
  test("humanizes pre-turn default alias to Account default", () => {
    expect(displayedSandboxModel("antigravity", "default", [])).toBe("Account default");
    expect(displayedSandboxModel("antigravity", "default")).toBe("Account default");
    expect(displayedSandboxModel("codex", "default", [])).toBe("Account default");
  });

  test("prefers concrete executed model(s) over default or null requested model", () => {
    expect(displayedSandboxModel("antigravity", "default", ["gemini-4-neon-high"])).toBe("gemini-4-neon-high");
    expect(
      displayedSandboxModel("antigravity", "default", ["default", "gemini-4-neon-high", "gemini-4-neon-high"]),
    ).toBe("gemini-4-neon-high");
    expect(displayedSandboxModel("claude", null, ["claude-opus-5-5", "claude-haiku-5-5"])).toBe(
      "claude-opus-5-5, claude-haiku-5-5",
    );
  });

  test("ignores legacy usage_turns containing only default", () => {
    expect(displayedSandboxModel("antigravity", "default", ["default"])).toBe("Account default");
    expect(displayedSandboxModel("antigravity", null, ["default"])).toBeNull();
    expect(displayedSandboxModel("codex", null, [])).toBeNull();
  });

  test("preserves an explicit requested model choice", () => {
    expect(displayedSandboxModel("antigravity", "gemini-4-neon-high", [])).toBe("gemini-4-neon-high");
    expect(displayedSandboxModel("claude", "claude-opus-5-5", ["claude-opus-5-5", "claude-haiku-5-5"])).toBe(
      "claude-opus-5-5",
    );
  });
});

describe("costModelsLabel and turnModelLabel", () => {
  test("filters legacy default when concrete models exist and humanizes default-only entries", () => {
    expect(costModelsLabel(["default", "gemini-4-neon-high"])).toBe("gemini-4-neon-high");
    expect(costModelsLabel(["default"])).toBe("Account default");
    expect(costModelsLabel([])).toBe("Not reported");
    expect(turnModelLabel("default")).toBe("Account default");
    expect(turnModelLabel("gemini-4-neon-high")).toBe("gemini-4-neon-high");
    expect(turnModelLabel(null)).toBe("Model not reported");
  });
});

describe("turnModelDisplay", () => {
  test("displays concrete executed model directly when requestedModel is default", () => {
    expect(
      turnModelDisplay({
        requestedModel: "default",
        observedModel: "gemini-4-neon-high",
        modelSelectionReason: "model_selection_unverified",
        modelSelectionMessage: "Unverified",
      }),
    ).toEqual({ kind: "model", model: "gemini-4-neon-high" });
  });

  test("keeps unverified notice and humanizes default when observed model is missing or default", () => {
    expect(
      turnModelDisplay({
        requestedModel: "default",
        observedModel: "default",
        modelSelectionReason: "model_selection_unverified",
        modelSelectionMessage: "Unverified",
      }),
    ).toEqual({
      kind: "notice",
      summary: "The model could not be verified",
      requestedModel: "Account default",
      observedModel: null,
      message: "Unverified",
    });
  });

  test("preserves explicit verified and mismatch turn-model states", () => {
    expect(turnModelDisplay({ requestedModel: "claude-opus-5-5", observedModel: "claude-opus-5-5" })).toEqual({
      kind: "reported",
      model: "claude-opus-5-5",
    });
    expect(
      turnModelDisplay({
        requestedModel: "claude-opus-5-5",
        observedModel: "claude-sonnet-5-5",
        modelSelectionReason: "model_selection_mismatch",
        modelSelectionMessage: "Mismatch",
      }),
    ).toEqual({
      kind: "notice",
      summary: "The agent used a different model",
      requestedModel: "claude-opus-5-5",
      observedModel: "claude-sonnet-5-5",
      message: "Mismatch",
    });
  });
});
