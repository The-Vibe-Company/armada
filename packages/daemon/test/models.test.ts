import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type TestContext, test } from "node:test";
import { type CoordinatorModel, PROTOCOL_VERSION } from "@armada/protocol";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { generateText, jsonSchema, type LanguageModel, Output } from "ai";
import { z } from "zod";
import { bootDaemon } from "../src/boot.ts";
import { dispatchCredentials } from "../src/credentials.ts";
import { Keychain } from "../src/keychain.ts";
import { ModelRegistry } from "../src/models/registry.ts";
import { fileKeychain } from "../src/secrets/file.ts";
import { startServer } from "../src/server/index.ts";
import { coordinatorModels, loadedModelKinds, modelEnvironment } from "../src/server/models.ts";
import { daemonProjectSchema } from "../src/server/readers.ts";
import { FakeKeychain } from "./support/keychain.ts";
import { nodeExecutable } from "./support/node.ts";

for (const problem of ["malformed", "unavailable"]) {
  test(`armadad remains available to repair ${problem} model credentials`, { timeout: 15000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "armada-model-repair-"));
    const credentials = join(dir, "armada", "desktop", "credentials");
    if (problem === "malformed") await new Keychain(fileKeychain(credentials)).write("coordinator", "coordinator", "{");
    else {
      await mkdir(join(dir, "armada", "desktop"), { recursive: true });
      await writeFile(credentials, "not a credential directory");
    }
    const projects = join(dir, "projects.json");
    await writeFile(projects, "[]");
    const child = spawn(
      nodeExecutable,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => { throw new Error("offline fixture"); };')}`,
        new URL("../src/server/main.ts", import.meta.url).pathname,
        "--database",
        join(dir, "fleet.sqlite"),
        "--projects",
        projects,
      ],
      {
        // A minimal environment keeps ambient model overrides out of this repair case.
        env: { ARMADA_KEYCHAIN: "file", XDG_CONFIG_HOME: dir, ARMADA_APP_CONFIG: join(dir, "config.json") },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = once(child, "exit");
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
      lines.close();
      await rm(dir, { recursive: true, force: true });
    });
    const [line] = await Promise.race([
      once(lines, "line"),
      exited.then(() => {
        throw new Error("daemon exited before readiness");
      }),
    ]);
    const ready = JSON.parse(line);
    assert.match(ready.wsUrl, /^ws:\/\/127\.0\.0\.1:/);
  });
}

test("boot selection preserves saved choices unless the generic environment is explicitly forced, and catalog agrees", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "armada-model-precedence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = randomBytes(24).toString("hex");
  const daemon = await bootDaemon({
    databasePath: ":memory:",
    configPath: join(dir, "config.json"),
    secrets: { get: async () => key },
    log: { info() {}, error() {} },
  });
  t.after(() => daemon.close());
  const savedPi = { provider: "orchard", model: "saved" };
  const savedPlugin = {
    kind: "openai-compatible",
    config: { baseURL: "https://saved.example.test/v1", model: "custom", apiKeySecret: "ARMADA_MODEL_API_KEY" },
  };
  const zaiEnv = { ZAI_BASE_URL: "https://zai.example.test/v1", ZAI_MODEL: "fallback", ZAI_API_KEY: key };
  const zai = {
    kind: "openai-compatible",
    config: { baseURL: zaiEnv.ZAI_BASE_URL, model: "fallback", apiKeySecret: "ZAI_API_KEY" },
  };
  const azureEnv = {
    AZURE_AI_ENDPOINT: "https://azure.example.test/models",
    AZURE_AI_MODEL: "azure",
    AZURE_AI_API_KEY: key,
  };
  const azure = {
    kind: "openai-compatible",
    config: {
      baseURL: azureEnv.AZURE_AI_ENDPOINT,
      model: "azure",
      apiKeySecret: "AZURE_AI_API_KEY",
      apiKeyHeader: "api-key" as const,
    },
  };
  const genericEnv = { ARMADA_MODEL_PROVIDER: "orchard", ARMADA_MODEL_NAME: "override" };
  const generic = { provider: "orchard", model: "override" };
  const pluginEnv = {
    ARMADA_MODEL_KIND: "openai-compatible",
    ARMADA_MODEL_NAME: "override",
    ARMADA_MODEL_BASE_URL: "https://override.example.test/v1",
  };
  const plugin = {
    kind: "openai-compatible",
    config: { model: "override", baseURL: pluginEnv.ARMADA_MODEL_BASE_URL, apiKeySecret: "ARMADA_MODEL_API_KEY" },
  };
  const cases: { name: string; saved?: CoordinatorModel; env: Record<string, string>; expected: CoordinatorModel }[] = [
    { name: "saved pi over ZAI", saved: savedPi, env: zaiEnv, expected: savedPi },
    { name: "saved pi over Azure", saved: savedPi, env: azureEnv, expected: savedPi },
    { name: "saved pi over generic pi", saved: savedPi, env: genericEnv, expected: savedPi },
    { name: "saved pi over generic plugin", saved: savedPi, env: pluginEnv, expected: savedPi },
    { name: "saved plugin over ZAI", saved: savedPlugin, env: zaiEnv, expected: savedPlugin },
    { name: "saved plugin over generic", saved: savedPlugin, env: pluginEnv, expected: savedPlugin },
    { name: "no saved choice uses ZAI", env: zaiEnv, expected: zai },
    { name: "no saved choice uses Azure", env: azureEnv, expected: azure },
    { name: "no saved choice uses generic pi", env: genericEnv, expected: generic },
    { name: "no saved choice uses generic plugin", env: pluginEnv, expected: plugin },
    { name: "force pi override", saved: savedPi, env: { ...genericEnv, ARMADA_MODEL_FORCE: "1" }, expected: generic },
    { name: "force plugin override", saved: savedPi, env: { ...pluginEnv, ARMADA_MODEL_FORCE: "1" }, expected: plugin },
    {
      name: "force does not promote ZAI",
      saved: savedPi,
      env: { ...zaiEnv, ARMADA_MODEL_FORCE: "1" },
      expected: savedPi,
    },
    {
      name: "an incomplete forced provider does not promote ZAI",
      saved: savedPi,
      env: { ...zaiEnv, ARMADA_MODEL_FORCE: "1", ARMADA_MODEL_PROVIDER: "orchard" },
      expected: savedPi,
    },
    { name: "zero is not force", saved: savedPi, env: { ...genericEnv, ARMADA_MODEL_FORCE: "0" }, expected: savedPi },
    {
      name: "true is not force",
      saved: savedPi,
      env: { ...genericEnv, ARMADA_MODEL_FORCE: "true" },
      expected: savedPi,
    },
  ];
  const faux = fauxProvider({ provider: "orchard", models: [{ id: "saved" }, { id: "override" }] });
  for (const entry of cases)
    await t.test(entry.name, async () => {
      const chain = new Keychain(new FakeKeychain());
      if (entry.saved) {
        if ("provider" in entry.saved) await chain.selectCoordinator(entry.saved);
        else await chain.setCoordinator(entry.saved.kind, key, entry.saved.config);
      }
      const access = await modelEnvironment(entry.env, chain);
      assert.deepEqual(access.selected, entry.expected);
      const pi = new ModelRegistry({
        keychain: chain,
        env: entry.env,
        providers: [faux.provider],
        selected: access.selected,
      });
      const config = coordinatorModels({
        projects: [{ id: "p" }],
        store: daemon.store,
        registry: daemon.registry,
        pi,
        selected: (await pi.selection()) ?? undefined,
        pluginSelected: access.pluginSelected,
      })[0];
      assert.ok(config);
      assert.deepEqual(config.selection, entry.expected);
      assert.deepEqual((await pi.catalog()).selected, entry.expected);
      assert.equal(config.model.provider, "provider" in entry.expected ? entry.expected.provider : entry.expected.kind);
      assert.equal(
        config.model.modelId,
        "model" in entry.expected ? entry.expected.model : entry.expected.config.model,
      );
    });
});

