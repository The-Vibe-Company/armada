import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

test("GitHub repair sends only the sandbox id over the authenticated Armada API", async () => {
  let request: Request | undefined;
  let out = "";
  const code = await run(
    ["github", "refresh", "sandbox-id"],
    {
      out: (text) => {
        out += text;
      },
      err: () => {},
    },
    {
      auth: {
        out: (text) => {
          out += text;
        },
        err: () => {},
        env: { ARMADA_URL: "https://armada.test", ARMADA_TOKEN: "fixture-service-token" },
        session: memorySessionStore(),
        now: () => new Date(),
        open: () => {},
        fetch: async (input, init) => {
          request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
          return Response.json({ id: "sandbox-id", login: "octocat", status: "connected" });
        },
      },
    },
  );
  expect(code).toBe(0);
  expect(request?.url).toBe("https://armada.test/api/v1/github/refresh");
  expect(request?.headers.get("authorization")).toBe("Bearer fixture-service-token");
  expect(await request?.json()).toEqual({ id: "sandbox-id" });
  expect(JSON.parse(out)).toEqual({ id: "sandbox-id", login: "octocat", status: "connected" });
});
