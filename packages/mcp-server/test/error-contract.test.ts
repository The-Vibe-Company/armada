import { expect, test } from "bun:test";
import { createMemoryAuthStore } from "@armada/auth";
import { LaunchError, ProviderError, ProviderRoutingError, VaultError, type VaultStore } from "@armada/core/server";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { controlFailureResponse } from "../src/control-errors.ts";
import { callSharedTool, ToolApiError } from "../src/tool-api.ts";
import type { ToolContext } from "../src/tools.ts";

function toolContext(error: Error): ToolContext {
  return {
    caller: { userId: "owner", orgs: [{ orgId: "org", role: "member" }], via: "service" },
    data: {
      sandboxes: {
        get: async () => ({
          id: "sandbox",
          ownerId: "owner",
          orgId: "org",
          provider: "boat",
          providerSandboxId: "bx",
          status: "running",
        }),
      },
    },
    provider: async () => ({ id: "boat", get: async () => ({ state: "running" }) }),
    launchCredentials: {
      refreshGitHub: async () => {
        throw error;
      },
    },
    logError: () => {},
    now: () => new Date(),
  } as unknown as ToolContext;
}

async function sharedFailure(error: Error) {
  try {
    await callSharedTool(toolContext(error), "github_refresh", { id: "sandbox" });
  } catch (caught) {
    if (!(caught instanceof ToolApiError)) throw caught;
    return controlFailureResponse(caught);
  }
  throw new Error("Expected shared-tool failure");
}

// Independent HTTP projections deliberately differ today. Expected values are the public baseline,
// not values derived from either mapping table.
test.each([
  ["not_found", 503, 404],
  ["sandbox_not_ready", 503, 409],
  ["no_running_turn", 503, 409],
  ["payment_required", 402, 402],
  ["rate_limited", 429, 429],
  ["unauthorized", 422, 422],
  ["unavailable", 502, 502],
  ["unknown", 502, 502],
] as const)("provider %s direct/shared HTTP contract", async (code, direct, shared) => {
  const error = new ProviderError({ provider: "modal", code, message: "refused", retryable: false });
  const response = controlFailureResponse(error);
  expect(response.status).toBe(direct);
  const body = await response.json();
  const normalized =
    code === "unauthorized"
      ? "credential_refused"
      : ["unknown", "unavailable"].includes(code)
        ? "provider_unavailable"
        : code;
  expect(body).toMatchObject({ error: { code: normalized } });
  const sharedResponse = await sharedFailure(error);
  expect(sharedResponse.status).toBe(shared);
  expect(await sharedResponse.json()).toMatchObject({ error: { code: normalized } });
});

test("retained provider receipt takes precedence over credential refusal", async () => {
  const response = controlFailureResponse(
    new ProviderError({
      provider: "modal",
      code: "unauthorized",
      message: "refused",
      retryable: false,
      details: { resourceReceipt: { id: "resource" } },
    }),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: "outcome_unknown" } });
});

test("unclassified failures retain direct 500 versus shared 503", async () => {
  const error = new Error("dependency failed");
  expect(controlFailureResponse(error).status).toBe(500);
  const response = await sharedFailure(error);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: "internal" } });
});

const options: ControlOptions = {
  authStore: createMemoryAuthStore(),
  supabase: { supabaseUrl: "https://supabase.test", anonKey: "anon_placeholder" },
  store: {} as VaultStore,
  encryptionKey: undefined,
};

for (const route of ["auth/exchange", "auth/refresh"]) {
  test.each([
    [new VaultError("missing_credential", "missing"), 400, "missing_credential", 404],
    [new VaultError("conflict", "conflict"), 400, "conflict", 409],
    [new VaultError("credential_refused", "refused"), 400, "credential_refused", 422],
    [new VaultError("unavailable", "unavailable"), 400, "unavailable", 503],
    [new LaunchError("outcome_unknown", "inspect first"), 400, "outcome_unknown", 503],
    [new ProviderRoutingError("provider_mismatch", "modal", "mismatch"), 503, "provider_mismatch", 503],
    [new Error("dependency failed"), 401, "unauthorized", 500],
  ] as const)(`${route} preserves early-catch %s exception`, async (error, status, code, mainStatus) => {
    const reject = async () => {
      throw error;
    };
    const response = await handleControlRequest(
      new Request(`https://armada.test/api/v1/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: "code_placeholder",
          verifier: "v".repeat(43),
          refreshToken: "refresh_placeholder",
        }),
      }),
      { ...options, exchangeNative: reject, refreshNative: reject },
    );
    if (!response) throw new Error("Route not handled");
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(controlFailureResponse(error).status).toBe(mainStatus);
  });
}

test.each([
  ["auth/exchange", {}, 400, "invalid"],
  ["auth/exchange", { code: "code_placeholder", verifier: "short" }, 400, "invalid"],
  ["auth/refresh", {}, 400, "invalid"],
  ["auth/email/start", {}, 400, "invalid"],
  ["auth/email/verify", {}, 401, "unauthorized"],
] as const)("%s invalid input baseline: %j", async (route, body, status, code) => {
  const response = await handleControlRequest(
    new Request(`https://armada.test/api/v1/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    options,
  );
  if (!response) throw new Error("Route not handled");
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
});

test.each([
  ["auth/email/start", "Too many attempts", 429, "rate_limited"],
  ["auth/email/start", "dependency offline", 400, "invalid"],
  ["auth/email/verify", "dependency offline", 503, "unavailable"],
] as const)("%s dependency failure: %s", async (route, message, status, code) => {
  const response = await handleControlRequest(
    new Request(`https://armada.test/api/v1/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "alice@example.test",
        code: "123456",
        redirect_uri: "http://localhost:43123/callback",
        code_challenge: "a".repeat(43),
        state: "state_placeholder",
      }),
    }),
    {
      ...options,
      supabase: {
        ...options.supabase,
        fetch: async () => {
          if (message === "Too many attempts") return new Response(null, { status: 429 });
          throw new Error(message);
        },
      },
    },
  );
  if (!response) throw new Error("Route not handled");
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
});
