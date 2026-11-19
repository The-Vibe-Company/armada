import { expect, test } from "bun:test";
import { productionAuthIo } from "../src/auth-commands.ts";
import { credsCommand } from "../src/vault-commands.ts";

test("creds list shows monthly API spend and flags unknown pricing for personal and org accounts", async () => {
  let output = "";
  const auth = productionAuthIo({ out: (text) => (output += text), err: () => {} }, { ARMADA_TOKEN: "test-only" });
  auth.fetch = (async (url) => {
    expect(new URL(String(url)).pathname).toBe("/api/v1/creds/list");
    return Response.json({
      user: [
        { id: "user-api", name: "Personal API", kind: "openai", status: "active" },
        { id: "user-sub", name: "Subscription", kind: "codex_auth", status: "active" },
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
  expect(lines.find((line) => line.includes("user-sub"))).not.toContain("USD this month");
  expect(lines.find((line) => line.includes("org-api"))).toContain(
    "API: 312.00000000000000001 USD this month (2 unpriced turns)",
  );
});
