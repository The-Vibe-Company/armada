import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { encryptSecret, redact } from "@armada/core";
import { exposedSecrets } from "../src/launch-credentials.ts";

test("exec redacts even short keys nested in custom endpoint credentials", async () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const apiKey = randomUUID().slice(0, 7);
  const valueEnc = await encryptSecret(
    JSON.stringify({
      endpoint: { version: 1, baseUrl: "https://example.com/v1" },
      apiKey,
    }),
    key,
  );
  const secrets = await exposedSecrets(
    {
      credentials: async (scope) => (scope === "user" ? [{ kind: "openai", valueEnc }] : []),
      orgBoatKey: async () => null,
    },
    key,
    { userId: "u", orgId: "o" },
  );
  expect(redact(`key=${apiKey}`, secrets)).toBe("key=***");
});
