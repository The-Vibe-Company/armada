import { describe, expect, test } from "bun:test";
import { costFigure, costOfRow, formatUsd, usageFromRow } from "@/lib/sandbox-cost";

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
    expect(costFigure(costOfRow({}, null))).toEqual({ kind: "none", text: "No usage recorded yet" });
    const unknown = { promptId: "a", model: "mystery", inputTokens: 1, outputTokens: 1, cachedTokens: 0 };
    expect(costFigure(costOfRow({ usage_turns: turns([unknown]) }, null)).kind).toBe("unknown");
    const priced = { promptId: "b", model: "gpt-6.1-sol", inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0 };
    expect(costFigure(costOfRow({ usage_turns: turns([priced, unknown]) }, "codex_auth"))).toEqual({
      kind: "priced",
      text: "$2.00",
      partial: true,
    });
  });

  test("a subscription's figure is API-equivalent, an API key's estimated", () => {
    expect(costOfRow({}, "claude_oauth").label).toBe("API-equivalent cost");
    expect(costOfRow({}, "anthropic").label).toBe("Estimated cost");
  });

  test("dollars to the cent, and a fraction of a cent is never shown as zero", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(0.001)).toBe("<$0.01");
    expect(formatUsd(0)).toBe("$0.00");
  });
});
