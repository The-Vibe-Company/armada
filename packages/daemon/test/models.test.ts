import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { PROTOCOL_VERSION } from "@armada/protocol";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { generateText, jsonSchema, type LanguageModel, Output } from "ai";
import { z } from "zod";
import { bootDaemon } from "../src/boot.ts";
import { dispatchCredentials } from "../src/credentials.ts";
import { Keychain } from "../src/keychain.ts";
import { startServer } from "../src/server/index.ts";
import { coordinatorModels, loadedModelKinds, modelEnvironment } from "../src/server/models.ts";
import { daemonProjectSchema } from "../src/server/readers.ts";
import { FakeKeychain } from "./support/keychain.ts";

interface FixtureBody {
  model?: string;
  messages: { role: string; content?: string | { type: string }[]; reasoning_content?: string }[];
  tools?: { name?: string; function?: { name: string } }[];
  response_format?: unknown;
  output_config?: unknown;
}

async function endpoint(t: TestContext, key: string) {
  const requests: FixtureBody[] = [];
  let failure = false;
  let blocked = false;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as FixtureBody;
    requests.push(body);
    assert.equal(
      req.headers.authorization === `Bearer ${key}` ||
        req.headers["x-api-key"] === key ||
        req.headers["api-key"] === key,
      true,
    );
    if (failure) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: key } }));
      return;
    }
    const anthropic = req.url?.endsWith("/messages");
    const fixture = JSON.parse(
      await readFile(new URL("../../plugin-api/fixtures/model/response.json", import.meta.url), "utf8"),
    ).response;
    const isToolResult = body.messages.some(
      (message) =>
        message.role === "tool" ||
        (Array.isArray(message.content) && message.content.some((part) => part.type === "tool_result")),
    );
    const structured = body.response_format || body.output_config;
    if (anthropic && body.tools?.some((tool) => tool.name === "json")) {
      fixture.content = [{ type: "tool_use", id: "structured", name: "json", input: { ready: true } }];
    } else if (isToolResult || structured) {
      const text = structured ? '{"ready":true}' : "Fleet checked";
      if (anthropic) {
        fixture.content = [{ type: "text", text }];
        fixture.stop_reason = "end_turn";
      } else {
        fixture.choices[0].message = { role: "assistant", content: text };
        fixture.choices[0].finish_reason = "stop";
      }
    } else if (body.tools?.some((tool) => (tool.function?.name ?? tool.name) === "fleet.status")) {
      if (anthropic) {
        fixture.content[0].name = "fleet.status";
        fixture.content[0].input = {};
      } else {
        fixture.choices[0].message.tool_calls[0].function = { name: "fleet.status", arguments: "{}" };
      }
    }
    if (blocked) {
      fixture.stop_reason = "refusal";
      fixture.choices[0].finish_reason = "content_filter";
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(fixture));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/model`,
    requests,
    block: () => {
      blocked = true;
    },
    fail: () => {
      failure = true;
    },
  };
}

for (const kind of ["anthropic", "openai-compatible"]) {
  test(`${kind} plugin supplies SDK tools/structured JSON and the durable coordinator consumes its tool result without persisting credentials`, {
    timeout: 15000,
  }, async (t) => {
    const key = randomBytes(24).toString("hex");
    const remote = await endpoint(t, key);
    const dir = await mkdtemp(join(tmpdir(), "armada-models-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const access = await modelEnvironment(
      {
        ARMADA_MODEL_KIND: kind,
        ARMADA_MODEL_NAME: "conformance-model",
        ARMADA_MODEL_BASE_URL: remote.url,
        ARMADA_MODEL_API_KEY: key,
      },
      new Keychain(new FakeKeychain()),
    );
    const logs: string[] = [];
    const daemon = await bootDaemon({
      databasePath: ":memory:",
      configPath: join(dir, "config.json"),
      secrets: access.secrets,
      log: { info: (line) => logs.push(line), error: (line) => logs.push(line) },
    });
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    t.after(async () => {
      await server?.close();
      daemon.close();
    });
    assert.equal(
      loadedModelKinds(daemon.registry).some((entry) => entry.kind === kind),
      true,
    );
    const provider = daemon.registry.get("model", kind);
    assert.ok(provider);
    const sdk = provider.create("conformance-model", access.selected?.config) as LanguageModel;
    const result = await generateText({
      model: sdk,
      prompt: "Call conformance_echo",
      tools: {
        conformance_echo: {
          inputSchema: jsonSchema({
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          }),
        },
      },
      maxRetries: 0,
    });
    assert.equal(result.toolCalls[0]?.toolName, "conformance_echo");
    assert.deepEqual(result.toolCalls[0]?.input, { message: "fixture-tool-call" });
    const json = await generateText({
      model: sdk,
      prompt: "Return ready",
      output: Output.object({ schema: z.object({ ready: z.boolean() }) }),
      maxRetries: 0,
    });
    assert.deepEqual(json.output, { ready: true });
    const configs = coordinatorModels({
      projects: [{ id: "p" }],
      store: daemon.store,
      registry: daemon.registry,
      selected: access.selected,
    });
    assert.equal(configs.length, 1);
    server = await startServer({
      store: daemon.store,
      projects: [{ id: "p", name: "Project", repository: "example/project" }],
      coordinators: configs,
    });
    const coordinator = server.coordinators.get("p");
    assert.ok(coordinator);
    assert.equal(
      (
        await (
          await coordinator.conversation.submit({ type: "input", content: "Check the fleet" }, context)
        ).wait(context)
      ).status,
      "done",
    );
    assert.equal(remote.requests.length, 4);
    if (kind === "openai-compatible") {
      const request = remote.requests[3];
      assert.equal(
        request?.messages.some(
          (message) => message.role === "assistant" && message.reasoning_content === "fixture-reasoning",
        ),
        true,
      );
    }
    assert.equal(
      JSON.stringify(remote.requests[3]).includes("tool_result") ||
        JSON.stringify(remote.requests[3]).includes('"role":"tool"'),
      true,
    );
    await server.close();
    const replacement = coordinatorModels({
      projects: [{ id: "p" }],
      store: daemon.store,
      registry: daemon.registry,
      selected: { kind, config: { ...access.selected?.config, model: "replacement-model" } },
    });
    server = await startServer({
      store: daemon.store,
      projects: [{ id: "p", name: "Project", repository: "example/project" }],
      coordinators: replacement,
    });
    const reopened = server.coordinators.get("p");
    assert.ok(reopened);
    assert.equal((await reopened.conversation.agent(context)).model?.modelId, "replacement-model");
    assert.equal(
      (await (await reopened.conversation.submit({ type: "input", content: "Check again" }, context)).wait(context))
        .status,
      "done",
    );
    assert.equal(remote.requests.at(-1)?.model, "replacement-model");
    const config = configs[0];
    assert.ok(config);
    const models = typeof config.models === "function" ? config.models() : config.models;
    const model = models.getModel(config.model.provider, config.model.modelId);
    assert.ok(model);
    remote.block();
    const filtered = await models.completeSimple(model, {
      messages: [{ role: "user", content: "Filtered", timestamp: 0 }],
      tools: [
        {
          name: "conformance_echo",
          description: "Echo",
          parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
        },
      ],
    });
    assert.equal(filtered.stopReason, "error");
    assert.equal(
      filtered.content.some((part) => part.type === "toolCall"),
      false,
    );
    remote.fail();

    const failed = await models.completeSimple(model, { messages: [{ role: "user", content: "Fail", timestamp: 0 }] });
    assert.equal(failed.errorMessage, "Model request failed");
    assert.equal(JSON.stringify([daemon.store.readSince(0), logs, failed]).includes(key), false);
    await server.close();
  });
}

test("model boot honors project rules over env, recognizes z.ai/Azure and saved catalog credentials, and skips disabled providers", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "armada-model-selection-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const chain = new Keychain(new FakeKeychain());
  const key = randomBytes(24).toString("hex");
  await chain.setCoordinator("openai-compatible", key, { baseURL: "http://localhost/v1", model: "saved-model" });
  const saved = await modelEnvironment({}, chain);
  assert.equal(saved.selected?.config.model, "saved-model");
  assert.equal((await saved.secrets.get("ARMADA_MODEL_API_KEY")) === key, true);
  const custom = new Keychain(new FakeKeychain());
  await custom.setCoordinator("custom", key, { model: "custom", apiKeySecret: "CUSTOM_API_KEY" });
  const customAccess = await modelEnvironment({}, custom);
  assert.equal(customAccess.selected?.config.apiKeySecret, "CUSTOM_API_KEY");
  assert.equal((await customAccess.secrets.get("CUSTOM_API_KEY")) === key, true);
  assert.equal(await customAccess.secrets.get("ARMADA_MODEL_API_KEY"), null);
  await chain.write("github", "github", key);
  assert.equal((await saved.secrets.get("GITHUB_TOKEN")) === key, true);
  const zai = await modelEnvironment(
    { ZAI_BASE_URL: "https://api.z.ai/api/coding/paas/v4", ZAI_MODEL: "glm-5.3-flash", ZAI_API_KEY: key },
    chain,
  );
  assert.equal(zai.selected?.config.apiKeySecret, "ZAI_API_KEY");
  const azure = await modelEnvironment(
    { AZURE_AI_ENDPOINT: "https://example.invalid/models", AZURE_AI_MODEL: "DeepSeek", AZURE_AI_API_KEY: key },
    chain,
  );
  assert.equal(azure.selected?.config.model, "DeepSeek");
  const named = new Keychain(new FakeKeychain());
  for (const [name, value] of Object.entries({
    ARMADA_MODEL_KIND: "openai-compatible",
    ARMADA_MODEL_NAME: "keychain-model",
    ARMADA_MODEL_BASE_URL: "http://localhost/v1",
    ARMADA_MODEL_API_KEY: key,
  }))
    await named.write("plugin", name, value);
  const generic = await modelEnvironment({}, named);
  assert.equal(generic.selected?.config.model, "keychain-model");
  assert.equal((await generic.secrets.get("ARMADA_MODEL_API_KEY")) === key, true);
  await named.write("coordinator", "coordinator", JSON.stringify({ provider: "openai", key }));
  const legacy = await named.coordinator();
  assert.equal(legacy?.provider, "openai-compatible");
  assert.equal(legacy?.config?.baseURL, "https://api.openai.com/v1");
  const legacyOnly = new Keychain(new FakeKeychain());
  await legacyOnly.write("coordinator", "coordinator", JSON.stringify({ provider: "openai", key }));
  const legacyAccess = await modelEnvironment({}, legacyOnly);
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify({ plugins: [{ id: "model-anthropic", enabled: false }] }));
  const daemon = await bootDaemon({
    databasePath: ":memory:",
    configPath: path,
    secrets: saved.secrets,
    log: { info() {}, error() {} },
  });
  t.after(() => daemon.close());
  assert.deepEqual(
    loadedModelKinds(daemon.registry).map((entry) => entry.kind),
    ["openai-compatible"],
  );
  assert.equal(
    coordinatorModels({
      projects: [{ id: "legacy" }],
      store: daemon.store,
      registry: daemon.registry,
      selected: legacyAccess.selected,
    })[0]?.model.modelId,
    "gpt-4.1-mini",
  );
  const kinds = loadedModelKinds(daemon.registry);
  const emptyChain = new Keychain(new FakeKeychain());
  assert.equal(await emptyChain.coordinator(), null);
  const rejected = await dispatchCredentials(
    { type: "credentials.set", version: PROTOCOL_VERSION, id: "blank", provider: "openai-compatible", key, config: {} },
    emptyChain,
    kinds,
  );
  assert.equal(rejected.type, "error");
  assert.equal((await chain.coordinator())?.config?.model, "saved-model");
  const azureConfig = {
    model: "DeepSeek",
    baseURL: "https://example.invalid/models",
    apiKeyHeader: "api-key" as const,
    supportsStructuredOutputs: false,
  };
  await chain.setCoordinator("openai-compatible", key, azureConfig);
  const rotated = await dispatchCredentials(
    {
      type: "credentials.set",
      version: PROTOCOL_VERSION,
      id: "rotate",
      provider: "openai-compatible",
      key,
      config: { model: "DeepSeek-next", baseURL: azureConfig.baseURL },
    },
    chain,
    kinds,
  );
  assert.equal(rotated.type, "credentials.result");
  assert.deepEqual((await chain.coordinator())?.config, {
    ...azureConfig,
    model: "DeepSeek-next",
    apiKeySecret: "OPENAI_API_KEY",
  });
  await chain.setCoordinator("openai-compatible", key, saved.selected?.config);

  const skipped: string[] = [];
  assert.equal(
    coordinatorModels({
      projects: [{ id: "p", coordinatorModel: { kind: "anthropic", config: {} } }],
      store: daemon.store,
      registry: daemon.registry,
      selected: saved.selected,
      onSkipped: (project) => skipped.push(project),
    }).length,
    0,
  );
  assert.deepEqual(skipped, ["p"]);
  const invalid = await modelEnvironment({ ARMADA_MODEL_KIND: "bad kind", ARMADA_MODEL_BASE_URL: "invalid" }, chain);
  const malformed = daemonProjectSchema.parse({
    id: "bad",
    name: "Bad",
    repository: "example/bad",
    coordinatorModel: { kind: "bad kind", config: {} },
  });
  assert.equal(
    coordinatorModels({
      projects: [{ id: "bad-env" }],
      store: daemon.store,
      registry: daemon.registry,
      selected: invalid.selected,
      onSkipped: (id) => skipped.push(id),
    }).length,
    0,
  );
  const configs = coordinatorModels({
    projects: [malformed, { id: "p" }],
    onSkipped: (id) => skipped.push(id),
    store: daemon.store,
    registry: daemon.registry,
    selected: saved.selected,
  });
  assert.equal(configs[0]?.model.modelId, "saved-model");
  assert.deepEqual(skipped, ["p", "bad-env", "bad"]);
  daemon.store.append({
    project: "p",
    actor: "coordinator",
    at: "2030-01-01T00:00:00Z",
    kind: "coordinator.checkpoint",
    payload: {
      checkpoint: {
        format: "armada.tools",
        version: 1,
        type: "rules",
        rules: {
          revision: 1,
          value: {
            coordinatorModel: { kind: "openai-compatible", config: { ...saved.selected?.config, model: "rule-model" } },
          },
        },
      },
    },
  });
  assert.equal(
    coordinatorModels({
      projects: [{ id: "p" }],
      store: daemon.store,
      registry: daemon.registry,
      selected: saved.selected,
    })[0]?.model.modelId,
    "rule-model",
  );
});
