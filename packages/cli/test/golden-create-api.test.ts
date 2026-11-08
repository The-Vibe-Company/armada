import { expect, test } from "bun:test";
import { memorySessionStore } from "@armada/auth";
import { run } from "../src/run.ts";

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
