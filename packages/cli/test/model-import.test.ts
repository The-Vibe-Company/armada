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

test("holder inspection and explicit release use the account revision and confirmed sandbox without reading secrets", async () => {
  const requests: Request[] = [];
  const output: string[] = [];
  const auth = productionAuthIo(
    { out: (text) => output.push(text), err: () => {} },
    { ARMADA_URL: "https://armada.example", ARMADA_TOKEN: "synthetic-armada-token" },
  );
  auth.fetch = (async (input, init) => {
    requests.push(new Request(String(input), init));
    return Response.json({ sandboxId: "holder", status: "failed", storedVersion: 1, reason: "Reconnect first" });
  }) as typeof fetch;
  const io = {
    auth,
    readFile: async () => {
      throw Error("unexpected secret read");
    },
    readStdin: async () => {
      throw Error("unexpected secret read");
    },
  };
  await credsCommand(["holders", "account", "--expected-version", "2"], io);
  expect(output.join("")).toContain("Reconnect first");
  await expect(credsCommand(["release", "account", "--expected-version", "2"], io)).rejects.toThrow("--sandbox-id");
  expect(requests).toHaveLength(1);
  await credsCommand(["release", "account", "--expected-version", "2", "--sandbox-id", "holder"], io);
  expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
    "/api/v1/creds/accounts/holder",
    "/api/v1/creds/accounts/release",
  ]);
  expect(await requests[1]!.json()).toEqual({ id: "account", scope: "user", version: 2, sandboxId: "holder" });
});