function pluginConfig(selection: CoordinatorModel | undefined) {
  assert.ok(selection && "kind" in selection);
  return selection.config;
}

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
    const sdk = provider.create("conformance-model", pluginConfig(access.selected)) as LanguageModel;
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
      selected: { kind, config: { ...pluginConfig(access.selected), model: "replacement-model" } },
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
  assert.equal(pluginConfig(saved.selected).model, "saved-model");
  assert.equal((await saved.secrets.get("ARMADA_MODEL_API_KEY")) === key, true);
  const custom = new Keychain(new FakeKeychain());
  await custom.setCoordinator("custom", key, { model: "custom", apiKeySecret: "CUSTOM_API_KEY" });
  const customAccess = await modelEnvironment({}, custom);
  assert.equal(pluginConfig(customAccess.selected).apiKeySecret, "CUSTOM_API_KEY");
  assert.equal((await customAccess.secrets.get("CUSTOM_API_KEY")) === key, true);
  assert.equal(await customAccess.secrets.get("ARMADA_MODEL_API_KEY"), null);
  await chain.write("github", "github", key);
  assert.equal((await saved.secrets.get("GITHUB_TOKEN")) === key, true);
  const zai = await modelEnvironment(
    { ZAI_BASE_URL: "https://api.z.ai/api/coding/paas/v4", ZAI_MODEL: "glm-5.3-flash", ZAI_API_KEY: key },
    new Keychain(new FakeKeychain()),
  );
  assert.equal(pluginConfig(zai.selected).apiKeySecret, "ZAI_API_KEY");
  const azure = await modelEnvironment(
    { AZURE_AI_ENDPOINT: "https://example.invalid/models", AZURE_AI_MODEL: "DeepSeek", AZURE_AI_API_KEY: key },
    new Keychain(new FakeKeychain()),
  );
  assert.equal(pluginConfig(azure.selected).model, "DeepSeek");
  const named = new Keychain(new FakeKeychain());
  for (const [name, value] of Object.entries({
    ARMADA_MODEL_KIND: "openai-compatible",
    ARMADA_MODEL_NAME: "keychain-model",
    ARMADA_MODEL_BASE_URL: "http://localhost/v1",
    ARMADA_MODEL_API_KEY: key,
  }))
    await named.write("plugin", name, value);
  const generic = await modelEnvironment({}, named);
  assert.equal(pluginConfig(generic.selected).model, "keychain-model");
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
  await chain.setCoordinator("openai-compatible", key, pluginConfig(saved.selected));

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
  const invalid = await modelEnvironment(
    { ARMADA_MODEL_KIND: "bad kind", ARMADA_MODEL_BASE_URL: "invalid", ARMADA_MODEL_FORCE: "1" },
    chain,
  );
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
            coordinatorModel: {
              kind: "openai-compatible",
              config: { ...pluginConfig(saved.selected), model: "rule-model" },
            },
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
