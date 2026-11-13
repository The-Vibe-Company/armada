import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { listConnectionModels, resolveCredentials } from "../src/credentials.ts";
import { encryptSecret } from "../src/crypto.ts";
import {
  CONNECTION_PRESETS,
  connectionModelList,
  connectionPreset,
  parseCredentialValue,
  presetConnectionValue,
  presetModels,
  VaultError,
} from "../src/index.ts";

function preset(id: string) {
  const found = connectionPreset(id);
  if (!found) throw Error(`missing preset ${id}`);
  return found;
}

test("every preset names a model credential kind and offers its catalog's models", () => {
  expect(CONNECTION_PRESETS.map((entry) => entry.id)).toEqual([
    "openai",
    "anthropic",
    "opencode-anthropic",
    "opencode",
    "deepseek",
    "azure-foundry",
    "opencode-azure",
    "openrouter",
    "openai-compatible",
  ]);
  for (const entry of CONNECTION_PRESETS) {
    if (entry.models === "harness") expect(entry.baseUrl).toBeNull();
    if (entry.catalog) expect(presetModels(entry).length).toBeGreaterThan(0);
  }
  expect(presetModels(preset("openai-compatible"))).toEqual([]);
});

test("a DeepSeek connection saves an OpenCode endpoint at the fixed address with catalog prices only", () => {
  const deepseek = preset("deepseek");
  const [known] = presetModels(deepseek);
  if (!known) throw Error("empty catalog");
  const key = randomUUID();
  const value = JSON.parse(
    presetConnectionValue(deepseek, {
      // A fixed address cannot be redirected by the form.
      baseUrl: "https://attacker.example",
      apiKey: ` ${key} `,
      models: [known.id, "hand-typed-model", known.id],
    }),
  );
  expect(value).toEqual({
    endpoint: { version: 1, baseUrl: "https://api.deepseek.com", models: [known.id, "hand-typed-model"] },
    apiKey: key,
    // OpenCode reports a connection's model as armada/<id>: prices use the reported ID.
    prices: {
      [`armada/${known.id}`]: {
        input: known.input,
        output: known.output,
        cacheRead: known.cacheRead,
        cacheWrite: null,
        reasoning: null,
      },
    },
  });
});

test("an Azure AI Foundry connection saves a Codex endpoint with its deployments and API version", async () => {
  const key = randomUUID();
  const value = presetConnectionValue(preset("azure-foundry"), {
    baseUrl: "https://resource.services.ai.azure.com/openai/v1/responses",
    apiKey: key,
    models: ["my-deployment"],
    apiVersion: "preview",
  });
  expect(JSON.parse(value)).toEqual({
    endpoint: { version: 1, baseUrl: "https://resource.services.ai.azure.com/openai/v1", apiVersion: "preview" },
    apiKey: key,
    models: ["my-deployment"],
  });
  // The models list is server-side metadata: the sandbox receives only the endpoint and the key.
  const secret = randomBytes(32).toString("base64");
  const valueEnc = await encryptSecret(value, secret);
  const reader = {
    credentials: async (scope: string) => (scope === "user" ? [{ id: "a", kind: "openai" as const, valueEnc }] : []),
    orgBoatKey: async () => null,
  };
  const resolved = await resolveCredentials(reader, secret, { userId: "u", orgId: "o", harness: "codex" });
  expect(JSON.parse(resolved.env.ARMADA_CODEX_ENDPOINT ?? "")).not.toHaveProperty("models");
  expect(JSON.stringify(resolved)).not.toContain("my-deployment");
});

test("a custom OpenAI connection's models are validated by the server parser", () => {
  const raw = (models: unknown) =>
    JSON.stringify({ endpoint: { version: 1, baseUrl: "https://gateway.example/v1" }, apiKey: "k", models });
  expect(JSON.parse(parseCredentialValue("openai", raw(["a", "a", "b"]))).models).toEqual(["a", "b"]);
  for (const bad of [[], ["has space"], Array.from({ length: 33 }, (_, index) => `m${index}`), "m"])
    expect(() => parseCredentialValue("openai", raw(bad))).toThrow(VaultError);
});

