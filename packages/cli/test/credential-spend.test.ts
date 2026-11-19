import { expect, test } from "bun:test";
import { productionAuthIo } from "../src/auth-commands.ts";
import { credsCommand } from "../src/vault-commands.ts";

test("creds list shows account exhaustion, monthly API spend, and unknown pricing", async () => {
  let output = "";
  const auth = productionAuthIo({ out: (text) => (output += text), err: () => {} }, { ARMADA_TOKEN: "test-only" });
  auth.fetch = (async (url) => {
    expect(new URL(String(url)).pathname).toBe("/api/v1/creds/list");
    return Response.json({
      user: [
        { id: "user-api", name: "Personal API", kind: "openai", status: "active" },
        {
          id: "user-sub",
          name: "Subscription",
          kind: "codex_auth",
          status: "active",
          exhaustedUntil: "2026-11-19T14:00:00.000Z",
        },
        {
          id: "zero-api",
          name: "Zero spend",
          kind: "opencode",
          status: "active",
          monthlySpend: { periodStart: "2026-11-01", usd: "0", unpricedTurns: 0 },
        },
        {
          id: "unpriced-api",
          name: "Unknown spend",
          kind: "openai",
          status: "active",
          monthlySpend: { periodStart: "2026-11-01", usd: "0", unpricedTurns: 1 },
        },
      ],
      orgs: [
        {
          name: "Team",
          role: "member",
          credentials: [
            {
              id: "org-api",
              name: "Team API",
              kind: "anthropic",
              status: "active",
              monthlySpend: { periodStart: "2026-11-01", usd: "312.00000000000000001", unpricedTurns: 2 },
            },
          ],
        },
      ],
    });
  }) as typeof fetch;
  const unused = async () => {
    throw new Error("Listing accounts requires no input");
  };

  expect(await credsCommand(["list"], { auth, readStdin: unused, readFile: unused })).toBe(0);

  const lines = output.split("\n");
  expect(lines.find((line) => line.includes("user-api"))).toContain("API: — USD this month");
  expect(lines.find((line) => line.includes("user-sub"))).toContain("exhausted until 2026-11-19 14:00 UTC");
  expect(lines.find((line) => line.includes("user-api"))).not.toContain("exhausted until");
  expect(lines.find((line) => line.includes("user-sub"))).not.toContain("USD this month");
  expect(lines.find((line) => line.includes("zero-api"))).toContain("API: 0 USD this month");
  expect(lines.find((line) => line.includes("unpriced-api"))).toContain("API: — USD this month (1 unpriced turn)");
  expect(lines.find((line) => line.includes("org-api"))).toContain(
    "API: 312.00000000000000001 USD this month (2 unpriced turns)",
  );
});
