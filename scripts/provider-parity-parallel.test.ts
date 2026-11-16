import { expect, test } from "bun:test";
import { providerParitySmoke } from "./provider-parity-smoke.ts";
import { STAGING_ORIGIN } from "./smoke-sandbox-cleanup.ts";

test("both providers enter independently and settle into one failing report without losing sibling evidence", async () => {
  const entered = new Set<string>();
  const lines: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = providerParitySmoke(
    {
      ARMADA_URL: STAGING_ORIGIN,
      ARMADA_TOKEN: "smoke_placeholder",
      ARMADA_SMOKE: "create_real_compute",
      ARMADA_SMOKE_CASES: JSON.stringify(
        ["modal", "docker"].map((provider) => ({
          provider,
          org: provider,
          harness: "codex",
          model: "model",
          modelAccountId: "account",
          golden: "snapshot",
          hostId: "host",
        })),
      ),
    },
    {
      now: () => 0,
      sleep: async () => {
        throw new Error("unexpected_poll");
      },
      out: (line) => lines.push(line),
      fetch: async (url, init) => {
        if (url.endsWith("/healthz")) return Response.json({});
        entered.add(JSON.parse(String(init.body)).org);
        await barrier;
        return Response.json({ error: { code: "forbidden" } }, { status: 403 });
      },
    },
    [],
  );
  try {
    // Flush promise continuations, not wall-clock time. A serial runner remains
    // blocked on its first provider until the barrier is released below.
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    expect([...entered].sort()).toEqual(["docker", "modal"]);
  } finally {
    release();
    await result;
  }
  expect(await result).toBe(false);
  const reports = lines.flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value.step === "provider_parity" ? [value] : [];
    } catch {
      return [];
    }
  });
  expect(reports).toHaveLength(1);
  expect(reports[0].starts).toBe(0);
  for (const provider of ["modal", "docker"]) {
    expect(
      Object.values(reports[0].features).some(
        (row) => (row as Record<string, { status: string }>)[provider]?.status === "fail",
      ),
    ).toBe(true);
  }
  expect(lines.filter((line) => line === "boat: not part of the release gate")).toHaveLength(1);
});