test("preset input errors never repeat the key", () => {
  const key = randomUUID();
  const cases: [string, Parameters<typeof presetConnectionValue>[1]][] = [
    ["openai-compatible", { baseUrl: "http://plain.example/v1", apiKey: key, models: ["m"] }],
    ["openai-compatible", { baseUrl: "https://ok.example/v1", apiKey: key, models: [] }],
    ["openai-compatible", { baseUrl: "https://ok.example/v1", apiKey: `${key} x`, models: ["m"] }],
    ["openrouter", { baseUrl: "", apiKey: key, models: ["bad model"] }],
    ["deepseek", { baseUrl: "", apiKey: key, models: ["m"], apiVersion: "1" }],
    ["openai", { baseUrl: "", apiKey: key, models: ["m"] }],
  ];
  for (const [id, input] of cases) {
    let message = "";
    try {
      presetConnectionValue(preset(id), input);
    } catch (error) {
      expect(error).toBeInstanceOf(VaultError);
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(key);
  }
});

test("ticked and typed model IDs merge in order without duplicates", () => {
  expect(connectionModelList(["a", "b"], " b, c\nd  ,, ")).toEqual(["a", "b", "c", "d"]);
});

test("a connection lists its declared models with saved prices, never its key or address", async () => {
  const secret = randomBytes(32).toString("base64");
  const deepseek = presetConnectionValue(preset("deepseek"), {
    baseUrl: "",
    apiKey: "sk-deepseek-secret",
    models: ["deepseek-flash", "typed-model"],
  });
  const azure = presetConnectionValue(preset("azure-foundry"), {
    baseUrl: "https://resource.services.ai.azure.com/openai/v1",
    apiKey: "azure-secret",
    models: ["my-deployment"],
  });
  const row = async (id: string, kind: "opencode" | "openai" | "anthropic", value: string, status = "active") => ({
    id,
    kind,
    status,
    valueEnc: await encryptSecret(value, secret),
  });
  const rows = {
    user: [
      await row("a", "opencode", deepseek),
      await row("b", "opencode", "plain-plan-key"),
      await row("c", "openai", azure, "revoked"),
    ],
    org: [await row("d", "openai", azure), await row("e", "anthropic", "sk-ant")],
  };
  const reader = {
    credentials: async (scope: "user" | "org", owner: string) => (owner === "x" ? [] : rows[scope]),
    orgBoatKey: async () => null,
  };
  const listed = await listConnectionModels(reader, secret, { userId: "u", orgId: "o" });
  const flash = presetModels(preset("deepseek")).find((model) => model.id === "deepseek-flash");
  expect(listed).toEqual([
    {
      id: "a",
      scope: "user",
      models: [
        { model: "armada/deepseek-flash", input: flash?.input ?? null, output: flash?.output ?? null },
        { model: "armada/typed-model", input: null, output: null },
      ],
    },
    { id: "d", scope: "org", models: [{ model: "my-deployment", input: null, output: null }] },
  ]);
  expect(JSON.stringify(listed)).not.toMatch(/secret|sk-|azure\.com|deepseek\.com/);
  // A value that cannot be decrypted is left out instead of failing the list.
  expect(await listConnectionModels(reader, randomBytes(32).toString("base64"), { userId: "u", orgId: "o" })).toEqual(
    [],
  );
});

// Protect the form-to-sealed-credential boundary: the fixed route cannot be redirected by browser input.
test("Anthropic for OpenCode saves a Messages connection rather than a chat-completions connection", () => {
  const value = JSON.parse(
    presetConnectionValue(preset("opencode-anthropic"), {
      apiKey: "fake-anthropic-key",
      baseUrl: "https://wrong.example",
      models: ["claude-test"],
    }),
  );
  expect(value.endpoint).toEqual({
    version: 1,
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-test"],
  });
  expect(value.apiKey).toBe("fake-anthropic-key");
  expect(() =>
    parseCredentialValue(
      "opencode",
      JSON.stringify({ ...value, endpoint: { ...value.endpoint, protocol: "arbitrary-package" } }),
    ),
  ).toThrow(VaultError);
});

test("Azure for OpenCode saves v1 deployment names and refuses legacy versioned URLs", () => {
  const make = (baseUrl: string) =>
    presetConnectionValue(preset("opencode-azure"), {
      apiKey: "fake-azure-key",
      baseUrl,
      models: ["my-deployment"],
    });
  const value = JSON.parse(make("https://resource.services.ai.azure.com/openai/v1/responses"));
  expect(value.endpoint).toEqual({
    version: 1,
    protocol: "azure",
    baseUrl: "https://resource.services.ai.azure.com/openai/v1",
    models: ["my-deployment"],
  });
  expect(value.apiKey).toBe("fake-azure-key");
  for (const url of [
    "https://resource.openai.azure.com/openai/deployments/model",
    "https://resource.openai.azure.com/openai/v1?api-version=preview",
  ])
    expect(() => make(url)).toThrow(VaultError);
});
