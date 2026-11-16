import { expect, test } from "bun:test";
import { productionAuthIo } from "../src/auth-commands.ts";
import { run } from "../src/run.ts";

test.each([
  ["--max-agents", "2", 2],
  ["--unlimited", undefined, null],
] as const)("model limit %s preserves the exact launch identifier and JSON response", async (flag, value, limit) => {
  const output: string[] = [];
  const auth = productionAuthIo(
    { out: (text) => output.push(text), err: (text) => output.push(text) },
    { ARMADA_URL: "https://armada.example", ARMADA_TOKEN: "test_token" },
  );
  const response = { modelLimits: limit === null ? {} : { "armada/deployment": limit } };
  auth.fetch = (async (input, init) => {
    const request = new Request(String(input), init);
    expect(new URL(request.url).pathname).toEndWith("/creds/accounts/limits");
    expect(await request.json()).toEqual({
      scope: "user",
      id: "account_id",
      model: "armada/deployment",
      maxAgents: limit,
    });
    return Response.json(response);
  }) as typeof fetch;
  const args = [
    "creds",
    "limits",
    "account_id",
    "--model",
    "armada/deployment",
    flag,
    ...(value ? [value] : []),
    "--json",
  ];
  expect(await run(args, { out: auth.out, err: auth.err }, { auth })).toBe(0);
  expect(JSON.parse(output.join(""))).toEqual(response);
});
