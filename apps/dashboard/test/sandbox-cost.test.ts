import { describe, expect, test } from "bun:test";
import {
  costFigure,
  costOfRow,
  formatUsd,
  orchestratorCost,
  orchestratorCostRows,
  usageFromRow,
} from "@/lib/sandbox-cost";

const turns = (list: unknown[], turnCount: unknown = list.length) => ({ turnCount, turns: list });

describe("sandbox usage from its row", () => {
  test("compute time counts only completed intervals; malformed turns are dropped, bad counters are unknown", () => {
    const usage = usageFromRow({
      usage_runtime_seconds: 120,
      usage_running_since: null,
      usage_turns: turns([
        { promptId: "a", model: "claude-opus-5-5", inputTokens: 10, outputTokens: 5, cachedTokens: -1 },
        { model: "no-prompt" },
        "junk",
      ]),
    });
    expect(usage).toEqual({
      computeSeconds: 120,
      turnCount: 3,
      turns: [{ promptId: "a", model: "claude-opus-5-5", inputTokens: 10, outputTokens: 5, cachedTokens: null }],
    });
    expect(
      usageFromRow({ usage_runtime_seconds: 120, usage_running_since: "2026-11-10T00:00:00Z" }).computeSeconds,
    ).toBe(null);
    expect(usageFromRow({})).toEqual({ computeSeconds: null, turnCount: null, turns: [] });
  });
});

describe("cost figure", () => {
  test("no usage, an unpriced model and a priced one each read as such", () => {
    expect(costFigure(costOfRow({ harness: "claude" }, null))).toEqual({ kind: "none", text: "No usage recorded yet" });
    const unknown = { promptId: "a", model: "mystery", inputTokens: 1, outputTokens: 1, cachedTokens: 0 };
    expect(costFigure(costOfRow({ harness: "claude", usage_turns: turns([unknown]) }, null)).kind).toBe("unknown");
    const priced = { promptId: "b", model: "gpt-6.1-sol", inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0 };
    expect(costFigure(costOfRow({ harness: "codex", usage_turns: turns([priced, unknown]) }, "codex_auth"))).toEqual({
      kind: "priced",
      text: "$2.00",
      partial: true,
    });
  });

  test("tokens the harness did not report are said to be missing, not unpriced", () => {
    const missing = { promptId: "c", model: "gpt-6.1-sol", inputTokens: null, outputTokens: null, cachedTokens: null };
    expect(costFigure(costOfRow({ harness: "codex", usage_turns: turns([missing]) }, null))).toEqual({
      kind: "unknown",
      text: "Tokens not reported",
    });
  });

  test("a subscription's or an unreadable account's figure is API-equivalent, an API key's estimated", () => {
    expect(costOfRow({ harness: "claude" }, "claude_oauth").label).toBe("API-equivalent cost");
    expect(costOfRow({ harness: "claude" }, null).label).toBe("API-equivalent cost");
    expect(costOfRow({ harness: "claude" }, "anthropic").label).toBe("Estimated cost");
  });

  test("dollars to the cent, and a fraction of a cent is never shown as zero", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(0.001)).toBe("<$0.01");
    expect(formatUsd(0)).toBe("$0.00");
  });
});

describe("orchestrator cost", () => {
  test("its own and its readable workers' together; an unreadable worker is left out", () => {
    const priced = (id: string) => ({
      promptId: id,
      model: "claude-sonnet-5-5",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedTokens: 0,
    });
    const costs = new Map([
      ["own", costOfRow({ harness: "claude", usage_turns: turns([priced("a")]) }, "anthropic")],
      ["w1", costOfRow({ harness: "claude", usage_turns: turns([priced("b")]) }, "claude_oauth")],
    ]);
    const cost = orchestratorCost("own", ["w1", "w2", "w1"], costs);
    expect(cost.total.usd).toBeCloseTo(4, 10);
    expect(cost.total.label).toBe("API-equivalent cost");
    expect(cost.own?.usd).toBeCloseTo(2, 10);
    expect(cost.workers.usd).toBeCloseTo(2, 10);
    expect(Object.keys(cost.children)).toEqual(["w1"]);
    expect(costFigure(orchestratorCost(null, [], new Map()).total).kind).toBe("none");
  });

  test("workers launched since the page was read, or unreadable, are not counted and the amounts say so", () => {
    const priced = {
      promptId: "a",
      model: "claude-sonnet-5-5",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedTokens: 0,
    };
    const costs = new Map([["w1", costOfRow({ harness: "claude", usage_turns: turns([priced]) }, null)]]);
    const cost = orchestratorCost(null, ["w1"], costs);
    expect(orchestratorCostRows(cost, ["w1"])).toEqual([
      ["API-equivalent cost", "$2.00"],
      ["Its own", "No usage yet"],
      ["Its 1 worker", "$2.00"],
    ]);
    expect(orchestratorCostRows(cost, ["w1", "w2"])).toEqual([
      ["API-equivalent cost", "≥ $2.00"],
      ["Its own", "No usage yet"],
      ["Its 2 workers, 1 not counted", "≥ $2.00"],
    ]);
    expect(orchestratorCostRows(orchestratorCost(null, ["w9"], new Map()), ["w9"])).toEqual([
      ["API-equivalent cost", "Not counted"],
      ["Its own", "No usage yet"],
      ["Its 1 worker, 1 not counted", "Not counted"],
    ]);
    expect(orchestratorCostRows(orchestratorCost(null, [], new Map()), [])[2]).toEqual(["Its 0 workers", "None yet"]);
  });
});
