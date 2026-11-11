import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const org = "11111111-1111-4111-8111-111111111111";
const otherOrg = "22222222-2222-4222-8222-222222222222";
const item = {
  id: "33333333-3333-4333-8333-333333333333",
  orgId: org,
  ownerId: "user",
  scope: "personal",
  name: "APP_CONFIG",
  version: 2,
  epoch: 2,
  status: "active",
  createdAt: "2026-11-11T00:00:00Z",
  updatedAt: "2026-11-11T00:00:00Z",
};
const canary = "disposable-vault-input\nsecond line\n";

async function invoke(
  argv: string[],
  options: {
    response?: unknown;
    status?: number;
    input?: string;
    inputError?: boolean;
    selected?: string | null;
    realFile?: boolean;
  } = {},
) {
  let out = "",
    err = "";
  const requests: Request[] = [];
  const inputSources: string[] = [];
  const code = await run(
    argv,
    {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    },
    {
      auth: {
        out: (text) => {
          out += text;
        },
        err: (text) => {
          err += text;
        },
        env: { ARMADA_TOKEN: "fixture-bearer", ARMADA_URL: "https://armada.example.invalid" },
        session: memorySessionStore(),
        now: () => new Date(),
        open: () => {},
        preferences: {
          read: async () => (options.selected === null ? undefined : (options.selected ?? org)),
          write: async () => {},
        },
        fetch: async (input, init) => {
          const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
          requests.push(request);
          if (request.url.endsWith("/org/list"))
            return Response.json({ orgs: [{ id: otherOrg, name: "Team", role: "admin" }] });
          return Response.json(
            options.response ?? { item: { ...item, value: canary, value_enc: canary }, value: canary },
            { status: options.status ?? 200 },
          );
        },
      },
      readStdin: async () => {
        inputSources.push("stdin");
        if (options.inputError) throw new Error(canary);
        return options.input ?? canary;
      },
      ...(options.realFile
        ? {}
        : {
            readFile: async (path: string) => {
              inputSources.push(path);
              if (options.inputError) throw new Error(canary);
              return options.input ?? canary;
            },
          }),
    },
  );
  return { code, out, err, requests, inputSources };
}

test("vault CLI uses authenticated body-only API contracts and projects metadata without values", async () => {
  const cases = [
    {
      argv: ["vars", "set", item.name],
      route: "variables/set",
      body: { org, scope: "personal", name: item.name, value: canary },
      input: "stdin",
    },
    {
      argv: ["secrets", "set", item.name, "--org", otherOrg, "--scope", "org", "--file", "input.txt"],
      route: "secrets/set",
      body: { org: otherOrg, scope: "org", name: item.name, value: canary },
      input: "input.txt",
    },
    {
      argv: ["vars", "set", item.name, "--org", otherOrg, "--scope", "personal"],
      route: "variables/set",
      body: { org: otherOrg, scope: "personal", name: item.name, value: canary },
      input: "stdin",
    },
    ...["vars", "secrets"].map((resource) => ({
      argv: [resource, "list"],
      route: `${resource === "vars" ? "variables" : resource}/list`,
      body: { org },
      response: { items: [{ ...item, value: canary, ciphertext: canary }] },
    })),
    ...["rotate", "revoke", "delete"].map((action) => ({
      argv: ["secrets", action, item.id, "--expected-version", "2"],
      route: `secrets/${action}`,
      body: { org, id: item.id, expectedVersion: 2, ...(action === "rotate" ? { value: canary } : {}) },
      ...(action === "rotate" ? { input: "stdin" } : {}),
    })),
  ];
  for (const entry of cases) {
    const argv = [...entry.argv, "--json"];
    const result = await invoke(argv, { response: "response" in entry ? entry.response : undefined });
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).not.toContain(canary);
    expect(JSON.parse(result.out)).toEqual(entry.route.endsWith("/list") ? { items: [item] } : { item });
    expect(result.requests).toHaveLength(1);
    const request = result.requests[0];
    expect(request?.url).toBe(`https://armada.example.invalid/api/v1/${entry.route}`);
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe("Bearer fixture-bearer");
    expect(await request?.json()).toEqual(entry.body);
    expect(result.inputSources).toEqual("input" in entry ? [entry.input] : []);
  }
});

test("explicit variable reads return readable bytes in plain and JSON output, while writes never echo", async () => {
  for (const value of [canary, ""]) {
    const result = await invoke(["vars", "read", item.id, "--json"], {
      response: { item: { ...item, value_enc: canary }, value },
    });
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(JSON.parse(result.out)).toEqual({ item, value });
    expect(await result.requests[0]?.json()).toEqual({ org, id: item.id });
  }
  expect((await invoke(["vars", "read", item.id])).out).toBe(canary);
  const empty = await invoke(["vars", "set", item.name], { input: "" });
  expect(empty.code).toBe(0);
  expect(await empty.requests[0]?.json()).toEqual({ org, scope: "personal", name: item.name, value: "" });
  expect(empty.out).toContain("version 2");
  expect(empty.out).not.toContain(canary);
  expect((await invoke(["secrets", "list"], { response: { items: [] } })).out).toBe("No entries.\n");
});

