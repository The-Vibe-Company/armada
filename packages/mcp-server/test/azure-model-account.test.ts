import { expect, test } from "bun:test";
import { createMemoryAuthStore } from "@armada/auth";
import { type CredentialInfo, decryptSecret, parseCredentialValue, type VaultStore } from "@armada/core";
import { validateAzureModelAccount } from "../src/azure-model-account.ts";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const KEY = Buffer.alloc(32, 19).toString("base64");
const RESOURCE = "https://resource.services.ai.azure.com/api/projects/project/openai/v1";
function connection(kind: "openai" | "opencode", apiKey: string, models: string[] = ["my-deployment"]) {
  return JSON.stringify(
    kind === "openai"
      ? { endpoint: { version: 1, baseUrl: RESOURCE }, apiKey, models }
      : { endpoint: { version: 1, baseUrl: RESOURCE, protocol: "azure", models }, apiKey },
  );
}
// Only persistence/auth transport is faked. Real HTTP admission, parsing, authorization,
// Azure wire check and encryption run without SQL, network, waits or child processes.
function fixture(role: "admin" | "member" = "admin") {
  const writes: Uint8Array<ArrayBuffer>[] = [],
    existing: CredentialInfo[] = [];
  const store: Pick<VaultStore, "memberships" | "listCredentials" | "mutateAccount" | "upsertCredential"> = {
    memberships: async () => [{ id: ORG, name: "Fixture", role }],
    listCredentials: async () => existing,
    mutateAccount: async (_user, input, sealed) => {
      if (!sealed || !input.kind) throw Error("unexpected non-set mutation");
      writes.push(new Uint8Array(sealed));
      return { id: crypto.randomUUID(), kind: input.kind, name: input.name ?? "Fixture", version: 1, createdAt: null };
    },
    upsertCredential: async (_scope, _owner, _kind, sealed) => {
      writes.push(new Uint8Array(sealed));
    },
  };
  const authStore = createMemoryAuthStore();
  authStore.addMembership(USER, { orgId: ORG, name: "Fixture", role });
  const options: ControlOptions = {
    store: store as VaultStore,
    authStore,
    encryptionKey: KEY,
    supabase: {
      supabaseUrl: "https://supabase.test",
      anonKey: "fixture-anon",
      fetch: async () => Response.json({ id: USER }),
    },
  };
  const post = (route: string, body: object) =>
    handleControlRequest(
      new Request(`https://armada.test/api/v1/${route}`, {
        method: "POST",
        headers: { authorization: "Bearer e30.e30.fixture", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      options,
    );
  return { options, writes, existing, post };
}
for (const kind of ["openai", "opencode"] as const) {
  test(`Azure ${kind} checks each exact deployment before encrypting and saving`, async () => {
    const apiKey = crypto.randomUUID(),
      f = fixture(),
      models: string[] = [];
    f.options.modelAccountValidator = (k, value) =>
      validateAzureModelAccount(k, value, async (url, init) => {
        expect(f.writes).toHaveLength(0);
        expect(String(url)).toBe(`${RESOURCE}/responses`);
        const headers = new Headers(init?.headers);
        expect(headers.get(kind === "openai" ? "authorization" : "api-key")).toBe(
          kind === "openai" ? `Bearer ${apiKey}` : apiKey,
        );
        expect(headers.get(kind === "openai" ? "api-key" : "authorization")).toBeNull();
        expect(init?.redirect).toBe("error");
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({ model: expect.any(String), input: ".", max_output_tokens: 16, store: false });
        models.push(body.model);
        return Response.json({ id: "response_fixture", object: "response", status: "completed" });
      });
    const response = await f.post("creds/accounts/set", {
      scope: "user",
      kind,
      name: "Azure",
      value: connection(kind, apiKey, ["deployment-a", "deployment-b"]),
    });
    expect(response?.status).toBe(200);
    expect(models).toEqual(["deployment-a", "deployment-b"]);
    expect(f.writes).toHaveLength(1);
    expect(Buffer.from(f.writes[0] ?? []).toString()).not.toContain(apiKey);
    expect(JSON.parse(await decryptSecret(f.writes[0] ?? new Uint8Array(), KEY)).apiKey).toBe(apiKey);
    expect(await response?.text()).not.toContain(apiKey);
  });
}
for (const route of ["creds/accounts/set", "creds/set"]) {
  test(`${route} cannot bypass a rejected deployment or leak upstream errors`, async () => {
    const f = fixture(),
      apiKey = crypto.randomUUID();
    let requests = 0;
    f.options.modelAccountValidator = (kind, value) =>
      validateAzureModelAccount(kind, value, async () => {
        requests++;
        return Response.json({ error: { code: "DeploymentNotFound", message: apiKey } }, { status: 404 });
      });
    const result = await f.post(route, {
      scope: "user",
      kind: "openai",
      name: "Azure",
      value: connection("openai", apiKey),
      skipValidation: true,
      modelAccountValidator: null,
    });
    expect(result?.status).toBe(400);
    expect(requests).toBe(1);
    expect(f.writes).toHaveLength(0);
    const text = await result?.text();
    expect(text).toContain("DeploymentNotFound");
    expect(text).toContain("not saved");
    expect(text).not.toContain(apiKey);
  });
  test(`${route} refuses missing deployments before probing, while legacy reads remain valid`, async () => {
    const f = fixture(),
      raw = JSON.stringify({ endpoint: { version: 1, baseUrl: RESOURCE }, apiKey: crypto.randomUUID() });
    expect(parseCredentialValue("openai", raw)).toBe(raw);
    f.options.modelAccountValidator = async () => {
      throw Error("must not probe missing deployment");
    };
    const result = await f.post(route, { scope: "user", kind: "openai", name: "Azure", value: raw });
    expect(result?.status).toBe(400);
    expect(await result?.text()).toContain("deployment or model name");
    expect(f.writes).toHaveLength(0);
  });
}
test("Azure admission refuses non-public destinations and wrong native protocol before any network request", async () => {
  let requests = 0;
  const fetcher = async () => {
    requests++;
    return Response.json({});
  };
  for (const baseUrl of [
    "https://127.0.0.1/openai/v1",
    "https://[::1]/openai/v1",
    "https://resource.openai.azure.com.evil.test/openai/v1",
    "https://resource.openai.azure.com:8443/openai/v1",
    "https://user:pass@resource.openai.azure.com/openai/v1",
    "https://resource.openai.azure.com./openai/v1",
    "https://resource.openai.azure.com/not-responses",
  ]) {
    const raw = JSON.stringify({
      endpoint: { version: 1, baseUrl, protocol: "azure", models: ["deployment"] },
      apiKey: "fixture-key",
    });
    await expect(validateAzureModelAccount("opencode", raw, fetcher)).rejects.toThrow();
  }
  await expect(
    validateAzureModelAccount(
      "opencode",
      JSON.stringify({
        endpoint: { version: 1, baseUrl: RESOURCE, models: ["deployment"] },
        apiKey: "fixture-key",
      }),
      fetcher,
    ),
  ).rejects.toThrow("Azure for OpenCode");
  expect(requests).toBe(0);
});
test("unavailable or malformed Azure responses do not establish deployment acceptance", async () => {
  const value = connection("openai", crypto.randomUUID());
  for (const fetcher of [
    async () => {
      throw Error("untrusted upstream diagnostic");
    },
    async () => Response.json({ ok: true }),
    async () => Response.json({ error: { message: "untrusted" }, status: "failed" }),
  ])
    await expect(validateAzureModelAccount("openai", value, fetcher)).rejects.toThrow(/not saved/);
});
test("authorization and stale or foreign rotations refuse before a billable request", async () => {
  const f = fixture("member");
  let requests = 0;
  f.options.modelAccountValidator = async () => {
    requests++;
  };
  const value = connection("openai", crypto.randomUUID());
  const denied = await f.post("creds/accounts/set", { scope: "org", org: ORG, kind: "openai", name: "Azure", value });
  expect(denied?.status).toBe(403);
  const id = crypto.randomUUID();
  const foreign = await f.post("creds/accounts/set", { scope: "user", id, expectedVersion: 1, kind: "openai", value });
  expect(foreign?.status).toBe(404);
  f.existing.push({ id, kind: "openai", version: 2, createdAt: null });
  const stale = await f.post("creds/accounts/set", { scope: "user", id, expectedVersion: 1, kind: "openai", value });
  expect(stale?.status).toBe(409);
  expect(requests).toBe(0);
  expect(f.writes).toHaveLength(0);
});
test("ordinary keys and non-Azure connections do not contact Azure", async () => {
  for (const [kind, value] of [
    ["openai", "ordinary-key"],
    ["anthropic", "ordinary-key"],
    [
      "openai",
      JSON.stringify({
        endpoint: { version: 1, baseUrl: "https://gateway.example/v1" },
        models: ["model"],
        apiKey: "key",
      }),
    ],
  ] as const)
    await validateAzureModelAccount(kind, value, async () => {
      throw Error("must not contact network");
    });
});
