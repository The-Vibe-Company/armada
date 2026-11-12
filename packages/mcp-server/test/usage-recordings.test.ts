import { expect, test } from "bun:test";
import { type AgentEvent, reportedTurnUsage, sandboxCost, sumSandboxUsage, withUsageTotals } from "@armada/core";
import claude from "./fixtures/sandbox-usage/boat-claude.json";
import codex from "./fixtures/sandbox-usage/boat-codex.json";
import modalClaude from "./fixtures/sandbox-usage/modal-claude-usage.json";
import modalResume from "./fixtures/sandbox-usage/modal-codex-resume.json";
import modal from "./fixtures/sandbox-usage/modal-codex-usage.json";

// Protect the production distinction: a finished Boat turn is not evidence of zero token cost.
test.each([{ events: claude }, { events: codex }])(
  "recorded Boat turns count but missing token reports remain unknown",
  ({ events }) => {
    const collected = reportedTurnUsage(events as AgentEvent[]);
    expect(collected).toEqual({ turnCount: 1, turns: [] });
    expect(withUsageTotals({ computeSeconds: null, ...collected })?.tokenTotals).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      incomplete: true,
    });
  },
);

test("recorded Modal usage survives replay and totals never treat unreported fields or children as zero", () => {
  const collected = reportedTurnUsage([...modal, ...modal] as AgentEvent[]);
  const usage = { computeSeconds: 12, ...collected };
  // The recorded turn predates cache-write reporting. Pricing must not erase
  // input that the native harness did report when an independent bucket is missing.
  const cost = sandboxCost(usage, "codex", "api_equivalent");
  expect(cost.tokens).toEqual({ input: 13136, cached: 0, cacheWrite: null, output: 5 });
  expect(cost.turns[0]).toMatchObject({ inputTokens: 13136, cacheWriteTokens: null, usd: null, unknown: "tokens" });
  expect(cost.usd).toBeNull();

  expect(withUsageTotals(usage)?.tokenTotals).toEqual({
    inputTokens: 13136,
    outputTokens: 5,
    cachedTokens: 0,
    cacheWriteTokens: null,
    reasoningTokens: null,
    incomplete: true,
  });
  expect(sumSandboxUsage([usage, usage])).toEqual({
    computeSeconds: 24,
    turnCount: 2,
    inputTokens: 26272,
    outputTokens: 10,
    cachedTokens: 0,
    cacheWriteTokens: null,
    reasoningTokens: null,
  });
  expect(sumSandboxUsage([usage, null]).inputTokens).toBeNull();
  expect(sumSandboxUsage([]).inputTokens).toBe(0);
  expect(withUsageTotals({ ...usage, turnCount: 2 })?.tokenTotals).toMatchObject({
    inputTokens: 13136,
    incomplete: true,
  });
});

test("recorded Modal Claude result retains cache creation and thinking tokens per turn and in totals", () => {
  const collected = reportedTurnUsage([...modalClaude, ...modalClaude] as AgentEvent[]);
  expect(collected).toEqual({
    turnCount: 1,
    turns: [
      {
        promptId: modalClaude[0]!.promptId,
        model: "claude-opus-5-5",
        inputTokens: 2,
        outputTokens: 4,
        cachedTokens: 0,
        cacheWriteTokens: 19047,
        reasoningTokens: 0,
      },
    ],
  });
  expect(withUsageTotals({ computeSeconds: null, ...collected })?.tokenTotals).toEqual({
    inputTokens: 2,
    outputTokens: 4,
    cachedTokens: 0,
    cacheWriteTokens: 19047,
    reasoningTokens: 0,
    incomplete: false,
  });
});

// Real Modal public event recording: the native wire trace has a separate driver
// owner. Duplicate collection must neither charge a resume's historical total
// nor erase the measured first turn from the public session subtotal.
test("recorded Modal stop/resume retains known subtotals and marks unknown coverage", () => {
  const collected = reportedTurnUsage([...modalResume, ...modalResume] as AgentEvent[]);
  const usage = { computeSeconds: null, ...collected, turnCount: 2 };
  expect(usage.turns).toHaveLength(2);
  expect(usage.turns[1]).toMatchObject({
    promptId: "b2c27dd7",
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
  });
  const totals = withUsageTotals(usage)?.tokenTotals;
  expect(totals).toEqual({
    inputTokens: 13212,
    outputTokens: 5,
    cachedTokens: 0,
    cacheWriteTokens: 13209,
    reasoningTokens: 0,
    incomplete: true,
  });
  expect(withUsageTotals(withUsageTotals(usage))?.tokenTotals).toEqual(totals);
});
