import { describe, expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const token = "armada_sk_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12";
const response = {
  sandbox: {
    id: "11111111-1111-4111-8111-111111111111",
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
  promptId: "prompt",
  conversationId: "conversation",
  ttlSeconds: 1800,
  expiresAt: "2026-11-08T16:00:00.000Z",
  github: { status: "not_connected", login: null, message: "Connect GitHub." },
};

describe("launch through the Armada API", () => {
  for (const selection of [undefined, [], ["chosen"]] as const) {
    for (const repo of [undefined, "ACME/web", "defaults-only"]) {
      test(`works with ARMADA_TOKEN and a clean HOME (repo: ${repo ?? "omitted"}, selection: ${JSON.stringify(selection)})`, async () => {
        const machineSize =
          repo === undefined
            ? null
            : {
                version: 1,
                requested: "large",
                effective: "large",
                source: "override",
                repositoryDir: "web",
                capacity: null,
              };
        const calls: Request[] = [];
        let out = "";
        const code = await run(
          [
            "launch",
            "web",
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
            ...(repo === undefined ? [] : repo === "defaults-only" ? ["--sized"] : ["--repo", repo, "--size", "large"]),
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
                return Response.json({
                  ...response,
                  sandbox: {
                    ...response.sandbox,
                    machineSize,
                    ...(repo === undefined ? {} : { provider: "boat", providerSandboxId: "bx_server" }),
                  },
                });
              },
              now: () => new Date(),
              open: () => undefined,
              session: memorySessionStore(),
            },
          },
        );
        expect(code).toBe(0);
        expect(JSON.parse(out)).toMatchObject({
          machineSize,
          golden: "web",
          credentialId: "33333333-3333-4333-8333-333333333333",
          credentialVersion: 7,
          harness: "codex",
          promptId: "prompt",
          provider: "boat",
          providerSandboxId: "bx_server",
          boatId: "bx_server",
          id: "11111111-1111-4111-8111-111111111111",
          expiresAt: "2026-11-08T16:00:00.000Z",
        });
        expect(calls).toHaveLength(1);
        const launchRequest = calls.at(-1);
        expect(launchRequest?.url).toBe(
          `https://armada.thevibecompany.co/api/v1/sandbox/${repo === undefined ? "launch" : "launch-sized-v1"}`,
        );
        expect(launchRequest?.headers.get("authorization")).toBe(`Bearer ${token}`);
        expect(await launchRequest?.json()).toEqual({
          skills: ["example/notes@1.0.0", "other@2.0.0"],
          golden: "web",
          ...(repo === undefined
            ? { credentialId: "33333333-3333-4333-8333-333333333333" }
            : repo === "defaults-only"
              ? { sizePolicyVersion: 1 }
              : { repo, size: "large", sizePolicyVersion: 1 }),
          ...(selection === undefined ? {} : { connections: [...selection] }),
          model: "gpt-6.1-sol",
          reasoningEffort: "medium",
          harness: "codex",
          prompt: "do it",
          ttlSeconds: 1800,
          org: "org",
        });
      });
    }
  }

  test("decodes serialized expiry for text output without hiding a created sandbox", async () => {
    let out = "";
    const code = await run(
      ["launch", "web", "--agent", "codex", "do it", "--ttl", "30m"],
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
  test("invalid or repeated launch size fails before requesting allocation", async () => {
    for (const flags of [["--size", "huge"], ["--size"], ["--size", "small", "--size", "large"]]) {
      let calls = 0;
      let out = "";
      const code = await run(
        ["launch", "web", "--agent", "codex", ...flags],
        { out: (text) => (out += text), err: () => undefined },
        {
          auth: {
            out: () => undefined,
            err: () => undefined,
            env: { ARMADA_TOKEN: token },
            session: memorySessionStore(),
            now: () => new Date(),
            open: () => undefined,
            fetch: async () => {
              calls++;
              throw new Error("unexpected request");
            },
          },
        },
      );
      expect(code).toBe(2);
      expect(calls).toBe(0);
      expect(out).toBe("");
    }
  });
  test("explicit override refuses older servers before allocation instead of silently ignoring size", async () => {
    const calls: Request[] = [];
    let out = "";
    const code = await run(
      ["launch", "web", "--agent", "codex", "--size", "large"],
      {
        out: (text) => {
          out += text;
        },
        err: () => undefined,
      },
      {
        auth: {
          out: () => undefined,
          err: () => undefined,
          env: { ARMADA_TOKEN: token },
          session: memorySessionStore(),
          now: () => new Date(),
          open: () => undefined,
          fetch: async (input, init) => {
            calls.push(new Request(String(input), init));
            return Response.json({ error: { message: "Unknown API route." } }, { status: 404 });
          },
        },
      },
    );
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toEndWith("/api/v1/sandbox/launch-sized-v1");
  });
  test("mixed-version launch retains created sandbox JSON and warns when override evidence is missing", async () => {
    let out = "";
    let err = "";
    let calls = 0;
    const code = await run(
      ["launch", "web", "--agent", "codex", "--size", "large", "--json"],
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
          session: memorySessionStore(),
          now: () => new Date(),
          open: () => undefined,
          fetch: async () => {
            calls++;
            return Response.json(response);
          },
        },
      },
    );
    expect(code).toBe(0);
    expect(calls).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ id: response.sandbox.id, machineSize: null });
    expect(JSON.parse(err).warning.code).toBe("size_unconfirmed");
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

test("launch skips only default skills when explicitly requested, preserving pins on normal and sized routes", async () => {
  for (const sized of [false, true]) {
    for (const skip of [false, true]) {
      const calls: Request[] = [];
      const code = await run(
        [
          "launch",
          "web",
          "--agent",
          "codex",
          "--skill",
          "review-code@2.1.0",
          "--json",
          ...(sized ? ["--sized"] : []),
          ...(skip ? ["--no-default-skills"] : []),
        ],
        { out: () => {}, err: () => {} },
        {
          auth: {
            out: () => {},
            err: () => {},
            env: { ARMADA_TOKEN: token },
            session: memorySessionStore(),
            now: () => new Date(),
            open: () => {},
            fetch: async (input, init) => {
              calls.push(input instanceof Request ? new Request(input, init) : new Request(String(input), init));
              return Response.json({
                ...response,
                sandbox: {
                  ...response.sandbox,
                  ...(sized ? { machineSize: null } : {}),
                },
              });
            },
          },
        },
      );
      expect(code).toBe(0);
      expect(calls).toHaveLength(1);
      const body = (await calls[0]?.json()) as Record<string, unknown>;
      expect(body.skills).toEqual(["review-code@2.1.0"]);
      if (skip) expect(body.skipSkillDefaults).toBe(true);
      else expect(body).not.toHaveProperty("skipSkillDefaults");
    }
  }
});
