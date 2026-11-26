import { describe, expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const token = "armada_sk_fixture_token";

function apiFetch(calls: Request[]) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    calls.push(request);
    return Response.json({
      goldens: [
        {
          name: "web",
          provider: "boat",
          modal: null,
          orgId: "11111111-1111-4111-8111-111111111111",
          visibility: "org",
          ownerId: "22222222-2222-4222-8222-222222222222",
          providerSnapshotId: "snapshot",
          providerSandboxId: null,
          repos: 1,
          config: { repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] },
        },
      ],
    });
  };
}

describe("golden list through the Armada API", () => {
  test("snapshot ls uses the API with a token-only clean HOME", async () => {
    const calls: Request[] = [];
    let out = "";
    let err = "";
    const code = await run(
      ["snapshot", "ls"],
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
    expect(out).toMatch(/NAME\s+PROVIDER\s+VISIBILITY\s+SNAPSHOT\s+REPOS/);
    expect(out).toMatch(/web\s+boat\s+org\s+snapshot\s+1 repo/);
    expect(err).toBe("");
    expect(calls[0]?.url).toBe("https://armada.thevibecompany.co/api/v1/golden/list");
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${token}`);
  });

  test("uses ARMADA_URL, preserves JSON, and sends requested org to the server", async () => {
    const calls: Request[] = [];
    let out = "";
    const code = await run(
      ["snapshot", "ls", "--json", "--org", "Example"],
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

test("snapshot show returns the durable build ID and state", async () => {
  const jobId = "11111111-1111-4111-8111-111111111111";
  let output = "";
  const requests: unknown[] = [];
  const code = await run(
    ["snapshot", "show", "--build", jobId],
    { out: (text) => (output += text), err: () => {} },
    {
      stdoutIsTTY: false,
      auth: {
        env: { ARMADA_TOKEN: token },
        out: () => {},
        err: () => {},
        open: () => {},
        now: () => new Date(0),
        session: memorySessionStore(),
        fetch: async (input, init) => {
          requests.push([new URL(String(input)).pathname, JSON.parse(String(init?.body))]);
          return Response.json({ jobId, state: "queued", phase: "queued", errorCode: null, result: null });
        },
      },
    },
  );
  expect(code).toBe(0);
  expect(requests).toEqual([["/api/v1/golden/build/status", { jobId }]]);
  expect(JSON.parse(output)).toMatchObject({ jobId, state: "queued" });
});

test("snapshot show refuses organization names for admission-key recovery before sending a request", async () => {
  const forbidden = () => {
    throw new Error("Invalid recovery scope attempted I/O");
  };
  let errors = "";
  const code = await run(
    ["snapshot", "show", "--idempotency-key", "stable-admission-key", "--org", "Example"],
    { out: forbidden, err: (text) => (errors += text) },
    { env: { ARMADA_TOKEN: token }, fetch: Object.assign(forbidden, { preconnect: forbidden }) },
  );
  expect(code).toBe(2);
  expect(errors).toContain("--org must be a UUID");
});
