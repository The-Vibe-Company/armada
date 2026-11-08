import { describe, expect, test } from "bun:test";
import { memorySessionStore } from "../src/session.ts";
import { run } from "../src/run.ts";

const token = "armada_sk_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12";

function apiFetch(calls: Request[]) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    calls.push(request);
    return Response.json({
      goldens: [
        {
          name: "web",
          orgId: "11111111-1111-4111-8111-111111111111",
          visibility: "org",
          ownerId: "22222222-2222-4222-8222-222222222222",
          boatSnapshotId: "snapshot",
          boatSandboxId: null,
          repos: 1,
          config: { repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] },
        },
      ],
    });
  };
}

describe("golden list through the Armada API", () => {
  test("uses the default API with a token-only clean HOME", async () => {
    const calls: Request[] = [];
    let out = "";
    let err = "";
    const code = await run(
      ["golden", "list"],
      { out: (text) => (out += text), err: (text) => (err += text) },
      {
        auth: {
          out: () => undefined,
          err: () => undefined,
          env: { ARMADA_TOKEN: token },
          fetch: apiFetch(calls),
          now: () => new Date(),
          open: () => undefined,
          session: memorySessionStore(),
        },
      },
    );
    expect(code).toBe(0);
    expect(out).toContain("web  org  snapshot  1 repo");
    expect(err).toBe("");
    expect(calls[0]?.url).toBe("https://armada.thevibecompany.co/api/v1/golden/list");
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${token}`);
  });

  test("uses ARMADA_URL, preserves JSON, and sends requested org to the server", async () => {
    const calls: Request[] = [];
    let out = "";
    const code = await run(
      ["golden", "list", "--json", "--org", "Example"],
      { out: (text) => (out += text), err: () => undefined },
      {
        auth: {
          out: () => undefined,
          err: () => undefined,
          env: { ARMADA_TOKEN: token, ARMADA_URL: "https://override.armada.test" },
          fetch: apiFetch(calls),
          now: () => new Date(),
          open: () => undefined,
          session: memorySessionStore(),
        },
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(out)[0]).toMatchObject({ name: "web", visibility: "org" });
    expect(calls[0]?.url).toBe("https://override.armada.test/api/v1/golden/list");
    expect(await calls[0]?.json()).toEqual({ org: "Example" });
  });
});
