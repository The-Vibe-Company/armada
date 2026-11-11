import { expect, test } from "bun:test";
import { usageRevision } from "@/lib/usage-revision";

test("usage refresh identity follows observations, not elapsed time or serialization order", () => {
  const row = { promptId: "a", model: "gpt", inputTokens: 13136, outputTokens: 5, cachedTokens: 0 };
  const other = { ...row, promptId: "b" };
  const before = { turnCount: 2, turns: [row, other], computeSeconds: 12 };
  const key = usageRevision(before);
  expect(
    usageRevision({
      ...before,
      computeSeconds: 14,
      tokenTotals: {},
      turns: [{ ...other, cacheWriteTokens: null }, row],
    }),
  ).toBe(key);
  expect(usageRevision({ ...before, turns: [{ ...row, inputTokens: 13137 }, other] })).not.toBe(key);
  expect(usageRevision({ ...before, turns: [{ ...row, model: "new-model" }, other] })).not.toBe(key);
  expect(usageRevision({ ...before, turnCount: 3 })).not.toBe(key);
});
