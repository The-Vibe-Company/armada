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
  for (const repo of [undefined, "ACME/web"]) {
    test(`works with ARMADA_TOKEN and a clean HOME (repo: ${repo ?? "omitted"})`, async () => {
      const calls: Request[] = [];
      let out = "";
      const code = await run(
        [
          "launch",
          "web",
          "--agent",
          "codex",
          "do it",
          "--ttl",
          "30m",
          "--org",
          "org",
          "--json",
          ...(repo === undefined ? [] : ["--repo", repo]),
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
              return Response.json(response);
            },
            now: () => new Date(),
            open: () => undefined,
            session: memorySessionStore(),
          },
        },
      );
      expect(code).toBe(0);
      expect(JSON.parse(out)).toMatchObject({
        golden: "web",
        harness: "codex",
        promptId: "prompt",
        provider: "boat",
        providerSandboxId: "bx_server",
        boatId: "bx_server",
        id: "11111111-1111-4111-8111-111111111111",
        expiresAt: "2026-11-08T16:00:00.000Z",
      });
      expect(calls[0]?.url).toBe("https://armada.thevibecompany.co/api/v1/sandbox/launch");
      expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(await calls[0]?.json()).toEqual({
        golden: "web",
        ...(repo === undefined ? {} : { repo }),
        model: "gpt-6.1-sol",
        reasoningEffort: "medium",
        harness: "codex",
        prompt: "do it",
        ttlSeconds: 1800,
        org: "org",
      });
    });
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
    expect(out).toContain("Stops by itself at 2026-11-08T16:00:00.000Z (TTL 1800s).");
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
