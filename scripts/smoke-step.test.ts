import { expect, test } from "bun:test";
import { timedSmokeStep } from "./smoke-step.ts";

test("probe timing preserves results and failures and reports their individual duration", async () => {
  for (const fails of [false, true]) {
    let clock = 100;
    const failure = new Error("probe_failed");
    const reports: unknown[] = [];
    const result = timedSmokeStep(
      async () => {
        clock += 37;
        if (fails) throw failure;
        return "receipt";
      },
      () => clock,
      (elapsedMs, error) => reports.push({ elapsedMs, error }),
    );
    if (fails) await expect(result).rejects.toBe(failure);
    else expect(await result).toBe("receipt");
    expect(reports).toEqual([{ elapsedMs: 37, error: fails ? failure : undefined }]);
  }
});
