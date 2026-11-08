import { expect, test } from "bun:test";
import { memorySessionStore } from "../src/session.ts";
import { tokenList } from "../src/auth-commands.ts";

test("token list uses the Armada API bearer with a clean HOME token", async () => {
  let request: Request | undefined;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    return Response.json({ tokens: [] });
  };
  let out = "";
  await tokenList({
    out: (text) => (out += text), err: () => {}, env: { ARMADA_TOKEN: "test-service-token" },
    fetch, now: () => new Date(), open: () => {}, session: memorySessionStore(),
  });
  expect(request?.url).toBe("https://armada.thevibecompany.co/api/v1/token/list");
  expect(request?.headers.get("authorization")).toBe("Bearer test-service-token");
  expect(out).toBe("No service tokens.\n");
});