test("vault organization context resolves names and refuses missing context before mutation", async () => {
  const result = await invoke(["secrets", "set", item.name, "--org", "Team", "--scope", "org"]);
  expect(result.code).toBe(0);
  expect(result.requests.map((request) => new URL(request.url).pathname)).toEqual([
    "/api/v1/org/list",
    "/api/v1/secrets/set",
  ]);
  expect(await result.requests[1]?.json()).toEqual({ org: otherOrg, scope: "org", name: item.name, value: canary });
  const missing = await invoke(["vars", "list"], { selected: null });
  expect(missing.code).toBe(2);
  expect(missing.err).toContain("Select an organization");
  expect(missing.requests).toHaveLength(0);
});

test("set with explicit org refuses implicit sharing before reading input or making requests", async () => {
  for (const resource of ["vars", "secrets"]) {
    const result = await invoke([resource, "set", item.name, "--org", otherOrg]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("--scope personal|org");
    expect(result.requests).toHaveLength(0);
    expect(result.inputSources).toHaveLength(0);
    expect(result.out + result.err).not.toContain(canary);
  }
});

test("unsafe vault arguments and input failures are value-free and never reach the API", async () => {
  for (const argv of [
    ["secrets", "set", item.name, canary],
    ["vars", "set", item.name, "--value", canary],
    ["secrets", "set", item.name, `--${canary}`],
    ["secrets", "read", item.id],
    ["secrets", "rotate", item.id],
    ["secrets", "rotate", item.id, "--expected-version", canary],
    ["secrets", "delete", item.id, "--expected-version", "0"],
    ["vars", "list", "--file", canary],
    ["secrets", "set", item.name, "--scope", canary],
  ]) {
    const result = await invoke(argv);
    expect(result.code).toBe(2);
    expect(result.requests).toHaveLength(0);
    expect(result.out + result.err).not.toContain(canary);
  }
  for (const argv of [
    ["secrets", "set", item.name],
    ["vars", "set", item.name, "--file", canary],
  ]) {
    const result = await invoke(argv, { inputError: true });
    expect(result.code).toBe(2);
    expect(result.requests).toHaveLength(0);
    expect(result.err).toContain("Could not read value");
    expect(result.out + result.err).not.toContain(canary);
  }
});

test("vault API errors select actionable local messages without echoing untrusted server content", async () => {
  for (const [status, message, meaning] of [
    [400, canary, "non-reserved"],
    [401, canary, "armada login"],
    [403, canary, "only admins"],
    [404, canary, "not found"],
    [409, canary, "conflict"],
    [503, canary, "unavailable"],
    [409, "Application vault version changed.", "--expected-version"],
    [409, "Application vault resource is not active.", "Revocation is terminal"],
    [
      409,
      "An application vault name is already in use. Update or delete the existing entry; delete revoked secrets before reusing their names.",
      "Delete the old entry",
    ],
  ] as const) {
    const result = await invoke(["secrets", "rotate", item.id, "--expected-version", "2", "--json"], {
      status,
      response: { error: { code: canary, message }, value: canary },
    });
    expect(result.code).toBe(status === 400 ? 2 : 1);
    expect(result.out).toBe("");
    expect(JSON.parse(result.err).error.message).toContain(meaning);
    expect(result.err).not.toContain(canary);
  }
});

test("vault help documents secure input, scope and metadata-only JSON without authentication", async () => {
  for (const resource of ["vars", "secrets"]) {
    for (const argv of [
      [resource, "--help"],
      [resource, "set", "--help"],
    ]) {
      const result = await invoke(argv, { selected: null });
      expect(result.code).toBe(0);
      expect(result.out).toContain("piped stdin or --file");
      expect(result.out).toContain("--scope personal|org");
      expect(result.out).toContain("vars read --json includes the value");
      expect(result.requests).toHaveLength(0);
    }
  }
});

test("vault file input rejects malformed UTF-8 and preserves valid BOM and multiline bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "armada-vault-"));
  const path = join(directory, "input");
  try {
    await Bun.write(path, new Uint8Array([0xc3, 0x28]));
    const result = await invoke(["secrets", "set", item.name, "--file", path], { realFile: true });
    expect(result.code).toBe(2);
    expect(result.requests).toHaveLength(0);
    expect(result.err).toContain("Could not read value");
    expect(result.err).not.toContain(path);
    const valid = "\ufeffconfiguration\nsecond line\n";
    await Bun.write(path, valid);
    const accepted = await invoke(["vars", "set", item.name, "--file", path], { realFile: true });
    expect(accepted.code).toBe(0);
    expect(await accepted.requests[0]?.json()).toEqual({ org, scope: "personal", name: item.name, value: valid });
    expect(accepted.out).not.toContain(valid);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
