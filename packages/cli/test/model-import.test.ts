import { expect, test } from "bun:test";
import { accountCommand } from "../src/account-commands.ts";
import { productionAuthIo } from "../src/auth-commands.ts";

test.each([
  ["claude", "claude-oauth", "synthetic-model-only-token", ""],
  [
    "codex",
    "codex-auth",
    '{"tokens":{"access_token":"synthetic-access","refresh_token":"synthetic-refresh","account_id":"a"}}',
    "staging",
  ],
  ["antigravity", "antigravity", '{"token":{"access_token":"fixture-access","refresh_token":"fixture-refresh"}}', ""],
])("native %s import publishes a named account without echoing secrets", async (harness, kind, value, org) => {
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
    await accountCommand(
      [
        "import",
        harness,
        "--name",
        "Personal",
        ...(org ? ["--org", org] : []),
        ...(harness === "antigravity" ? ["--file", "token.json"] : []),
      ],
      {
        auth,
        readFile: async (path) => {
          expect(path).toBe("token.json");
          return value;
        },
        readStdin: async () => {
          if (harness === "antigravity") throw Error("Token import must use the file");
          return value;
        },
      },
    ),
  ).toBe(0);
  expect(requests).toHaveLength(1);
  const request = requests[0];
  if (!request) throw Error("No import request");
  expect(new URL(request.url).pathname).toBe("/api/v1/creds/accounts/set");
  expect(await request.json()).toEqual({
    scope: org ? "org" : "user",
    ...(org ? { org } : {}),
    kind,
    name: "Personal",
    value: harness === "antigravity" ? JSON.stringify({ method: "google", token: JSON.parse(value).token }) : value,
  });
  expect(output.join("")).not.toContain(value);
  expect(output.join("")).not.toContain("synthetic-access");
  expect(output.join("")).toContain("encrypted");
});

test("account import --json emits the server JSON receipt", async () => {
  let out = "";
  const auth = productionAuthIo(
    { out: (t) => (out += t), err: () => {} },
    { ARMADA_URL: "https://armada.example", ARMADA_TOKEN: "synthetic-armada-token" },
  );
  auth.fetch = async () => Response.json({ account: { id: "acc-1", kind: "claude-oauth", name: "Personal" } });
  expect(
    await accountCommand(["import", "claude", "--name", "Personal", "--json"], {
      auth,
      readFile: async () => "",
      readStdin: async () => "synthetic-model-only-token",
    }),
  ).toBe(0);
  expect(JSON.parse(out)).toEqual({ account: { id: "acc-1", kind: "claude-oauth", name: "Personal" } });
});

test("native import requires a version when replacing an existing account before reading its secret", async () => {
  let reads = 0;
  const auth = productionAuthIo({ out: () => {}, err: () => {} }, {});
  await expect(
    accountCommand(["import", "codex", "--id", "account-id"], {
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

test("incomplete native Codex authentication never reaches the Armada publication API", async () => {
  let requests = 0;
  const auth = productionAuthIo({ out: () => {}, err: () => {} }, { ARMADA_TOKEN: "fixture-armada" });
  auth.fetch = async () => {
    requests++;
    return Response.json({});
  };
  await expect(
    accountCommand(["import", "codex", "--name", "Rejected", "--org", "staging"], {
      auth,
      readFile: async () => "",
      readStdin: async () =>
        JSON.stringify({ tokens: { access_token: "fixture-sensitive", account_id: "fixture-account" } }),
    }),
  ).rejects.toThrow("no refresh token");
  expect(requests).toBe(0);
});

test("Antigravity account input never accepts credentials as arguments or echoes a malformed token file", async () => {
  const auth = productionAuthIo({ out: () => {}, err: () => {} }, { ARMADA_TOKEN: "fixture-armada" });
  auth.fetch = async () => {
    throw Error("Unexpected credential request");
  };
  const fail = async () => {
    throw Error("Unexpected credential read");
  };
  const key = "fixture-private-value";
  for (const verb of ["add", "import"]) {
    await expect(accountCommand([verb, "antigravity", key], { auth, readStdin: fail, readFile: fail })).rejects.toThrow(
      `Run armada account ${verb}`,
    );
  }
  const result = await accountCommand(["import", "antigravity", "--name", "Google", "--file", "token.json"], {
    auth,
    readStdin: fail,
    readFile: async () => JSON.stringify({ token: { access_token: key } }),
  }).catch((error: unknown) => String(error));
  expect(result).toContain("Invalid Antigravity credential");
  expect(result).not.toContain(key);
});

test("Antigravity account add publishes a key read from a private file", async () => {
  const output: string[] = [];
  const auth = productionAuthIo(
    { out: (text) => output.push(text), err: (text) => output.push(text) },
    {
      ARMADA_URL: "https://armada.example",
      ARMADA_TOKEN: "fixture-armada",
    },
  );
  const apiKey = "fixture-gemini-key";
  let posted = false;
  auth.fetch = async (input, init) => {
    const req = new Request(String(input), init);
    expect(new URL(req.url).pathname).toBe("/api/v1/creds/accounts/set");
    expect(await req.json()).toEqual({
      scope: "user",
      kind: "antigravity",
      name: "Gemini",
      value: JSON.stringify({ method: "gemini-api-key", apiKey }),
    });
    posted = true;
    return Response.json({ ok: true });
  };
  expect(
    await accountCommand(["add", "antigravity", "--name", "Gemini", "--file", "gemini.key"], {
      auth,
      readFile: async (path) => {
        expect(path).toBe("gemini.key");
        return apiKey;
      },
      readStdin: async () => {
        throw Error("Must read the explicitly selected file");
      },
    }),
  ).toBe(0);
  expect(posted).toBe(true);
  expect(output.join("")).not.toContain(apiKey);
});
