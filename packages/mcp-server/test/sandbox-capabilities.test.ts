import { expect, test } from "bun:test";
import { createMemoryAuthStore } from "@armada/auth";
import { encryptSecret, type GoldenRecord, type Provider, type VaultStore } from "@armada/core";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";

const userId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";
const accountId = "33333333-3333-4333-8333-333333333333";

test("capabilities enforce provider harness support and caller-visible active accounts without allocating", async () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const valueEnc = await encryptSecret("model_placeholder", key);
  const authStore = createMemoryAuthStore();
  authStore.addMembership(userId, { orgId, name: "test", role: "member" });
  let active = true;
  let visible = true;
  let supported = true;
  let configured = true;
  const options: ControlOptions = {
    authStore,
    supabase: {
      supabaseUrl: "https://supabase.test",
      anonKey: "anon",
      fetch: async () => Response.json({ id: userId }),
    },
    encryptionKey: key,
    store: {
      credentials: async (scope, ownerId) =>
        visible && scope === "user" && ownerId === userId
          ? [{ id: accountId, kind: "openai", valueEnc, status: active ? "active" : "revoked" }]
          : [],
    } as VaultStore,
    data: () =>
      ({
        goldens: {
          findByName: async () => [{ provider: "boat", orgId, visibility: "org", modal: null } as GoldenRecord],
        },
      }) as unknown as ReturnType<NonNullable<ControlOptions["data"]>>,
    providers: {
      resolve: async () => {
        if (!configured) throw new Error("private_provider_diagnostic");
        return {
          id: "boat",
          harnesses: supported ? ["codex"] : [],
          fork: () => {
            throw new Error("must not allocate");
          },
        } as unknown as Provider;
      },
    },
  };
  async function read(auth = true) {
    return (await handleControlRequest(
      new Request("https://armada.test/api/v1/sandbox/capabilities", {
        method: "POST",
        headers: auth ? { authorization: "Bearer e30.e30.sig" } : {},
        body: JSON.stringify({ provider: "boat", golden: "existing", credentialId: accountId }),
      }),
      options,
    ))!;
  }
  expect((await read(false)).status).toBe(401);
  for (const reason of [
    null,
    "account_unavailable",
    "account_unavailable",
    "harness_unavailable",
    "provider_unavailable",
  ]) {
    const response = await read();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      pairs: { provider: string; harness: string; enabled: boolean; reason: string | null }[];
    };
    expect(body.pairs.find((pair: { harness: string }) => pair.harness === "codex")).toEqual({
      provider: "boat",
      harness: "codex",
      enabled: reason === null,
      reason,
    });
    expect(JSON.stringify(body)).not.toContain("model_placeholder");
    expect(JSON.stringify(body)).not.toContain("private_provider_diagnostic");
    if (active) active = false;
    else if (visible) visible = false;
    else if (supported) supported = false;
    else configured = false;
  }
});
