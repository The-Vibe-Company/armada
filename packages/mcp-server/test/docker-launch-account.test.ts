import { expect, test } from "bun:test";
import { encryptSecret } from "@armada/core/server";
import { resolveDockerLaunchAccount } from "../src/docker-launch-account.ts";
import { launchCredentials } from "../src/launch-credentials.ts";

// Real shared resolution through the Docker admission boundary, not a fake that chooses the asserted default.
test("Docker omission selects the personal subscription default while an explicit API account remains explicit", async () => {
  const key = Buffer.alloc(32, 23).toString("base64");
  const apiId = "11111111-1111-4111-8111-111111111111";
  const subscriptionId = "22222222-2222-4222-8222-222222222222";
  const api = {
    id: apiId,
    kind: "openai" as const,
    version: 1,
    status: "active",
    isDefault: false,
    valueEnc: await encryptSecret("fake-api-key", key),
  };
  const subscription = {
    id: subscriptionId,
    kind: "codex_auth" as const,
    version: 2,
    status: "active",
    isDefault: true,
    valueEnc: await encryptSecret(
      JSON.stringify({
        tokens: { access_token: "fake-access", refresh_token: "fake-refresh", account_id: "fake-account" },
      }),
      key,
    ),
  };
  const rows = [api, subscription];
  const reader = { credentials: async (scope: string) => (scope === "user" ? rows : []), orgBoatKey: async () => null };
  const credentials = launchCredentials(reader, key);
  const actor = { userId: "owner", orgId: "org", role: "member" as const };
  const omitted = await resolveDockerLaunchAccount(credentials, actor, {
    harness: "codex",
    credentialId: null,
    credentialVersion: null,
  });
  expect(omitted.binding).toEqual({ credentialId: subscriptionId, credentialVersion: 2 });
  expect(omitted.resolved.codexAuthJson).toBe(true);
  expect(omitted.resolved.env.OPENAI_API_KEY).toBeUndefined();
  const explicit = await resolveDockerLaunchAccount(credentials, actor, {
    harness: "codex",
    credentialId: apiId,
    credentialVersion: 1,
  });
  expect(explicit.binding).toEqual({ credentialId: apiId, credentialVersion: 1 });
  expect(explicit.resolved.env.OPENAI_API_KEY).toBe("fake-api-key");
  subscription.status = "revoked";
  await expect(
    resolveDockerLaunchAccount(credentials, actor, { harness: "codex", credentialId: null, credentialVersion: null }),
  ).rejects.toMatchObject({ code: "credential_refused" });
});
