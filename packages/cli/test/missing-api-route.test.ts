import { expect, test } from "bun:test";
import { createArmadaApiClient } from "../src/armada-api.ts";
import { memorySessionStore } from "../src/session.ts";

test.each(["/api/v1/org/list", "/api/v1/sandbox/status", "/api/v1/org/invitations/list"])(
  "unstructured 404 at %s reports deployment drift before resource-specific errors",
  async (path) => {
    const client = await createArmadaApiClient({
      env: { ARMADA_TOKEN: "fixture-token", ARMADA_URL: "https://armada.test" },
      session: memorySessionStore(),
      fetch: async () => Response.json({ error: "Not found." }, { status: 404 }),
    });
    await expect(client.request(path, { method: "POST" })).rejects.toMatchObject({
      code: "unavailable",
      message: `This Armada deployment at https://armada.test does not serve ${path}; the dashboard or server may be out of date. Ask an administrator to verify the deployment.`,
    });
  },
);
