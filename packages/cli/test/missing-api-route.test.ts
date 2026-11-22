import { expect, test } from "bun:test";
import { createSdkCommandClient } from "../src/sdk-session.ts";
import { memorySessionStore } from "../src/session.ts";

test.each([
  ["/api/v1/org/list", { error: "Not found." }],
  ["/api/v1/sandbox/status", { error: "Not found." }],
  ["/api/v1/org/invitations/list", { error: "Not found." }],
  ["/api/v1/github/refresh", { error: { code: "unknown_route", message: "untrusted text" } }],
] as const)("route 404 at %s reports deployment drift before resource-specific errors", async (path, payload) => {
  const client = await createSdkCommandClient({
    env: { ARMADA_TOKEN: "fixture-token", ARMADA_URL: "https://armada.test" },
    session: memorySessionStore(),
    fetch: async () => Response.json(payload, { status: 404 }),
  });
  await expect(client.request(path, { method: "POST" })).rejects.toMatchObject({
    code: "unavailable",
    message: `This Armada deployment at https://armada.test does not serve ${path}; the dashboard or server may be out of date. Ask an administrator to verify the deployment.`,
  });
});
