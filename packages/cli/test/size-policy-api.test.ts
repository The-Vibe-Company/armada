import { expect, test } from "bun:test";
import { memorySessionStore } from "../src/session.ts";
import { sizePolicyCommand } from "../src/size-policy-command.ts";

test("size-policy inspects or replaces server defaults without allocating or changing other fields", async () => {
  const policy = { version: 1, golden: "medium", repositories: { web: "large" } };
  for (const replacement of [undefined, policy]) {
    let out = "";
    const calls: Request[] = [];
    const result = {
      goldenId: "golden",
      provider: "modal",
      repositories: [{ url: "https://github.com/acme/web", branch: "main", dir: "web" }],
      policy: replacement ?? null,
    };
    const code = await sizePolicyCommand(
      ["web", "--provider", "modal", "--org", "org", "--json", ...(replacement ? ["--file", "-"] : [])],
      {
        out: (text) => {
          out += text;
        },
        err: () => {
          throw new Error("JSON must not emit human advice");
        },
        env: { ARMADA_TOKEN: "test-token" },
        fetch: async (input, init) => {
          const request = new Request(String(input), init);
          calls.push(request);
          return Response.json(result);
        },
        session: memorySessionStore(),
        now: () => new Date(),
        open: () => undefined,
      },
      async (path) => {
        expect(path).toBeUndefined();
        return JSON.stringify(policy);
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual(result);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toEndWith("/api/v1/golden/size-policy");
    expect(await calls[0]?.json()).toEqual({
      golden: "web",
      provider: "modal",
      org: "org",
      ...(replacement ? { policy } : {}),
    });
  }
});

test("size-policy rejects unreadable input and propagates server authorization failure without success output", async () => {
  let requests = 0;
  let out = "";
  const auth = {
    out: (text: string) => {
      out += text;
    },
    err: () => undefined,
    env: { ARMADA_TOKEN: "test-token" },
    fetch: async () => {
      requests++;
      return Response.json({ error: { message: "Admin required." } }, { status: 403 });
    },
    session: memorySessionStore(),
    now: () => new Date(),
    open: () => undefined,
  };
  await expect(sizePolicyCommand(["web", "--file", "bad"], auth, async () => "{")).rejects.toThrow("JSON");
  expect(requests).toBe(0);
  await expect(sizePolicyCommand(["web"], auth, async () => "")).rejects.toThrow("Admin required.");
  expect(requests).toBe(1);
  expect(out).toBe("");
});
