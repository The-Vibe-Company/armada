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
  "--image",
  image,
  "--credential-id",
  credential,
  "--request-id",
  requestId,
];
async function capture(argv: string[], fetcher: (request: Request) => Promise<Response>) {
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
      image,
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

test("Docker incompatible or malformed options fail before HTTP", async () => {
  const calls: Request[] = [];
  for (const flags of [
    ["--agent", "unknown"],
    ["--skill", "foo@1"],
    ["--repo", "acme/web"],
    ["--connections", "a"],
    ["--credential-version", "0"],
    ["--host", "not-a-host"],
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
