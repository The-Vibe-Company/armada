import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const org = "11111111-1111-4111-8111-111111111111";
const host = "22222222-2222-4222-8222-222222222222";
const credential = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const image = `worker@sha256:${"a".repeat(64)}`;
const args = [
  "launch",
  "--provider",
  "docker",
  "--org",
  org,
  "--host",
  host,
  "--credential-id",
  credential,
  "--request-id",
  requestId,
];
async function capture(argv: string[], fetcher: (request: Request) => Promise<Response>, config?: unknown) {
  let out = "",
    err = "";
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
      ...(config === undefined ? {} : { readFile: async () => JSON.stringify(config) }),
      auth: {
        out: () => {},
        err: () => {},
        env: { ARMADA_TOKEN: "armada_sk_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12" },
        session: memorySessionStore(),
        now: () => new Date(),
        open: () => {},
        fetch: async (input, init) => fetcher(input instanceof Request ? input : new Request(String(input), init)),
      },
    },
  );
  return { code, out, err };
}

// CLI owns translating flags and preserving recovery identity, not host/runtime sequencing.
test.each(["codex", "claude", "opencode"] as const)(
  "Docker %s CLI uses normal authenticated launch without golden or provider secrets",
  async (harness) => {
    const calls: Request[] = [];
    const receipt = {
      sandbox: { id: requestId, provider: "docker", providerSandboxId: "docker-logical", status: "running" },
      golden: null,
      runtime: { kind: "armada", epoch: "1" },
      promptId: "prompt",
      conversationId: "conversation",
    };
    const result = await capture(
      [...args, "--agent", harness, "--ttl", "30m", "answer once", "--json"],
      async (request) => {
        calls.push(request);
        return Response.json(receipt);
      },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual(receipt);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://armada.thevibecompany.co/api/v1/sandbox/launch");
    expect(calls[0]?.headers.get("authorization")).toStartWith("Bearer armada_sk_");
    expect(await calls[0]?.json()).toEqual({
      org,
      provider: "docker",
      hostId: host,
      harness,
      credentialId: credential,
      requestId,
      model: harness === "codex" ? "gpt-6.1-sol" : harness === "claude" ? "claude-opus-5-5" : "armada/deepseek-flash",
      reasoningEffort: harness === "opencode" ? "default" : "medium",
      ttlSeconds: 1800,
      prompt: "answer once",
    });
  },
);

test("Docker repository launch accepts a starting receipt without inventing a runtime epoch", async () => {
  const calls: Request[] = [];
  const withoutImage = args.filter((arg, index) => arg !== "--image" && args[index - 1] !== "--image");
  const result = await capture([...withoutImage, "--repo", "acme/web@feature/work"], async (request) => {
    calls.push(request);
    return Response.json({
      sandbox: { id: requestId, provider: "docker", status: "starting" },
      golden: null,
      runtime: null,
    });
  });
  expect(result.code).toBe(0);
  expect(await calls[0]?.json()).toMatchObject({
    repos: [{ url: "https://github.com/acme/web", branch: "feature/work", dir: "web" }],
  });
});

test("Docker incompatible or malformed options fail before HTTP", async () => {
  const calls: Request[] = [];
  for (const flags of [
    ["--agent", "unknown"],
    ["--variable", "PATH:33333333-3333-4333-8333-333333333333:1"],
    ["--variable", "APP_REGION:not-a-uuid:1"],
    ["--image", image],
    ["--image", `sha256:${"A".repeat(64)}`],
    ["--skill", "foo@1"],
    ["--secret", `OPENAI_API_KEY:${credential}:1`],
    ["--secret", `APP_TOKEN:${credential}:0`],
    ["--repo", "https://user:secret@example.test/web"],
    ["--connections", "a"],
    ["--credential-version", "0"],
    ["--host", "x".repeat(65)],
    ["one", "two"],
  ]) {
    const result = await capture([...args, ...flags], async (request) => {
      calls.push(request);
      throw Error("offline");
    });
    expect(result.code).not.toBe(0);
  }
  expect(calls).toEqual([]);
});

test("unknown Docker launch outcome retains a stable request UUID for exact retry", async () => {
  for (const mode of ["lost", "wrong-sandbox"]) {
    const result = await capture(args, async () => {
      if (mode === "lost") throw Error("offline");
      return Response.json({ sandbox: { provider: "docker", id: host }, golden: null, runtime: { epoch: "1" } });
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toBe("");
    expect(result.err).toContain(`--request-id ${requestId}`);
    expect(result.err).toContain("do not create a replacement");
  }
});

test.each([{ flags: ["--skill", "team/notes@1.2.3", "--connections", host] }, { flags: ["--no-connections"] }])(
  "Docker forwards existing skill/MCP flags %j",
  async ({ flags }: { flags: readonly string[] }) => {
    let body: Record<string, unknown> = {};
    const result = await capture([...args, ...flags], async (request) => {
      body = (await request.json()) as Record<string, unknown>;
      return Response.json({ sandbox: { id: requestId, provider: "docker" }, golden: null, runtime: { epoch: "1" } });
    });
    expect(result.code).toBe(0);
    expect(body.connections).toEqual(flags.includes("--no-connections") ? [] : [host]);
    if (flags.includes("--skill")) expect(body.skills).toEqual(["team/notes@1.2.3"]);
  },
);
test("Docker launch resolves an exact unique non-revoked host name and refuses missing/ambiguous names", async () => {
  const receipt = {
    sandbox: { id: requestId, provider: "docker", status: "running" },
    golden: null,
    runtime: { epoch: "1" },
  };
  const namedArgs = [...args.map((arg) => (arg === host ? "office" : arg)), "--repo", "acme/web@feature/work"];
  const summary = {
    id: host,
    name: "office",
    state: "online",
    createdAt: "2026-11-13T00:00:00Z",
    lastSeenAt: null,
    revokedAt: null,
    version: "2.27.0",
    sandboxes: 0,
  };
  for (const mode of ["unique", "missing", "ambiguous"]) {
    let launched = 0;
    const result = await capture(namedArgs, async (request) => {
      if (new URL(request.url).pathname.endsWith("/hosts/list")) {
        expect(await request.json()).toEqual({ org });
        return Response.json({
          placement: true,
          hosts:
            mode === "missing"
              ? []
              : mode === "ambiguous"
                ? [summary, { ...summary, id: credential }]
                : [summary, { ...summary, id: credential, state: "revoked" }],
        });
      }
      launched++;
      expect(await request.json()).toMatchObject({
        hostId: host,
        repos: [{ url: "https://github.com/acme/web", branch: "feature/work", dir: "web" }],
      });
      return Response.json(receipt);
    });
    expect(result.code === 0).toBe(mode === "unique");
    expect(launched).toBe(mode === "unique" ? 1 : 0);
    if (mode !== "unique") expect(result.err).toContain(mode === "missing" ? "No non-revoked" : "ambiguous");
  }
});

test("Docker CLI translates repeated repository flags with golden branch and directory rules", async () => {
  let body: unknown;
  const result = await capture(
    [
      ...args,
      "--repo",
      "acme/web@feature/work",
      "--repo",
      "acme/api@main",
      "--variable",
      `APP_REGION:${credential}:2`,
      "--secret",
      `APP_TOKEN:${requestId}:1`,
      "--skill",
      "catalog/notes@1.0.0",
      "--connections",
      credential,
    ],
    async (request) => {
      body = await request.json();
      return Response.json({
        sandbox: { id: requestId, provider: "docker", providerSandboxId: "docker-logical", status: "ready" },
        golden: null,
        runtime: { epoch: "1" },
      });
    },
  );
  expect(result.code).toBe(0);
  expect(body).toMatchObject({
    variables: [{ key: "APP_REGION", variableId: credential, version: 2 }],
    secrets: [{ key: "APP_TOKEN", secretId: requestId, version: 1 }],
    skills: ["catalog/notes@1.0.0"],
    connections: [credential],
    repos: [
      { url: "https://github.com/acme/web", branch: "feature/work", dir: "web" },
      { url: "https://github.com/acme/api", branch: "main", dir: "api" },
    ],
  });
});

test("Docker snapshots build through the normal golden command and launch through a scoped snapshot selector", async () => {
  const id = "55555555-5555-4555-8555-555555555555",
    config = {
      repos: [{ url: "https://github.com/example/project.git", branch: "main", dir: "project" }],
      init: ["printf built > /home/user/proof"],
    };
  const snapshot = {
    id,
    orgId: org,
    ownerId: credential,
    name: "owned",
    provider: "docker",
    visibility: "private",
    hostId: host,
    installationId: requestId,
    hostName: "office",
    hostAvailable: true,
    status: "building",
    definitionHash: "a".repeat(64),
    builtOnVersion: "2.28.0",
    image: null,
    config,
    createdAt: "2026-11-13T00:00:00.000Z",
  };
  const build = await capture(
    [
      "golden",
      "create",
      "owned",
      "--provider",
      "docker",
      "--host",
      host,
      "--org",
      org,
      "--config",
      "env.json",
      "--private",
      "--request-id",
      id,
    ],
    async (request) => {
      expect(new URL(request.url).pathname).toBe("/api/v1/docker/snapshots/create");
      expect(await request.json()).toEqual({
        org,
        hostId: host,
        requestId: id,
        name: "owned",
        visibility: "private",
        config,
      });
      return Response.json({ snapshot });
    },
    config,
  );
  expect(build.code).toBe(0);
  expect(build.out).toContain(id);
  expect(build.out).toContain("building");
  expect(build.out).toContain("Built on Armada: 2.28.0");
  for (const builtOnVersion of ["2.28.0", null]) {
    const listed = await capture(["golden", "list", "--provider", "docker", "--org", org], async () =>
      Response.json({ snapshots: [{ ...snapshot, builtOnVersion }] }),
    );
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(`Built on Armada ${builtOnVersion ?? "unknown version"}`);
  }
  const offered = await capture(["golden", "list", "--provider", "docker", "--org", org], async () =>
    Response.json({
      currentVersion: "2.29.0",
      snapshots: [{ ...snapshot, status: "ready", image: `sha256:${"a".repeat(64)}` }],
    }),
  );
  expect(offered.out).toContain(`armada snapshot rebuild ${id} --provider docker --org ${org}`);
  const rebuilt = await capture(
    ["golden", "rebuild", id, "--provider", "docker", "--org", org, "--request-id", requestId],
    async (request) => {
      expect(new URL(request.url).pathname).toBe("/api/v1/docker/snapshots/rebuild");
      expect(await request.json()).toEqual({ org, id, requestId });
      return Response.json({ snapshot: { ...snapshot, id: requestId, builtOnVersion: "2.29.0" } });
    },
  );
  expect(rebuilt.code).toBe(0);
  expect(rebuilt.out).toContain(`Original snapshot unchanged: ${id}`);
  expect(rebuilt.err).toContain(requestId);
  const sourceArgs = args.filter(
    (arg, index) => !["--image", "--host"].includes(arg) && !["--image", "--host"].includes(args[index - 1] ?? ""),
  );
  const launched = await capture([...sourceArgs, "--golden", id, "Work"], async (request) => {
    const body = (await request.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ snapshotId: id, provider: "docker", prompt: "Work" });
    expect(body.hostId).toBeUndefined();
    expect(body.image).toBeUndefined();
    return Response.json({
      sandbox: { id: requestId, provider: "docker", snapshotId: id, status: "running" },
      golden: null,
      runtime: { epoch: "1" },
    });
  });
  expect(launched.code).toBe(0);
  let calls = 0;
  expect(
    (
      await capture([...args, "--golden", id, "--image", image], async () => {
        calls++;
        throw Error("unexpected HTTP");
      })
    ).code,
  ).not.toBe(0);
  expect(calls).toBe(0);
});

test("Docker launch omits an unspecified account for server default resolution without choosing a local fallback", async () => {
  const withoutAccount = args.filter(
    (arg, index) => arg !== "--credential-id" && args[index - 1] !== "--credential-id",
  );
  const requests: Request[] = [];
  const result = await capture([...withoutAccount, "--json"], async (request) => {
    requests.push(request);
    return Response.json({
      sandbox: { id: requestId, provider: "docker", status: "ready" },
      golden: null,
      runtime: { epoch: "1" },
    });
  });
  expect(result.code).toBe(0);
  expect(requests).toHaveLength(1);
  expect(await requests[0]?.json()).not.toHaveProperty("credentialId");
  expect(
    await capture([...withoutAccount, "--credential-version", "1"], async () => {
      throw Error("must not contact server");
    }),
  ).toMatchObject({ code: 2 });
});
