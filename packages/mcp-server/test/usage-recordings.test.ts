import { expect, test } from "bun:test";
import { type AgentEvent, reportedTurnUsage, sumSandboxUsage, withUsageTotals } from "@armada/core";
import claude from "./fixtures/sandbox-usage/boat-claude.json";
import codex from "./fixtures/sandbox-usage/boat-codex.json";
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
    });
  },
);

test("recorded Modal usage survives replay and totals never treat unreported fields or children as zero", () => {
  const collected = reportedTurnUsage([...modal, ...modal] as AgentEvent[]);
  const usage = { computeSeconds: 12, ...collected };
  expect(withUsageTotals(usage)?.tokenTotals).toEqual({
    inputTokens: 13136,
    outputTokens: 5,
    cachedTokens: 0,
    cacheWriteTokens: null,
    reasoningTokens: null,
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
  expect(withUsageTotals({ ...usage, turnCount: 2 })?.tokenTotals?.inputTokens).toBeNull();
});
