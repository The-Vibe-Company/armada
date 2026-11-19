import { describe, expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const token = "armada_sk_fixture_token";
const response = {
  sandbox: {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "boat",
    providerSandboxId: "bx_server",
    boatId: "bx_server",
    goldenId: "golden",
    orgId: "org",
    ownerId: "owner",
    credentialId: "33333333-3333-4333-8333-333333333333",
    credentialVersion: 7,
    harness: "codex",
    status: "running",
    conversationIds: ["conversation"],
    createdAt: "2026-01-01T00:00:00.000Z",
    stoppedAt: null,
    deletedAt: null,
  },
  golden: {
    id: "golden",
    name: "web",
    orgId: "org",
    visibility: "private",
    ownerId: "owner",
    boatSnapshotId: "snapshot",
    boatSandboxId: null,
    config: { repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  runtime: null,
  helper: null,
  promptId: "prompt",
  conversationId: "conversation",
  ttlSeconds: 1800,
  expiresAt: "2026-11-08T16:00:00.000Z",
  github: { status: "not_connected", login: null, message: "Connect GitHub." },
};

describe("launch through the Armada API", () => {
  for (const selection of [undefined, [], ["chosen"]] as const) {
    for (const repo of [undefined, "ACME/web"]) {
      test(`works with ARMADA_TOKEN and a clean HOME (repo: ${repo ?? "omitted"}, selection: ${JSON.stringify(selection)})`, async () => {
        const machineSize =
          repo === undefined
            ? null
            : {
                version: 1,
                requested: null,
                effective: "large",
                source: "repository",
                repositoryDir: "web",
                capacity: null,
              };
        const calls: Request[] = [];
        let out = "";
        const code = await run(
          [
            "launch",
            "web",
            "--provider",
            "boat",
            "--agent",
            "codex",
            "do it",
            "--skill",
            "example/notes@1.0.0",
            "--skill",
            "other@2.0.0",
            "--ttl",
            "30m",
            "--org",
            "org",
            "--json",
            ...(repo === undefined ? ["--credential-id", "33333333-3333-4333-8333-333333333333"] : []),
            ...(repo === undefined ? [] : ["--repo", repo]),
            ...(selection === undefined
              ? []
              : selection.length
                ? ["--connections", selection.join(",")]
                : ["--no-connections"]),
          ],
          { out: (text) => (out += text), err: () => undefined },
          {
            auth: {
              out: () => undefined,
              err: () => undefined,
              env: { ARMADA_TOKEN: token },
              fetch: async (input, init) => {
                const request = input instanceof Request ? input : new Request(String(input), init);
                calls.push(request);
                return Response.json({ ...response, sandbox: { ...response.sandbox, machineSize } });
              },
              now: () => new Date(),
              open: () => undefined,
              session: memorySessionStore(),
            },
          },
        );
        expect(code).toBe(0);
        expect(JSON.parse(out)).toEqual({ ...response, sandbox: { ...response.sandbox, machineSize } });
        expect(calls).toHaveLength(1);
        const launchRequest = calls.at(-1);
        expect(launchRequest?.url).toBe(`https://armada.thevibecompany.co/api/v1/sandbox/launch`);
        expect(launchRequest?.headers.get("authorization")).toBe(`Bearer ${token}`);
        expect(await launchRequest?.json()).toEqual({
          skills: ["example/notes@1.0.0", "other@2.0.0"],
          provider: "boat",
          golden: "web",
          ...(repo === undefined ? { credentialId: "33333333-3333-4333-8333-333333333333" } : { repo }),
          ...(selection === undefined ? {} : { connections: [...selection] }),
          harness: "codex",
          prompt: "do it",
          ttlSeconds: 1800,
          org: "org",
        });
      });
    }
  }

  test("keeps delegated access in the Modal JSON envelope", async () => {
    const receipt = {
      ...response,
      sandbox: { ...response.sandbox, provider: "modal", providerSandboxId: "sb-server", boatId: null },
      runtime: { kind: "armada", epoch: "1" },
      armadaAccess: { enabled: true, maxActiveChildren: 2 },
    };
    let out = "";
    const code = await run(
      ["launch", "web", "--provider", "modal", "--agent", "codex", "--armada-access", "--json"],
      { out: (text) => (out += text), err: () => undefined },
      {
        auth: {
          out: () => undefined,
          err: () => undefined,
          env: { ARMADA_TOKEN: token },
          fetch: async () => Response.json(receipt),
          now: () => new Date(),
          open: () => undefined,
          session: memorySessionStore(),
        },
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual(receipt);
  });

  test("decodes serialized expiry for text output without hiding a created sandbox", async () => {
    let out = "";
    const code = await run(
      ["launch", "web", "--provider", "boat", "--agent", "codex", "do it", "--ttl", "30m"],
      { out: (text) => (out += text), err: () => undefined },
      {
        auth: {
          out: () => undefined,
          err: () => undefined,
          env: { ARMADA_TOKEN: token },
          fetch: async () => Response.json(response),
          now: () => new Date(),
          open: () => undefined,
          session: memorySessionStore(),
        },
      },
    );
    expect(code).toBe(0);
    expect(out).toContain("Sandbox: 11111111-1111-4111-8111-111111111111");
    expect(out).not.toContain("Size:");
    expect(out).toContain("Stops by itself at 2026-11-08T16:00:00.000Z (TTL 1800s).");
  });
  test("retired launch sizing flags are rejected before allocation", async () => {
    for (const [option, ...values] of [["--size", "large"], ["--sized"]] as const) {
      let calls = 0;
      let err = "";
      const unexpectedRequest = () => {
        calls++;
        throw new Error("unexpected request");
      };
      const code = await run(
        ["launch", "web", "--provider", "boat", "--agent", "codex", "--org", "org", option, ...values],
        { out: () => undefined, err: (text) => (err += text) },
        {
          env: { ARMADA_TOKEN: token },
          fetch: Object.assign(unexpectedRequest, { preconnect: unexpectedRequest }),
        },
      );
      expect(code).toBe(2);
      expect(err).toContain(`Unknown option '${option}'`);
      expect(calls).toBe(0);
    }
  });
});

// The parser must preserve producer-owned defaults: omitted, explicit and empty are distinct.
for (const visibility of [undefined, "private", "org"]) {
  for (const selection of [undefined, "selected", "none"]) {
    test(`launch keeps connection selection ${selection ?? "default"} with legacy visibility ${visibility ?? "omitted"}`, async () => {
      let body: Record<string, unknown> = {};
      let out = "",
        err = "";
      const code = await run(
        [
          "launch",
          "web",
          "--provider",
          "boat",
          "--agent",
          "codex",
          "--json",
          ...(visibility ? ["--visibility", visibility] : []),
          ...(selection === "selected"
            ? ["--connections", "connection-a,connection-b"]
            : selection === "none"
              ? ["--no-connections"]
              : []),
        ],
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
            out: () => undefined,
            err: () => undefined,
            env: { ARMADA_TOKEN: token },
            fetch: async (_input, init) => {
              body = JSON.parse(String(init?.body));
              return Response.json(response);
            },
            now: () => new Date(),
            open: () => undefined,
            session: memorySessionStore(),
          },
        },
      );
      expect(code).toBe(0);
      expect(body).not.toHaveProperty("visibility");
      if (selection === undefined) expect(body).not.toHaveProperty("connections");
      else expect(body.connections).toEqual(selection === "none" ? [] : ["connection-a", "connection-b"]);
      expect(JSON.parse(out)).not.toHaveProperty("visibility");
      expect(err.includes("deprecated and ignored")).toBe(visibility !== undefined);
    });
  }
}

test("repository authorization refusal keeps no_credentials and the reconnect remedy in CLI JSON", async () => {
  let errors = "";
  const code = await run(
    ["launch", "web", "--provider", "boat", "--agent", "codex", "--json"],
    { out: () => {}, err: (text) => (errors += text) },
    {
      auth: {
        out: () => {},
        err: () => {},
        env: { ARMADA_TOKEN: token },
        session: memorySessionStore(),
        now: () => new Date(),
        open: () => {},
        fetch: async () =>
          Response.json(
            {
              error: {
                code: "no_credentials",
                message: "Repository private needs a GitHub connection with read access. Run armada github connect.",
              },
            },
            { status: 400 },
          ),
      },
    },
  );
  expect(code).toBe(2);
  const failure = JSON.parse(errors.trim().split("\n").at(-1)!);
  expect(failure.error.code).toBe("no_credentials");
  expect(failure.error.message).toContain("Repository private");
  expect(failure.error.message).toContain("armada github connect");
});
