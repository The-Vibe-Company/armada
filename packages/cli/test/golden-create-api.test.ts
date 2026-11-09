import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const token = "armada_sk_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12";
test("golden create maps positional config to API with token-only auth", async () => {
  const calls: Request[] = [];
  let out = "";
  const code = await run(
    [
      "golden",
      "create",
      "web",
      "--repo",
      "https://github.com/acme/web.git@feature/login",
      "--repo",
      "git@github.com:acme/api.git@release/x",
      "--init",
      "pnpm install",
      "--private",
      "--org",
      "team",
    ],
    { out: (t) => (out += t), err: () => undefined },
    {
      auth: {
        out: () => undefined,
        err: () => undefined,
        env: { ARMADA_TOKEN: token },
        fetch: async (input, init) => {
          const r = input instanceof Request ? input : new Request(String(input), init);
          calls.push(r);
          return Response.json({ name: "web", visibility: "private", snapshot: "golden-bx" });
        },
        now: () => new Date(),
        open: () => undefined,
        session: memorySessionStore(),
      },
    },
  );
  expect(code).toBe(0);
  expect(out).toContain("Saved snapshot: golden-bx");
  expect(calls[0]?.url).toBe("https://armada.thevibecompany.co/api/v1/golden/create");
  expect(await calls[0]?.json()).toMatchObject({
    name: "web",
    private: true,
    org: "team",
    config: {
      init: ["pnpm install"],
      repos: [
        { branch: "feature/login", dir: "web" },
        { branch: "release/x", dir: "api" },
      ],
    },
  });
});

test("token-only golden create prints an actionable API conflict and exits nonzero", async () => {
  const message =
    "Golden capacity or binding is unavailable or busy. Use an existing golden you can access, retry after any active build finishes, or ask an administrator to check the binding.";
  let errorOutput = "";
  let output = "";
  let requests = 0;
  const code = await run(
    ["golden", "create", "quota-probe", "--repo", "https://github.com/acme/web", "--json"],
    {
      out: (text) => {
        output += text;
      },
      err: (text) => {
        errorOutput += text;
      },
    },
    {
      auth: {
        out: () => {},
        err: () => {},
        env: { ARMADA_TOKEN: token },
        fetch: async () => {
          requests++;
          return Response.json({ error: { code: "conflict", message } }, { status: 409 });
        },
        now: () => new Date(),
        open: () => {},
        session: memorySessionStore(),
      },
    },
  );
  expect(code).toBe(1);
  expect(errorOutput).toContain(message);
  expect(errorOutput).not.toContain(token);
  expect(output).toBe("");
  expect(requests).toBe(1);
});
