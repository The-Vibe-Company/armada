import { expect, test } from "bun:test";
import { productionAuthIo } from "../src/auth-commands.ts";
import { credsCommand } from "../src/vault-commands.ts";

test.each([
  ["claude", "claude-oauth", "synthetic-model-only-token"],
  [
    "codex",
    "codex-auth",
    '{"tokens":{"access_token":"synthetic-access","refresh_token":"synthetic-refresh","account_id":"a"}}',
  ],
])("native %s import publishes a named account without echoing secrets", async (harness, kind, value) => {
  const output: string[] = [];
  const requests: Request[] = [];
  const auth = productionAuthIo(
    { out: (text) => output.push(text), err: (text) => output.push(text) },
    { ARMADA_URL: "https://armada.example", ARMADA_TOKEN: "synthetic-armada-token" },
  );
  auth.fetch = (async (input, init) => {
    const request = new Request(String(input), init);
    requests.push(request);
    return Response.json({ account: { id: "account-id", kind, name: "Personal" } });
  }) as typeof fetch;
  expect(
    await credsCommand(["import", harness, "--name", "Personal"], {
      auth,
      readFile: async () => {
        throw Error("not used");
      },
      readStdin: async () => value,
    }),
  ).toBe(0);
  expect(requests).toHaveLength(1);
  const request = requests[0];
  if (!request) throw Error("No import request");
  expect(new URL(request.url).pathname).toBe("/api/v1/creds/accounts/set");
  expect(await request.json()).toEqual({ scope: "user", kind, name: "Personal", value });
  expect(output.join("")).not.toContain(value);
  expect(output.join("")).not.toContain("synthetic-access");
  expect(output.join("")).toContain("encrypted");
});

test("native import requires a version when replacing an existing account before reading its secret", async () => {
  let reads = 0;
  const auth = productionAuthIo({ out: () => {}, err: () => {} }, {});
  await expect(
    credsCommand(["import", "codex", "--id", "account-id"], {
      auth,
      readFile: async () => "",
      readStdin: async () => {
        reads++;
        return "{}";
      },
    }),
  ).rejects.toThrow("expected-version");
  expect(reads).toBe(0);
});
