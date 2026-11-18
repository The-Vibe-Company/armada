import { describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import helperManifest from "../helper/manifest.json";
import {
  type AgentEvent,
  CODEX_AUTH_PATH,
  dedupeEvents,
  type ForkRequest,
  GH_MISSING_NOTE,
  type GitHubAccess,
  GOLDEN_ROOT,
  type GoldenActor,
  type GoldenRecord,
  type GoldenStore,
  type HarnessCredentials,
  LaunchError,
  type LaunchOptions,
  type LaunchStores,
  launchSandbox,
  type PromptStatus,
  type Provider,
  ProviderError,
  parseGoldenConfig,
  promptOutcome,
  type SandboxInfo,
  type SandboxPatch,
  type SandboxRecord,
  type SandboxStore,
  toHarnessCredentials,
} from "../src/index.ts";
import { prepareLaunchWorkspace } from "../src/launch.ts";
import { catalogLock, catalogReference } from "./support/skillpack-catalog.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const SNAPSHOT = `a${"1".repeat(62)}`;
const CLAUDE_TOKEN = "claude_user_token";
const OPENAI_KEY = "sk-openai-user-key-value";
const AUTH_JSON = JSON.stringify({ tokens: { access_token: "codex-access-token-value", account_id: "acct" } });
const authCredentials = () =>
  toHarnessCredentials({
    env: {},
    files: [{ path: CODEX_AUTH_PATH, content: AUTH_JSON, mode: 0o600 }],
    sources: [],
  });

const GITHUB_TOKEN = `ghu_${"launch_test_token_aaaaaaaaaaaaaaaaaaaa"}`;
const IDENTITY = {
  login: "octocat",
  id: 583231,
  name: "The Octocat",
  email: "583231+octocat@users.noreply.github.com",
};

const owner: GoldenActor = { userId: OWNER, orgId: ORG, role: "member" };
const other: GoldenActor = { userId: OTHER, orgId: ORG, role: "member" };

describe("launch", () => {
  for (const provider of ["boat", "modal"] as const)
    test.each([true, false])(
      `${provider} ordinary runtime default prepares workspace before publication/inference (prompt=%s)`,
      async (prompted) => {
        const source = golden("org");
        const world = setup({
            golden: {
              ...source,
              provider,
              ...(provider === "modal"
                ? {
                    providerSandboxId: "modal-builder",
                    providerSnapshotId: "modal-image",
                    modal: { workspace: "ws", environment: "main", appId: "app" },
                  }
                : {}),
            },
          }),
          order: string[] = [],
          commands: string[] = [];
        const childId = provider === "modal" ? "modal-child" : "bx_1";
        const compute: Provider = {
          ...world.provider,
          id: provider,
          async fork(request) {
            return { ...(await world.provider.fork(request)), id: childId };
          },
          async get(id, options) {
            return { ...(await world.provider.get(id, options)), id: childId };
          },
        };
        const native: Provider = {
          ...world.provider,
          id: provider,
          async fork() {
            throw Error("Native fork must not run under the default");
          },
        };
        const resolve = world.stores.credentials.resolve.bind(world.stores.credentials);
        const credentials = {
          ...world.stores.credentials,
          async resolve(...args: Parameters<typeof resolve>) {
            return { ...(await resolve(...args)), binding: { credentialId: OWNER, credentialVersion: 1 } };
          },
        };
        const result = await launchSandbox(
          native,
          world.stores,
          owner,
          { golden: "web", harness: "codex", ...(prompted ? { prompt: "ordinary request" } : {}) },
          {
            beforeStart: async () => {
              order.push("admit");
            },
            [provider === "boat" ? "boatRuntimeDefault" : "modalRuntimeDefault"]: {
              provider: async () => compute,
              credentials,
              connections: {
                async validate() {},
                async bind() {
                  order.push("bind");
                },
                async prepare() {
                  order.push("mcp");
                },
              },
              policy: {
                async start() {
                  order.push("start");
                  return {
                    epoch: "1",
                    async prepareWorkspace(g, onStage, _sleep) {
                      order.push("workspace");
                      let retry = false;
                      await prepareLaunchWorkspace(
                        {
                          id: provider,
                          exec: async () => {
                            throw Error("No native exec");
                          },
                        },
                        "bx_1",
                        "logical",
                        g,
                        [],
                        onStage,
                        async (ms) => {
                          expect(ms).toBe(1000);
                          retry = true;
                        },
                        async (req, step) => {
                          commands.push(`${step.phase}:${step.index}:${step.attempt}:${req.cwd}:${req.command}`);
                          return {
                            detached: false as const,
                            timedOut: false,
                            truncated: false,
                            exitCode: step.phase === "repository" && step.index === 0 && step.attempt === 0 ? 128 : 0,
                            stdout: "",
                            stderr:
                              step.phase === "repository" && step.index === 0 && step.attempt === 0
                                ? "detected dubious ownership in repository"
                                : "",
                          };
                        },
                      );
                      expect(retry).toBe(true);
                      return { status: "not_connected" };
                    },
                    async prompt() {
                      expect(order).toEqual(["bind", "start", "workspace", "mcp", "admit"]);
                      return { promptId: "runtime", conversationId: "conversation", status: "queued" };
                    },
                  };
                },
              },
            } satisfies NonNullable<LaunchOptions["boatRuntimeDefault"]>,
          },
        );
        expect(result.runtime).toEqual({ kind: "armada", epoch: "1" });
        expect(result.sandbox.provider).toBe(provider);
        expect(result.sandbox.providerSandboxId).toBe(childId);
        expect(result.sandbox.runtimeTransport).toBe(provider === "modal" ? "dialout" : undefined);
        expect(result.sandbox.boatRuntime).toBe(provider === "boat" ? true : undefined);
        expect(order).toEqual(["bind", "start", "workspace", "mcp", "admit"]);
        if (!prompted) {
          expect(result.sandbox.status).toBe("ready");
          expect(result.sandbox.conversationIds).toEqual([]);
          expect(result.promptId).toBeUndefined();
        }
        expect(commands).toHaveLength(4);
        expect(commands[0]).toContain("repository:0:0:/home/user/web:");
        expect(commands[1]).toContain("repository:0:1:");
        expect(commands[2]).toContain("repository:1:0:/home/user/api:");
        expect(commands[3]).toContain("init:0:0:/home/user:");
        expect(world.execs).toHaveLength(0);
        expect(world.prompts).toHaveLength(0);
        expect(world.forks[0]?.env).toEqual({});
      },
    );
  test.each(["startup", "account", "secret", "provider"] as const)(
    "Modal default refuses %s without native fallback",
    async (failure) => {
      const world = setup({
        golden: {
          ...golden("org"),
          provider: "modal",
          providerSandboxId: "master",
          providerSnapshotId: "image",
          modal: { workspace: "ws", environment: "main", appId: "app" },
        },
      });
      let nativeForks = 0;
      const native: Provider = {
        ...world.provider,
        id: "modal",
        async fork() {
          nativeForks++;
          throw Error("Native fallback forbidden");
        },
      };
      const compute: Provider = {
        ...world.provider,
        id: "modal",
        async fork(request) {
          return { ...(await world.provider.fork(request)), id: "modal-child" };
        },
        async get(id, opts) {
          return { ...(await world.provider.get(id, opts)), id: "modal-child" };
        },
      };
      const resolve = world.stores.credentials.resolve.bind(world.stores.credentials);
      await expect(
        launchSandbox(
          native,
          world.stores,
          owner,
          { golden: "web", harness: "codex", prompt: "answer" },
          {
            nativeSecretBindings: failure === "secret",
            modalRuntimeDefault: {
              provider: async () => (failure === "provider" ? { ...compute, id: "boat" } : compute),
              credentials: {
                async resolve(...args) {
                  const credentials = await resolve(...args);
                  return {
                    ...credentials,
                    ...(failure !== "account" ? { binding: { credentialId: OWNER, credentialVersion: 1 } } : {}),
                  };
                },
              },
              connections: { async validate() {}, async bind() {} },
              policy: {
                async start() {
                  throw Error("Private startup failure");
                },
              },
            },
          },
        ),
      ).rejects.toMatchObject({ code: failure === "startup" ? "start_failed" : "invalid_request" });
      expect(nativeForks).toBe(0);
      expect(world.prompts).toEqual([]);
      expect(world.execs).toEqual([]);
      expect(world.forks).toHaveLength(failure === "startup" ? 1 : 0);
    },
  );
  test.each(["key", "auth", "opencode"] as const)(
    "experimental %s launch hands off after persisted selection, never native setup/prompt",
    async (kind) => {
      const world = setup({
        golden: golden("org"),
        github: { status: "connected", token: GITHUB_TOKEN, identity: IDENTITY },
        ...(kind === "auth" ? { credentials: authCredentials() } : {}),
      });
      world.stores.credentials.hydrateNative = async () => {
        throw Error("must not hydrate native Boat");
      };
      if (kind === "key") {
        const resolve = world.stores.credentials.resolve.bind(world.stores.credentials);
        world.stores.credentials.resolve = async (...args) => {
          const value = await resolve(...args);
          return {
            ...value,
            env: { ...value.env, ARMADA_CODEX_ENDPOINT: '{"version":1,"baseUrl":"https://model.example"}' },
          };
        };
      }
      if (kind === "opencode") {
        world.stores.credentials.resolve = async () => ({
          env: { OPENCODE_API_KEY: "opencode_key" },
          secrets: ["opencode_key"],
          codexAuthJson: false,
        });
        await expect(
          launchSandbox(world.provider, world.stores, owner, {
            golden: "web",
            harness: "opencode",
            model: "opencode/model",
          }),
        ).rejects.toMatchObject({ code: "invalid_request" });
        expect(world.forks).toHaveLength(0);
      }
      const pins = ["catalog/public-skill@1.2.3", "private-skill@2.3.4"];
      const skillKey = `cmp_pat_${"a".repeat(48)}`;
      world.stores.skillDefaults = {
        async resolve() {
          return { environment: pins, org: [], personal: [] };
        },
      };
      world.stores.credentials.skillpackKey = async () => skillKey;
      world.stores.credentials.installPrivateSkill = async () => {
        throw Error("No native skill install");
      };
      let recorded: unknown;
      world.stores.sandboxes.recordSkills = async (_id, receipts) => {
        recorded = receipts;
      };
      const order: string[] = [];
      world.stores.connections = {
        async defaults() {
          return [ORG];
        },
        async validate(_actor, ids) {
          expect(ids).toEqual([ORG]);
        },
        async bind(_id, ids) {
          expect(ids).toEqual([ORG]);
          order.push("bind");
        },
        async prepare(_provider, record, _actor, signal) {
          expect(record.boatRuntime).toBe(true);
          expect(signal?.aborted).toBe(false);
          expect(order).toEqual(["bind", "start", "workspace", "skills"]);
          order.push("mcp");
        },
      };
      const calls: Parameters<Provider["prompt"]>[0][] = [];
      const result = await launchSandbox(
        world.provider,
        world.stores,
        owner,
        {
          golden: "web",
          harness: kind === "opencode" ? "opencode" : "codex",
          repo: "web",
          prompt: "runtime answer",
          model: kind === "opencode" ? "opencode/model" : "gpt-5.4",
          reasoningEffort: kind === "opencode" ? "default" : "high",
          ...(kind === "auth" ? { connections: [ORG] } : {}),
        },
        {
          boatRuntime: {
            async start(input) {
              order.push("start");
              expect(input.sandbox.boatRuntime).toBe(true);
              expect(world.rows.get(input.sandbox.id)?.boatRuntime).toBe(true);
              expect(input.credentials.codexAuthJson).toBe(kind === "auth");
              return {
                epoch: "3",
                async prepareWorkspace(golden) {
                  expect(golden.config.repos).toHaveLength(2);
                  order.push("workspace");
                  return { status: "not_connected" as const };
                },
                async installSkills(references, key) {
                  expect(references).toEqual(pins);
                  expect(key).toBe(skillKey);
                  order.push("skills");
                  return references.map((reference) => ({
                    reference,
                    version: reference.split("@")[1]!,
                    skillId: ORG,
                    checksum: `sha256:${"b".repeat(64)}`,
                    origin: "https://skillpack.app/v1",
                  }));
                },
                async prompt(request) {
                  expect(order).toEqual(["bind", "start", "workspace", "skills", "mcp"]);
                  expect(recorded).toHaveLength(2);
                  calls.push(request);
                  return { promptId: "runtime-prompt", conversationId: "runtime-conversation", status: "queued" };
                },
              };
            },
          },
        },
      );
      expect(world.forks[0]?.env).toEqual({});
      expect(world.forks[0]?.noEnv).toBe(true);
      expect(world.execs).toEqual([]);
      expect(world.preparations).toEqual([]);
      expect(world.prompts).toEqual([]);
      expect(calls).toMatchObject([
        {
          sandboxId: "bx_1",
          harness: kind === "opencode" ? "opencode" : "codex",
          text: expect.stringContaining("runtime answer\n\nSave any deliverable files directly in /home/user/outputs."),
          model: kind === "opencode" ? "opencode/model" : "gpt-5.4",
          reasoningEffort: kind === "opencode" ? "default" : "high",
        },
      ]);
      expect(result).toMatchObject({
        runtime: { kind: "armada", epoch: "3" },
        promptId: "runtime-prompt",
        github: { status: "not_connected" },
        sandbox: { boatRuntime: true },
      });
      expect(world.rows.get(result.sandbox.id)?.taskPromptId).toBe("runtime-prompt");
    },
  );

  test.each(["mcp", "mcp-prepare", "skills", "parent", "selection", "startup", "invalid-epoch", "prompt"] as const)(
    "experimental launch refuses %s without a native fallback",
    async (failure) => {
      const world = setup({ golden: golden("org") });
      world.stores.sandboxes.recordSkills = async () => {};
      world.stores.connections = {
        async validate() {
          if (failure === "mcp") throw new LaunchError("invalid_request", "MCP validation refused");
        },
        async bind() {},
        async prepare() {
          if (failure === "mcp-prepare") throw Error("MCP I/O refused");
        },
      };
      if (failure === "selection") {
        const insert = world.stores.sandboxes.insert.bind(world.stores.sandboxes);
        world.stores.sandboxes.insert = async (input) => {
          const { boatRuntime: ignored, ...legacy } = await insert(input);
          void ignored;
          return legacy;
        };
      }
      let starts = 0;
      await expect(
        launchSandbox(
          world.provider,
          world.stores,
          owner,
          {
            golden: "web",
            harness: "codex",
            prompt: "answer",
            ...(["mcp", "mcp-prepare"].includes(failure) ? { connections: [ORG] } : {}),
            ...(failure === "skills" ? { skills: ["not-a-pin"] } : {}),
          },
          {
            ...(failure === "parent" ? { privateParent: true as const } : {}),
            boatRuntime: {
              async start() {
                starts++;
                if (failure === "startup") throw Error(OPENAI_KEY);
                return {
                  epoch: failure === "invalid-epoch" ? "0" : "1",
                  async prepareWorkspace() {
                    return { status: "not_connected" as const };
                  },
                  async prompt() {
                    throw Error(OPENAI_KEY);
                  },
                };
              },
            },
          },
        ),
      ).rejects.toMatchObject({
        code: ["mcp", "skills", "parent"].includes(failure)
          ? "invalid_request"
          : failure === "prompt"
            ? "prompt_failed"
            : "start_failed",
      });
      expect(world.prompts).toEqual([]);
      expect(world.execs).toEqual([]);
      if (["mcp", "skills", "parent"].includes(failure)) expect(world.forks).toEqual([]);
      else {
        expect(world.stopped).toEqual(["bx_1"]);
        expect([...world.rows.values()][0]?.status).toBe("failed");
        expect([...world.rows.values()][0]?.statusReason).not.toContain(OPENAI_KEY);
      }
      expect(starts).toBe(["startup", "invalid-epoch", "prompt", "mcp-prepare"].includes(failure) ? 1 : 0);
    },
  );

  test.each(["codex", "claude", "opencode"] as const)(
    "%s selects private Boat runtime for custom endpoints or runtime-only harness",
    async (harness) => {
      const world = setup({ golden: golden("org") });
      const env =
        harness === "opencode"
          ? {}
          : {
              [harness === "codex" ? "ARMADA_CODEX_ENDPOINT" : "ARMADA_CLAUDE_ENDPOINT"]: JSON.stringify({
                version: 1,
                baseUrl: "https://gateway.example.test",
              }),
            };
      const credentials = {
        env,
        secrets: [],
        codexAuthJson: false,
        binding: { credentialId: OWNER, credentialVersion: 1 },
      };
      world.stores.credentials.resolve = async () => credentials;
      let delivered: unknown;
      const result = await launchSandbox(
        world.provider,
        world.stores,
        owner,
        {
          golden: "web",
          harness,
          prompt: "hello",
          ...(harness === "opencode" ? { model: "opencode/model" } : {}),
        },
        {
          boatEndpointRuntime: {
            provider: async () => world.provider,
            credentials: world.stores.credentials,
            connections: { async validate() {}, async bind() {} },
            policy: {
              async start(input) {
                delivered = input.credentials.env;
                return {
                  epoch: "1",
                  async prepareWorkspace() {
                    return { status: "not_connected" as const };
                  },
                  async prompt() {
                    return { promptId: "runtime", conversationId: "runtime", status: "queued" as const };
                  },
                };
              },
            },
          },
        },
      );
      expect(delivered).toEqual(env);
      expect(world.forks[0]?.env).toEqual({});
      expect(world.prompts).toEqual([]);
      expect(result.sandbox.boatRuntime).toBe(true);
      expect(result.runtime).toEqual({ kind: "armada", epoch: "1" });
    },
  );
  test("OpenCode without Boat runtime refuses before allocation with an actionable reason", async () => {
    const world = setup({ golden: golden("org") });
    await expect(
      launchSandbox(world.provider, world.stores, owner, {
        golden: "web",
        harness: "opencode",
        prompt: "hello",
      }),
    ).rejects.toThrow("OpenCode on Boat requires the Boat runtime artifacts");
    expect(world.forks).toEqual([]);
  });
  test.each(["codex", "claude"] as const)("custom %s endpoints refuse Boat before allocation", async (harness) => {
    const world = setup({ golden: golden("org") });
    world.stores.credentials.resolve = async () => ({
      env: { [harness === "codex" ? "ARMADA_CODEX_ENDPOINT" : "ARMADA_CLAUDE_ENDPOINT"]: "{}" },
      secrets: [],
      codexAuthJson: false,
    });
    let forks = 0;
    world.provider.fork = async () => {
      forks++;
      throw Error("must not allocate");
    };
    await expect(
      launchSandbox(world.provider, world.stores, owner, {
        golden: "web",
        harness,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(forks).toBe(0);
  });
  test("OpenCode admits only a configured Modal model before allocating compute", async () => {
    const g = {
      ...golden("org"),
      provider: "modal" as const,
      boatSnapshotId: null,
      modal: { workspace: "ws", environment: "main", appId: "ap" },
    };
    const world = setup({ golden: g });
    const provider = {
      ...world.provider,
      id: "modal" as const,
      harnesses: ["opencode" as const],
      capabilities: { opencode: { reasoningEffort: true } },
    } as unknown as Provider;
    world.stores.credentials.resolve = async () => ({
      env: {
        OPENCODE_API_KEY: "fake-opencode-key",
        ARMADA_OPENCODE_ENDPOINT: JSON.stringify({
          version: 1,
          baseUrl: "https://api.deepseek.com/v1",
          models: ["deepseek-flash"],
        }),
      },
      secrets: ["fake-opencode-key"],
      codexAuthJson: false,
    });
    await expect(
      launchSandbox(provider, world.stores, owner, { golden: "web", harness: "opencode", model: "armada/other" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(world.forks).toHaveLength(0);
    const launched = await launchSandbox(provider, world.stores, owner, {
      golden: "web",
      harness: "opencode",
      model: "deepseek-flash",
      prompt: "hello",
    });
    expect(launched.sandbox.harness).toBe("opencode");
    expect(world.forks).toHaveLength(1);
    expect(world.prompts).toContainEqual(
      expect.objectContaining({
        harness: "opencode",
        model: "armada/deepseek-flash",
        reasoningEffort: "default",
        text: expect.stringContaining("hello\n\nSave any deliverable files directly in /home/user/outputs."),
      }),
    );
    expect(JSON.stringify(launched.sandbox)).not.toContain("fake-opencode-key");
  });
  test("size precedence is override, selected repository, golden, then unchanged legacy fork", async () => {
    for (const [size, repo, policy, effective, source] of [
      ["small", "web", { version: 1, golden: "large", repositories: { web: "xlarge" } }, "small", "override"],
      [
        undefined,
        "example/web",
        { version: 1, golden: "large", repositories: { web: "xlarge" } },
        "xlarge",
        "repository",
      ],
      [undefined, undefined, { version: 1, golden: "large", repositories: { web: "xlarge" } }, "large", "golden"],
      [undefined, undefined, null, null, "legacy"],
    ] as const) {
      const manifest = golden("org");
      manifest.sizePolicy = policy;
      const world = setup({ golden: manifest, prepare: true });
      const insert = world.stores.sandboxes.insert;
      let evidence: unknown;
      world.stores.sandboxes.insert = async (input) => {
        evidence = input.machineSize;
        return { ...(await insert(input)), machineSize: input.machineSize ?? null };
      };
      await launchSandbox(world.provider, world.stores, owner, {
        golden: "web",
        harness: "claude",
        ...(size ? { size } : {}),
        ...(repo ? { repo } : {}),
      });
      expect(world.forks[0]?.size).toBe(effective ?? undefined);
      expect(evidence).toMatchObject({ version: 1, requested: size ?? null, effective, source });
    }
    const world = setup({ golden: golden("org") });
    await expect(
      launchSandbox(world.provider, world.stores, owner, {
        golden: "web",
        harness: "claude",
        size: "invalid" as never,
      }),
    ).rejects.toThrow("Size must");
    expect(world.forks).toHaveLength(0);
  });

  test("MCP prepare runs after binding and init, before first prompt, including idle launches", async () => {
    for (const prompt of [undefined, "start"]) {
      const world = setup({ golden: golden("org") });
      let bound = false,
        prepared = false;
      world.stores.connections = {
        validate: async () => {},
        bind: async () => {
          bound = true;
        },
        prepare: async (_provider, sandbox, actor) => {
          expect(bound).toBe(true);
          expect(world.execs.at(-1)?.command).toBe("pnpm i");
          expect(world.prompts).toHaveLength(0);
          expect(sandbox.ownerId).toBe(actor.userId);
          prepared = true;
        },
      };
      await launchSandbox(world.provider, world.stores, owner, {
        golden: "web",
        harness: "claude",
        ...(prompt ? { prompt } : {}),
      });
      expect(prepared).toBe(true);
      expect(world.prompts).toHaveLength(prompt ? 1 : 0);
    }
  });

  test("deprecated sandbox visibility does not change source authority or prevent launch", async () => {
    const world = setup({ golden: golden("org") });
    const result = await launchSandbox(world.provider, world.stores, owner, {
      golden: "web",
      harness: "claude",
      visibility: "private",
      prompt: "work",
    });
    expect(result.sandbox.visibility).toBe("org");
    expect(world.prompts).toHaveLength(1);
  });

  test("forks the stored snapshot with only this harness's credentials, pulls and inits, then prompts", async () => {
    const world = setup({ golden: golden("org") });
    const result = await launchSandbox(
      world.provider,
      world.stores,
      owner,
      { golden: "web", harness: "claude", prompt: "Fix the build", ttlSeconds: 7200 },
      { newId: () => "sbx-1" },
    );

    expect(world.forks).toHaveLength(1);
    expect(world.forks[0]).toEqual({
      from: SNAPSHOT,
      noEnv: true,
      env: { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN },
      ttlSeconds: 7500,
      labels: {
        armada: "sandbox",
        sandbox: "sbx-1",
        org: ORG,
        owner: OWNER,
        golden: "web",
        visibility: "org",
        harness: "claude",
      },
    });
    expect(world.execs.map((exec) => exec.cwd)).toEqual([
      `${GOLDEN_ROOT}/web`,
      `${GOLDEN_ROOT}/api`,
      GOLDEN_ROOT,
      GOLDEN_ROOT,
    ]);
    expect(world.execs[0]?.command).toContain("git fetch origin 'main'");
    expect(world.execs[1]?.command).toContain("'dev'");
    expect(world.execs[2]?.command).toBe("pnpm i");
    expect(world.prompts).toEqual([
      {
        signal: expect.any(AbortSignal),
        sandboxId: "bx_1",
        harness: "claude",
        text: expect.stringContaining("Fix the build\n\nSave any deliverable files directly in /home/user/outputs."),
        model: "claude-opus-5-5",
        reasoningEffort: "medium",
      },
    ]);
    expect(result).toMatchObject({ conversationId: "conv_1", promptId: "prompt_1", ttlSeconds: 7200 });
    expect(world.rows.get("sbx-1")).toMatchObject({
      provider: "boat",
      providerSandboxId: "bx_1",
      ownerId: OWNER,
      harness: "claude",
      status: "running",
      conversationIds: ["conv_1"],
    });
    expect(JSON.stringify(world.execs)).not.toContain(CLAUDE_TOKEN);
  });

  test("saved model defaults reach ordinary launches while explicit models win", async () => {
    for (const explicit of [false, true]) {
      const world = setup({ golden: golden("org") });
      world.stores.credentials.defaults = async () => ({ credentialId: null, model: "claude-sonnet-5-5" });
      const result = await launchSandbox(world.provider, world.stores, owner, {
        golden: "web",
        harness: "claude",
        ...(explicit ? { model: "claude-opus-5-5" } : {}),
      });
      expect(world.rows.get(result.sandbox.id)?.model).toBe(explicit ? "claude-opus-5-5" : "claude-sonnet-5-5");
    }
  });

  test.each(["ready", "prompted", "failed"] as const)(
    "cleanup failures preserve the %s launch outcome and still release the fence",
    async (outcome) => {
      const world = setup({
        golden: golden("org"),
        ...(outcome === "failed" ? { promptError: new Error("original prompt refusal") } : {}),
      });
      let releases = 0;
      let fences = 0;
      world.stores.credentials.releaseAdmission = async () => {
        releases++;
        throw new Error("private cleanup details");
      };
      world.stores.goldens.beginOperation = async () => async () => {
        fences++;
        throw new Error("private fence details");
      };
      const warn = spyOn(console, "warn").mockImplementation(() => {
        throw new Error("diagnostic sink unavailable");
      });
      try {
        const launch = launchSandbox(world.provider, world.stores, owner, {
          golden: "web",
          harness: "claude",
          ...(outcome !== "ready" ? { prompt: "go" } : {}),
        });
        if (outcome === "failed")
          await expect(launch).rejects.toMatchObject({
            code: "prompt_failed",
            message: expect.stringContaining("original prompt refusal"),
          });
        else expect((await launch).sandbox.status).toBe(outcome === "ready" ? "ready" : "running");
        expect(releases).toBe(2);
        expect(fences).toBe(1);
        expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
      } finally {
        warn.mockRestore();
      }
    },
  );

  test("a transient admission release failure is reconciled without failing the launch", async () => {
    const world = setup({ golden: golden("org") });
    let reserved = true;
    let attempts = 0;
    world.stores.credentials.releaseAdmission = async () => {
      if (++attempts === 1) throw new Error("temporary database failure");
      reserved = false;
    };
    await launchSandbox(world.provider, world.stores, owner, { golden: "web", harness: "claude" });
    expect(reserved).toBe(false);
  });

  test("without a prompt the sandbox is ready, has no conversation and no prompt was sent", async () => {
    const world = setup({ golden: golden("org") });
    const result = await launchSandbox(world.provider, world.stores, owner, { golden: "web", harness: "claude" });
    expect(world.prompts).toEqual([]);
    expect(result.sandbox).toMatchObject({ status: "ready", conversationIds: [] });
    expect(world.rows.get(result.sandbox.id)).toMatchObject({ model: "claude-opus-5-5", reasoningEffort: "medium" });
    expect(result.conversationId).toBeUndefined();
    expect(result.ttlSeconds).toBe(14_400);
    expect(world.forks[0]?.ttlSeconds).toBe(14_700);
    expect([...world.rows.values()][0]).toMatchObject({ status: "ready", conversationIds: [] });
  });

  test("explicit selectors are validated after authorization and before allocation", async () => {
    const manifest = golden("org");
    for (const [repo, record, prepare, message] of [
      ["example/missing", manifest, true, "no repository"],
      [
        "example/web",
        {
          ...manifest,
          config: {
            ...manifest.config,
            repos: [
              ...manifest.config.repos,
              { url: "https://github.com/example/web.git", branch: "main", dir: "copy" },
            ],
          },
        },
        true,
        "ambiguous",
      ],
      ["invalid", manifest, true, "owner/repo"],
      ["example/web", manifest, false, "cannot prepare"],
    ] satisfies [string, GoldenRecord, boolean, string][]) {
      const world = setup({ golden: record, prepare });
      await expect(
        launchSandbox(world.provider, world.stores, owner, {
          golden: "web",
          harness: "claude",
          repo,
        }),
      ).rejects.toThrow(message);
      expect(world.forks).toEqual([]);
      expect(world.rows.size).toBe(0);
      expect(world.order).toEqual([]);
    }
    const hidden = setup({ golden: golden("private"), leaky: true, actor: other, prepare: true });
    await expect(
      launchSandbox(hidden.provider, hidden.stores, other, {
        golden: "web",
        harness: "claude",
        repo: "example/missing",
      }),
    ).rejects.toThrow("No golden named 'web'");
    expect(hidden.order).toEqual([]);
  });

  for (const harness of ["codex", "claude"] as const) {
    test(`explicit repo prepares ${harness} after setup and before its first prompt`, async () => {
      const world = setup({
        golden: golden("org"),
        prepare: true,
        ...(harness === "codex" ? { credentials: authCredentials() } : {}),
        github: { status: "connected", token: GITHUB_TOKEN, identity: IDENTITY },
      });
      await launchSandbox(world.provider, world.stores, owner, {
        golden: "web",
        harness,
        repo: "example/api",
        prompt: "Go",
        ttlSeconds: 7200,
      });
      expect(world.preparations).toEqual([{ sandboxId: "bx_1", harness, cwd: `${GOLDEN_ROOT}/api` }]);
      expect(world.order).toEqual([
        "credentials",
        "fork",
        "ready",
        ...(harness === "codex" ? ["exec"] : []),
        "exec",
        "exec",
        "exec",
        "exec",
        "prepare",
        "exec",
        "prompt",
      ]);
      expect(world.forks[0]?.ttlSeconds).toBe(7500);
      expect([...world.rows.values()][0]?.status).toBe("running");
    });
  }

  // A VM can report ready while its restored CLI is broken; no model turn is needed.
  test.each(["codex", "claude"] as const)(
    "unstartable %s fails idle and prompted launch before publication",
    async (harness) => {
      const dir = mkdtempSync(join(tmpdir(), "armada-broken-harness-"));
      try {
        writeFileSync(
          join(dir, harness),
          `#!/bin/sh
echo 'Node startup failed: ${OPENAI_KEY}' >&2
exit 1
`,
          { mode: 0o755 },
        );
        for (const prompt of [undefined, "Go"]) {
          const world = setup({
            golden: golden("org"),
            exec: (command) => {
              if (!command.startsWith(`${harness} --version`)) return { exitCode: 0 };
              const result = spawnSync("/bin/sh", ["-c", command], { env: { PATH: dir }, timeout: 1000 });
              return { exitCode: result.status ?? 1, stderr: result.stderr.toString() };
            },
          });
          const failure = (await launchSandbox(world.provider, world.stores, owner, {
            golden: "web",
            harness,
            ...(prompt ? { prompt } : {}),
          }).catch((error: unknown) => error)) as LaunchError;
          expect(failure).toBeInstanceOf(LaunchError);
          expect(failure.code).toBe("start_failed");
          expect(failure.safeReason).toBeUndefined();
          expect(failure.message).toBe("The agent runtime could not start in this sandbox. Relaunch in a new sandbox.");
          expect(world.rows.get(failure.sandboxId!)).toMatchObject({ status: "failed", statusReason: failure.message });
          expect(world.stopped).toEqual(["bx_1"]);
          expect(world.prompts).toEqual([]);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("idle explicit repo persists the selected repository and prepares cwd before launch returns", async () => {
    const world = setup({ golden: golden("org"), prepare: true });
    const result = await launchSandbox(world.provider, world.stores, owner, {
      golden: "web",
      harness: "claude",
      repo: "example/web",
    });
    expect(result.sandbox).toMatchObject({ status: "ready", repositoryDir: "web" });
    expect(world.rows.get(result.sandbox.id)).toMatchObject({
      repositoryDir: "web",
      resourceProject: { version: 1, dir: "web" },
    });
    expect(world.prompts).toEqual([]);
    expect(world.order).toEqual(["credentials", "fork", "ready", "exec", "exec", "exec", "prepare", "exec"]);
    expect(world.preparations).toEqual([{ sandboxId: "bx_1", harness: "claude", cwd: `${GOLDEN_ROOT}/web` }]);
  });

  test("preparation failure stops and records the sandbox, redacts errors, and never prompts", async () => {
    const world = setup({
      golden: golden("org"),
      prepare: true,
      preparationError: new Error(`failed ${CLAUDE_TOKEN}`),
    });
    const failure = (await launchSandbox(world.provider, world.stores, owner, {
      golden: "web",
      harness: "claude",
      repo: "example/web",
      prompt: "Go",
    }).catch((error: unknown) => error)) as LaunchError;
    expect(failure).toBeInstanceOf(LaunchError);
    expect(failure.code).toBe("start_failed");
    expect(failure.message).not.toContain(CLAUDE_TOKEN);
    expect(world.rows.get(failure.sandboxId ?? "")).toMatchObject({ status: "failed", statusReason: failure.message });
    expect(world.stopped).toEqual(["bx_1"]);
    expect(world.prompts).toEqual([]);
    expect(world.order.at(-1)).toBe("prepare");
  });

  test("without a selector even a provider with a hook keeps the legacy multi-repo launch", async () => {
    const world = setup({ golden: golden("org"), prepare: true });
    await launchSandbox(world.provider, world.stores, owner, { golden: "web", harness: "claude", prompt: "Go" });
    expect(world.preparations).toEqual([]);
    expect(world.order).toEqual(["credentials", "fork", "ready", "exec", "exec", "exec", "exec", "prompt"]);
  });

  test("Codex gets OPENAI_API_KEY, or writes auth.json from the environment and never from the command line", async () => {
    const key = setup({
      golden: golden("org"),
    });
    await launchSandbox(key.provider, key.stores, owner, { golden: "web", harness: "codex", prompt: "go" });
    expect(key.forks[0]).toMatchObject({ noEnv: true, env: { OPENAI_API_KEY: OPENAI_KEY } });
    expect(key.prompts[0]?.harness).toBe("codex");

    const login = setup({ golden: golden("org"), credentials: authCredentials() });
    await launchSandbox(login.provider, login.stores, owner, { golden: "web", harness: "codex" });
    expect(login.forks[0]?.env).toEqual({ ARMADA_CODEX_AUTH_JSON: AUTH_JSON });
    expect(login.execs[0]?.command).toContain('"$ARMADA_CODEX_AUTH_JSON" > /home/user/.codex/auth.json');
    expect(JSON.stringify(login.execs)).not.toContain("codex-access-token-value");
  });

  test("a failed init is recorded as failed with its output, the machine is stopped and no secret is shown", async () => {
    const world = setup({
      golden: golden("org"),
      exec: (command) =>
        command === "pnpm i"
          ? { exitCode: 1, stderr: `ERR_PNPM token ${CLAUDE_TOKEN} rejected\nmissing lockfile`, stdout: "" }
          : { exitCode: 0 },
    });
    const error = await launchSandbox(
      world.provider,
      world.stores,
      owner,
      { golden: "web", harness: "claude", prompt: "go" },
      { newId: () => "sbx-2" },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LaunchError);
    const failure = error as LaunchError;
    expect(failure.code).toBe("init_failed");
    expect(failure.sandboxId).toBe("sbx-2");
    expect(failure.message).toContain("init command 1 failed (exit 1)");
    expect(failure.message).toContain("missing lockfile");
    expect(failure.message).not.toContain(CLAUDE_TOKEN);
    expect(world.rows.get("sbx-2")).toMatchObject({ status: "failed", statusReason: failure.message });
    expect(world.stopped).toEqual(["bx_1"]);
    expect(world.prompts).toEqual([]);
  });

  test("a failed git pull stops the launch before init", async () => {
    const world = setup({
      golden: golden("org"),
      exec: (command) =>
        command.includes("git fetch")
          ? { exitCode: 128, stderr: "fatal: not possible to fast-forward" }
          : { exitCode: 0 },
    });
    await expect(
      launchSandbox(world.provider, world.stores, owner, { golden: "web", harness: "claude" }),
    ).rejects.toThrow(/git pull of web failed \(exit 128\)\.\nfatal: not possible to fast-forward/);
    expect(world.execs.some((exec) => exec.command === "pnpm i")).toBe(false);
    expect(world.execs.filter((exec) => exec.command.includes("git fetch"))).toHaveLength(1);
  });

  test.each([
    { repo: undefined, transient: true },
    { repo: "example/web", transient: true },
    { repo: undefined, transient: false },
    { repo: "example/web", transient: false },
  ])("ownership rejection retries once, then succeeds or cleans up (%j)", async ({ repo, transient }) => {
    const diagnostics: string[] = [];
    const waits: number[] = [];
    const log = spyOn(console, "error").mockImplementation((line: string) => {
      diagnostics.push(line);
    });
    let rejectedPulls = 0;
    const world = setup({
      golden: golden("org"),
      prepare: true,
      exec: (command) =>
        command.includes("git fetch") && (!transient || rejectedPulls++ === 0)
          ? {
              exitCode: 75,
              stderr:
                "ARMADA_REPOSITORY_FETCH_FAILED\nfatal: detected dubious ownership in repository at '/home/user/web'\n" +
                "x".repeat(2500),
            }
          : { exitCode: 0 },
    });
    let failure: unknown;
    try {
      failure = await launchSandbox(
        world.provider,
        world.stores,
        owner,
        {
          golden: "web",
          harness: "claude",
          ...(repo === undefined ? {} : { repo }),
          prompt: "go",
        },
        {
          sleep: async (ms) => {
            expect(world.execs.filter((exec) => exec.command.includes("git fetch"))).toHaveLength(1);
            waits.push(ms);
          },
        },
      ).catch((error: unknown) => error as LaunchError);
    } finally {
      log.mockRestore();
    }
    expect(waits).toEqual([1000]);
    expect(
      diagnostics
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.event === "launch_repository_ownership_retry"),
    ).toEqual([
      {
        event: "launch_repository_ownership_retry",
        sandboxId: [...world.rows.keys()][0],
        provider: "boat",
        providerSandboxId: "bx_1",
        attempt: 2,
        delayMs: 1000,
        outcome: transient ? "recovered" : "failed",
        retry: transient ? "succeeded" : "ownership_refused",
      },
    ]);
    expect(
      world.execs.filter((exec) => exec.cwd === "/home/user/web" && exec.command.includes("git fetch")),
    ).toHaveLength(2);
    if (transient) {
      expect(failure).not.toBeInstanceOf(LaunchError);
      expect([...world.rows.values()][0]?.status).toBe("running");
      expect(world.execs.filter((exec) => exec.command === "pnpm i")).toHaveLength(1);
      expect(world.prompts).toHaveLength(1);
      expect(world.stopped).toEqual([]);
      return;
    }
    expect(failure).toBeInstanceOf(LaunchError);
    const error = failure as LaunchError;
    expect(error.code).toBe("init_failed");
    expect(error.safeReason).toBe("repository_ownership_mismatch");
    expect(error.cause).toBeInstanceOf(LaunchError);
    expect((error.cause as Error).message).toContain("git pull of web failed (exit 75)");
    expect(error.sandboxId).toBeString();
    expect(error.message).toContain(`sandbox ${error.sandboxId}:`);
    expect(error.message).not.toContain("bx_1");
    expect(error.message).not.toContain("selected machine size");
    expect(error.message).toContain("checkout ownership");
    expect(error.message).toContain("Report this golden and sandbox ID");
    expect(error.message).not.toContain("rebuild");
    expect(error.message).not.toContain("fatal:");
    expect(error.message).not.toContain("safe.directory");
    expect(world.rows.get(error.sandboxId ?? "")).toMatchObject({ status: "failed", statusReason: error.message });
    expect(world.stopped).toEqual(["bx_1"]);
    expect(world.execs.some((exec) => exec.command === "pnpm i")).toBe(false);
    expect(world.prompts).toEqual([]);
  });

  test("a refused first prompt leaves a failed sandbox and says so", async () => {
    const world = setup({
      golden: golden("org"),
      promptError: new ProviderError({
        provider: "boat",
        code: "provider_not_configured",
        message: "No Claude login on the account",
        retryable: false,
      }),
    });
    await expect(
      launchSandbox(world.provider, world.stores, owner, { golden: "web", harness: "claude", prompt: "go" }),
    ).rejects.toMatchObject({
      code: "prompt_failed",
      message: expect.stringContaining("No Claude login on the account"),
    });
    expect([...world.rows.values()][0]?.status).toBe("failed");
    expect(world.stopped).toEqual(["bx_1"]);
  });

  test("a private golden of someone else is refused as missing, and nothing starts", async () => {
    const world = setup({ golden: golden("private"), actor: other });
    await expect(
      launchSandbox(world.provider, world.stores, other, { golden: "web", harness: "claude" }),
    ).rejects.toThrow(/No golden named 'web'/);
    expect(world.forks).toEqual([]);
    expect(world.rows.size).toBe(0);
  });

  test("a store that leaks a private golden is still refused", async () => {
    const world = setup({ golden: golden("private"), leaky: true, actor: other });
    await expect(
      launchSandbox(world.provider, world.stores, other, { golden: "web", harness: "claude" }),
    ).rejects.toThrow(/No golden named 'web'/);
    expect(world.forks).toEqual([]);
  });

  test("a connected GitHub puts the user's token in the environment and sets git up before any repo is pulled", async () => {
    const world = setup({
      golden: golden("org"),
      github: { status: "connected", token: GITHUB_TOKEN, identity: IDENTITY },
      exec: (command) =>
        command.includes("git config") ? { exitCode: 0, stdout: "armada-gh:present\n" } : { exitCode: 0 },
    });

    const result = await launchSandbox(world.provider, world.stores, owner, { golden: "web", harness: "claude" });

    expect(world.forks[0]).toMatchObject({
      noEnv: true,
      env: { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN, GH_TOKEN: GITHUB_TOKEN, GITHUB_TOKEN: GITHUB_TOKEN },
    });
    expect(world.execs.map((exec) => exec.cwd)).toEqual([
      GOLDEN_ROOT,
      `${GOLDEN_ROOT}/web`,
      `${GOLDEN_ROOT}/api`,
      GOLDEN_ROOT,
      GOLDEN_ROOT,
    ]);
    expect(world.execs[0]?.command).toContain(
      "git config --global user.email '583231+octocat@users.noreply.github.com'",
    );
    expect(world.execs[0]?.command).toContain("user.name 'The Octocat'");
    expect(JSON.stringify(world.execs)).not.toContain(GITHUB_TOKEN);
    expect(world.execs.find((exec) => exec.command.includes("git fetch"))?.command).not.toContain("credential.helper=");
    expect(result.github).toEqual({ status: "connected", login: "octocat" });
    expect(result.sandbox.status).toBe("ready");
  });

  test("a golden without gh still launches, and says so", async () => {
    const world = setup({
      golden: golden("org"),
      github: { status: "connected", token: GITHUB_TOKEN, identity: IDENTITY },
    });
    const result = await launchSandbox(world.provider, world.stores, owner, { golden: "web", harness: "claude" });
    expect(result.github).toEqual({ status: "connected", login: "octocat", message: GH_MISSING_NOTE });
  });

  test("a launch without a GitHub connection still succeeds, injects nothing and explains", async () => {
    for (const github of [
      undefined,
      { status: "not_connected", message: "Connect GitHub." } as const,
      { status: "revoked", message: "Reconnect GitHub." } as const,
      { status: "unavailable", message: "GitHub is down." } as const,
    ]) {
      const world = setup({ golden: golden("org"), ...(github ? { github } : {}) });
      const result = await launchSandbox(world.provider, world.stores, owner, { golden: "web", harness: "claude" });
      expect(world.forks[0]?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN });
      expect(world.execs.some((exec) => exec.command.includes("git config"))).toBe(false);
      expect(result.github.status).toBe(github?.status ?? "not_connected");
      expect(result.github.login).toBeUndefined();
      if (github) expect(result.github.message).toBe(github.message);
      else expect(result.github.message).toContain("not connected");
    }
  });

  test("a failed git setup fails the launch, stops the machine and never prints the GitHub token", async () => {
    const world = setup({
      golden: golden("org"),
      github: { status: "connected", token: GITHUB_TOKEN, identity: IDENTITY },
      exec: (command) =>
        command.includes("git config")
          ? { exitCode: 1, stderr: `fatal: could not write config with ${GITHUB_TOKEN}` }
          : { exitCode: 0 },
    });

    const stages: string[] = [];
    const error = await launchSandbox(
      world.provider,
      world.stores,
      owner,
      { golden: "web", harness: "claude" },
      {
        newId: () => "sbx-1",
        onInitialization: (stage) => {
          stages.push(stage);
        },
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LaunchError);
    expect((error as LaunchError).safeReason).toBe("github_setup_nonzero");
    expect(stages.at(-1)).toBe("initialization_github");
    expect((error as LaunchError).message).toContain("GitHub could not be set up");
    expect((error as LaunchError).message).not.toContain(GITHUB_TOKEN);
    expect(world.rows.get("sbx-1")?.status).toBe("failed");
    expect(JSON.stringify(world.rows.get("sbx-1"))).not.toContain(GITHUB_TOKEN);
    expect(world.stopped).toEqual(["bx_1"]);
  });

  test("a golden without a snapshot, a harness without credentials and bad input start nothing", async () => {
    const noSnapshot = setup({ golden: { ...golden("org"), providerSnapshotId: null } });
    await expect(
      launchSandbox(noSnapshot.provider, noSnapshot.stores, owner, { golden: "web", harness: "claude" }),
    ).rejects.toThrow(/no snapshot yet/);

    const refused = new Error("Fixture credential resolution refused.");
    const none = setup({ golden: golden("org"), credentialError: refused });
    await expect(launchSandbox(none.provider, none.stores, owner, { golden: "web", harness: "codex" })).rejects.toBe(
      refused,
    );

    const world = setup({ golden: golden("org") });
    for (const request of [
      { harness: "opencode", ttlSeconds: undefined },
      { harness: "claude", ttlSeconds: 0 },
      { harness: "claude", ttlSeconds: 2_592_001 },
      { harness: "claude", ttlSeconds: 1.5 },
      { harness: "claude", prompt: "   " },
      { harness: "claude", reasoningEffort: "ultra" },
      { harness: "claude", model: "claude-fable-5-2", reasoningEffort: "ultra" },
      { harness: "claude", model: "unknown model!" },
      { harness: "codex", model: "gpt-6-luna", reasoningEffort: "ultra" },
      { harness: "codex", model: "gpt 6; rm -rf /" },
    ]) {
      await expect(
        launchSandbox(world.provider, world.stores, owner, { golden: "web", ...request } as never),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect([noSnapshot, none, world].flatMap((entry) => entry.forks)).toEqual([]);
  });

  test.each([
    { harness: "codex", model: "gpt-7-preview", reasoningEffort: "ultra" },
    { harness: "claude", model: "claude-fable-5-2", reasoningEffort: "high" },
  ] as const)("an explicit model and effort reach the prompt and record unchanged: %j", async (choice) => {
    const world = setup({ golden: golden("org") });
    const result = await launchSandbox(world.provider, world.stores, owner, {
      golden: "web",
      prompt: "Go",
      ...choice,
    });
    expect(world.prompts[0]).toMatchObject(choice);
    expect(world.rows.get(result.sandbox.id)).toMatchObject(choice);
  });

  test("a provider that cannot set a reasoning effort is refused before the fork", async () => {
    const world = setup({ golden: golden("org") });
    const provider = { ...world.provider, capabilities: { claude: { reasoningEffort: false } } } as never;
    await expect(
      launchSandbox(provider, world.stores, owner, { golden: "web", harness: "claude" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(world.forks).toEqual([]);
  });

  test("a sandbox that cannot be recorded is deleted again", async () => {
    const world = setup({ golden: golden("org"), insertError: new Error("row-level security") });
    await expect(
      launchSandbox(world.provider, world.stores, owner, { golden: "web", harness: "claude" }),
    ).rejects.toThrow(/row-level security/);
    expect(world.deleted).toEqual(["bx_1"]);
  });
});

describe("prompt outcome", () => {
  test("finished with a usage limit or an expired login is a failure, even though boat says finished", async () => {
    const limit = other_event("usage_limit", { message: "Weekly limit reached" });
    const expired = other_event("auth_expiry", {});
    const fine = events([prompt("finished")]);
    const ok = await promptOutcome(outcomeProvider("finished", fine), { sandboxId: "bx_1", promptId: "p1" });
    expect(ok).toEqual({ state: "finished" });

    const limited = await promptOutcome(outcomeProvider("finished", events([prompt("finished"), limit])), {
      sandboxId: "bx_1",
      promptId: "p1",
    });
    expect(limited).toEqual({ state: "failed", reason: "Weekly limit reached" });

    const login = await promptOutcome(outcomeProvider("finished", events([expired])), {
      sandboxId: "bx_1",
      promptId: "p1",
    });
    expect(login).toEqual({ state: "failed", reason: "The agent's login expired." });

    const otherTurn = await promptOutcome(
      outcomeProvider("finished", events([{ ...limit, promptId: "p2" } as AgentEvent])),
      { sandboxId: "bx_1", promptId: "p1" },
    );
    expect(otherTurn).toEqual({ state: "finished" });
  });

  test("the status comes from getPrompt, so a running turn is running whatever its events say", async () => {
    const provider = outcomeProvider("running", events([prompt("finished")]));
    expect(await promptOutcome(provider, { sandboxId: "bx_1", promptId: "p1" })).toEqual({ state: "running" });
    expect(
      await promptOutcome(outcomeProvider("failed", events([prompt("failed", "out of credit")])), {
        sandboxId: "bx_1",
        promptId: "p1",
      }),
    ).toEqual({ state: "failed", reason: "Agent failed. Check the agent configuration before retrying." });
    expect(
      await promptOutcome(outcomeProvider("failed", events([prompt("failed", "output_limit_exceeded")])), {
        sandboxId: "bx_1",
        promptId: "p1",
      }),
    ).toEqual({
      state: "failed",
      reason:
        "Model output limit reached. The model stopped before it finished this response. Send a message to continue.",
    });
    expect(
      await promptOutcome(outcomeProvider("interrupted", events([])), { sandboxId: "bx_1", promptId: "p1" }),
    ).toEqual({
      state: "interrupted",
    });
  });

  test("structured plan evidence never overrides auth/interruption or exposes malformed reset/vendor text", async () => {
    const limit = other_event("usage_limit", {
      code: "usage_limit_exceeded",
      resetsAt: "private-reset-body",
      message: "private-vendor-body",
    });
    for (const status of ["failed", "finished"] as const) {
      expect(
        await promptOutcome(outcomeProvider(status, events([prompt(status), limit])), {
          sandboxId: "s",
          promptId: "p1",
        }),
      ).toEqual({
        state: "failed",
        reason:
          "Plan limit reached. Try again after the limit resets. Wait for the limit to reset, or switch to another account before sending the prompt again.",
        limit: { code: "usage_limit_exceeded" },
      });
    }
    expect(
      await promptOutcome(outcomeProvider("failed", events([prompt("failed", "authentication_failed"), limit])), {
        sandboxId: "s",
        promptId: "p1",
      }),
    ).toEqual({
      state: "failed",
      reason: "Authentication failed. Reconnect the agent account, then send the prompt again.",
    });
    expect(
      await promptOutcome(outcomeProvider("interrupted", events([prompt("interrupted"), limit])), {
        sandboxId: "s",
        promptId: "p1",
      }),
    ).toEqual({ state: "interrupted" });
  });

  test("an event read twice keeps its newest body and its first position", () => {
    const first = message("m1", "Hel", true);
    const second = message("m2", "Done", false);
    const again = message("m1", "Hello", false);
    expect(dedupeEvents([first, second, again])).toEqual([again, second]);
  });
});

function golden(visibility: "org" | "private"): GoldenRecord {
  return {
    id: "golden-1",
    orgId: ORG,
    name: "web",
    visibility,
    ownerId: OWNER,
    provider: "boat",
    providerSnapshotId: SNAPSHOT,
    providerSandboxId: "bx_builder",
    modal: null,
    config: parseGoldenConfig({
      repos: [
        { url: "https://github.com/example/web.git", branch: "main" },
        { url: "https://github.com/example/api.git", branch: "dev" },
      ],
      init: ["pnpm i"],
    }),
    createdAt: "2026-11-08T12:00:00.000Z",
  };
}

interface Setup {
  golden: GoldenRecord;
  credentials?: HarnessCredentials;
  credentialError?: Error;
  exec?: (command: string) => { exitCode: number; stderr?: string; stdout?: string };
  promptError?: Error;
  insertError?: Error;
  leaky?: boolean;
  actor?: GoldenActor;
  github?: GitHubAccess;
  prepare?: boolean;
  preparationError?: Error;
}

function setup(options: Setup) {
  const order: string[] = [];
  const preparations: { sandboxId: string; harness: string; cwd: string }[] = [];
  const forks: ForkRequest[] = [];
  const execs: { command: string; cwd?: string }[] = [];
  const prompts: {
    signal?: AbortSignal;
    sandboxId: string;
    harness: string;
    text: string;
    model?: string;
    reasoningEffort?: string;
  }[] = [];
  const stopped: string[] = [];
  const deleted: string[] = [];
  const rows = new Map<string, SandboxRecord>();
  const info = (state: SandboxInfo["state"]): SandboxInfo => ({
    id: "bx_1",
    name: "web",
    state,
    providerState: state,
    labels: {},
    expiresAt: new Date(Date.now() + 86400000),
  });
  const provider = {
    id: "boat",
    harnesses: ["claude", "codex"],
    capabilities: { claude: { reasoningEffort: true }, codex: { reasoningEffort: true } },
    async fork(request: ForkRequest) {
      order.push("fork");
      forks.push(request);
      return info("starting");
    },
    async get() {
      order.push("ready");
      return info("ready");
    },
    async exec(request: { command: string; cwd?: string }) {
      order.push("exec");
      execs.push({ command: request.command, ...(request.cwd ? { cwd: request.cwd } : {}) });
      const out = options.exec?.(request.command) ?? { exitCode: 0 };
      return { detached: false as const, stdout: "", stderr: "", timedOut: false, truncated: false, ...out };
    },
    async prompt(request: (typeof prompts)[number]) {
      order.push("prompt");
      if (options.promptError) throw options.promptError;
      prompts.push(request);
      return { promptId: "prompt_1", conversationId: "conv_1", status: "queued" as PromptStatus };
    },
    async stop({ sandboxId }: { sandboxId: string }) {
      stopped.push(sandboxId);
    },
    async delete({ sandboxId }: { sandboxId: string }) {
      deleted.push(sandboxId);
      return { status: "pending" };
    },
  } as unknown as Provider;

  if (options.prepare) {
    provider.prepareNativeHarnessCwd = async (request) => {
      order.push("prepare");
      preparations.push(request);
      if (options.preparationError) throw options.preparationError;
    };
  }

  const caller = options.actor ?? owner;
  const goldens: GoldenStore = {
    async list() {
      return [];
    },
    async findByName(_org, name) {
      const row = options.golden;
      const visible = options.leaky || row.visibility === "org" || row.ownerId === caller.userId;
      return row.name === name && visible ? [row] : [];
    },
    async insert() {
      throw new Error("unused");
    },
    async setConfig() {},
    async setSandbox() {},
    async setSnapshot() {},
  };
  const credentials = {
    resolve: async (_actor: GoldenActor, harness: "claude" | "codex") => {
      order.push("credentials");
      if (options.credentialError) throw options.credentialError;
      return {
        ...(options.credentials ??
          toHarnessCredentials({
            env: harness === "claude" ? { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN } : { OPENAI_API_KEY: OPENAI_KEY },
            files: [],
            sources: [],
          })),
        ...(options.github ? { github: options.github } : {}),
      };
    },
  };
  const stores: LaunchStores = { goldens, sandboxes: sandboxStore(rows, options.insertError), credentials };
  return { provider, stores, forks, execs, prompts, stopped, deleted, rows, order, preparations };
}

function sandboxStore(rows: Map<string, SandboxRecord>, insertError?: Error): SandboxStore {
  return {
    async insert(input) {
      if (insertError) throw insertError;
      const record: SandboxRecord = {
        ...input,
        repositoryDir: input.repositoryDir ?? null,
        conversationIds: [],
        createdAt: "2026-11-08T12:00:00.000Z",
        stoppedAt: null,
        deletedAt: null,
        statusReason: null,
      };
      rows.set(input.id, record);
      return record;
    },
    async update(id, patch) {
      const row = rows.get(id);
      if (!row) throw new Error("missing sandbox");
      rows.set(id, { ...row, ...definedOnly(patch) });
    },
  };
}

function definedOnly(patch: SandboxPatch): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

function prompt(status: PromptStatus, reason?: string): AgentEvent {
  return {
    id: `prompt-${status}`,
    at: 1,
    promptId: "p1",
    kind: "prompt",
    text: "go",
    status,
    ...(reason ? { reason } : {}),
  };
}

function message(id: string, text: string, partial: boolean): AgentEvent {
  return { id, at: 2, promptId: "p1", kind: "message", text, partial, tools: [] };
}

function other_event(type: string, data: unknown): AgentEvent {
  return { id: `e-${type}`, at: 3, promptId: "p1", kind: "other", type, data };
}

function events(list: AgentEvent[]): AgentEvent[][] {
  return [list.slice(0, 1), list.slice(1)].filter((page) => page.length > 0);
}

function outcomeProvider(status: PromptStatus, pages: AgentEvent[][]): Provider {
  return {
    async getPrompt() {
      return { promptId: "p1", status, done: status !== "running" && status !== "queued" };
    },
    async events({ cursor, direction }: { cursor?: string; direction?: string }) {
      if (direction === "backward") {
        const index = cursor ? Number(cursor) : pages.length - 1;
        return { events: pages[index] ?? [], olderCursor: String(index - 1), hasMore: index > 0 };
      }
      const index = cursor ? Number(cursor) : 0;
      const page = pages[index] ?? [];
      const more = index + 1 < pages.length;
      return { events: page, cursor: String(index + 1), hasMore: more };
    },
  } as unknown as Provider;
}

test("launch resolves defaults once, respects exact and empty overrides, and fails before fork", async () => {
  for (const selected of [undefined, [], ["exact", "exact"]]) {
    const world = setup({ golden: golden("org") });
    let reads = 0;
    let bound: string[] = [];
    world.stores.connections = {
      defaults: async () => {
        reads++;
        return ["default"];
      },
      validate: async (_actor, ids) => {
        if (ids.includes("invalid")) throw Error("Reconnect");
      },
      bind: async (_sandbox, ids) => {
        bound = ids;
      },
    };
    await launchSandbox(world.provider, world.stores, owner, {
      golden: "web",
      harness: "claude",
      ...(selected === undefined ? {} : { connections: selected }),
    });
    expect(reads).toBe(selected === undefined ? 1 : 0);
    expect(bound).toEqual(selected === undefined ? ["default"] : selected.length ? ["exact"] : []);
    world.stores.connections.defaults = async () => ["changed"];
    expect(bound).not.toContain("changed");
  }
  const world = setup({ golden: golden("org") });
  world.stores.connections = {
    defaults: async () => ["invalid"],
    validate: async () => {
      throw Error("Reconnect");
    },
    bind: async () => {},
  };
  await expect(
    launchSandbox(world.provider, world.stores, owner, { golden: "web", harness: "claude" }),
  ).rejects.toThrow("Reconnect");
  expect(world.forks).toEqual([]);
});

for (const harness of ["claude", "codex"] as const) {
  test(`${harness} launch artifacts stay out of worker Git staging without changing tracked skills`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "armada-skill-exclude-"));
    const run = (...args: string[]) => {
      const result = Bun.spawnSync(args, { cwd: dir });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString();
    };
    try {
      run("git", "init", "--quiet");
      if (harness === "codex") rmSync(join(dir, ".git/info"), { recursive: true });
      else writeFileSync(join(dir, ".git/info/exclude"), "*.log"); // Existing file lacks a final LF.
      mkdirSync(join(dir, ".companion"), { recursive: true });
      writeFileSync(
        join(dir, ".companion/skills.lock.json"),
        catalogLock(harness === "claude" ? "claude-code" : "codex"),
      );
      writeFileSync(join(dir, ".companion/skills.lock.json.lock"), "");
      for (const tool of harness === "claude" ? [".agents", ".claude"] : [".agents"]) {
        mkdirSync(join(dir, tool, "skills/notes"), { recursive: true });
        writeFileSync(join(dir, tool, "skills/notes/SKILL.md"), "installed skill");
      }
      mkdirSync(join(dir, ".agents/skills/owned"), { recursive: true });
      writeFileSync(join(dir, ".agents/skills/owned/SKILL.md"), "owned skill");
      run("git", "add", ".agents/skills/owned/SKILL.md");
      writeFileSync(join(dir, "worker.ts"), "worker change");
      const world = setup({
        golden: golden("org"),
        prepare: true,
        exec: (command) => {
          if (command.includes("skillpack install"))
            return { exitCode: 0, stdout: catalogLock(harness === "claude" ? "claude-code" : "codex") };
          if (command.startsWith("exclude=")) run("sh", "-c", command);
          return { exitCode: 0 };
        },
      });
      world.stores.credentials.skillpackKey = async () => {
        throw new Error("Public pins must not resolve Skillpack credentials.");
      };
      world.stores.sandboxes.recordSkills = async () => {};
      await launchSandbox(world.provider, world.stores, owner, {
        golden: "web",
        harness,
        repo: "web",
        skills: [catalogReference],
      });
      run("git", "add", "-A");
      expect(run("git", "diff", "--cached", "--name-only").trim().split("\n")).toEqual([
        ".agents/skills/owned/SKILL.md",
        "worker.ts",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// Admission owns compatibility: an unsupported requirement must not allocate a worker.
test("helper admission preserves legacy launches and refuses missing, stale or unknown capabilities before fork", async () => {
  const receipt = {
    version: "0.1.0",
    protocol: 1,
    platform: "x86_64" as const,
    digest: helperManifest.x86_64.digest,
    capabilities: ["diagnose"],
    snapshotId: SNAPSHOT,
  };
  for (const variant of ["legacy", "missing", "new", "stale", "unknown", "bad-digest"] as const) {
    const selected = golden("org");
    if (!["legacy", "missing"].includes(variant))
      selected.helperReceipt = {
        ...receipt,
        ...(variant === "stale" ? { snapshotId: "old-snapshot" } : {}),
        ...(variant === "bad-digest" ? { digest: "0".repeat(64) } : {}),
      };
    const world = setup({ golden: selected });
    const request = {
      golden: "web",
      harness: "claude" as const,
      ...(variant === "legacy" ? {} : { helperCapabilities: [variant === "unknown" ? "github" : "diagnose"] }),
    };
    if (variant === "legacy" || variant === "new") {
      const result = await launchSandbox(world.provider, world.stores, owner, request);
      expect(result.helper.status).toBe(variant === "new" ? "supported" : "unsupported");
    } else {
      await expect(launchSandbox(world.provider, world.stores, owner, request)).rejects.toMatchObject({
        code: "unsupported",
        reason:
          variant === "missing"
            ? "helper_missing"
            : variant === "unknown"
              ? "helper_capability_unsupported"
              : "helper_receipt_invalid",
        action: "rebuild_golden",
      });
      expect(world.forks).toEqual([]);
    }
  }
});

test("plain launches merge default layers before installation; opt-out keeps explicit pins", async () => {
  const installed: string[] = [];
  const world = setup({ golden: golden("org") });
  let resolutions = 0;
  world.stores.skillDefaults = {
    resolve: async () => {
      resolutions++;
      return { environment: ["notes@1.0.0", "environment@1.0.0"], org: ["notes@2.0.0"], personal: ["notes@3.0.0"] };
    },
  };
  world.stores.sandboxes.recordSkills = async () => {};
  world.stores.credentials.installPrivateSkill = async (_provider, input) => {
    installed.push(input.reference);
    return {
      reference: input.reference,
      version: input.reference.split("@")[1]!,
      skillId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      workspaceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      checksum: `sha256:${"a".repeat(64)}`,
      origin: "https://skillpack.app/v1",
    };
  };
  await launchSandbox(world.provider, world.stores, owner, { golden: "web", harness: "codex" });
  expect(installed).toEqual(["notes@3.0.0", "environment@1.0.0"]);
  installed.length = 0;
  await launchSandbox(world.provider, world.stores, owner, {
    golden: "web",
    harness: "codex",
    skills: ["notes@4.0.0"],
    skipSkillDefaults: true,
  });
  expect(installed).toEqual(["notes@4.0.0"]);
  expect(resolutions).toBe(1);
  await expect(
    launchSandbox(world.provider, world.stores, owner, {
      golden: "web",
      harness: "codex",
      skipSkillDefaults: "yes" as never,
    }),
  ).rejects.toMatchObject({ code: "invalid_request" });
});

test("repository authorization preflight refuses before fork", async () => {
  const world = setup({ golden: golden("org") });
  world.stores.credentials.authorizeRepositories = async (actor, _credentials, repos) => {
    expect(actor.userId).toBe(owner.userId);
    expect(repos.map((repo) => repo.dir)).toEqual(["web", "api"]);
    throw new LaunchError("no_credentials", "Repository web needs GitHub access; run armada github connect.");
  };
  await expect(
    launchSandbox(world.provider, world.stores, owner, { golden: "web", harness: "claude" }),
  ).rejects.toMatchObject({ code: "no_credentials" });
  expect(world.forks).toEqual([]);
});

test.each(["boat", "modal", "docker"])(
  "shared %s refresh preserves helper authority and warns only on completed fetch network failure",
  async (id) => {
    const g = golden("org");
    g.config.repos = g.config.repos.slice(0, 1);
    g.config.init = ["echo ready"];
    const commands: string[] = [];
    const warnings = await prepareLaunchWorkspace(
      {
        id,
        exec: async (request) => {
          commands.push(request.command);
          expect(request.command).not.toContain("credential.helper=");
          return {
            detached: false,
            exitCode: request.command.includes("git fetch") ? 75 : 0,
            stdout: "",
            stderr: request.command.includes("git fetch")
              ? "fatal: Could not resolve host opaque-provider-data\nARMADA_REPOSITORY_FETCH_FAILED\n"
              : "",
            timedOut: false,
            truncated: false,
          };
        },
      },
      "physical",
      "logical",
      g,
      ["opaque-provider-data"],
      () => {},
    );
    expect(warnings).toEqual([expect.stringContaining("repository web")]);
    expect(warnings.join(" ")).toContain("snapshot checkout");
    expect(warnings.join(" ")).not.toContain("opaque-provider-data");
    expect(commands.at(-1)).toBe("echo ready");
  },
);

test.each(["auth", "merge-network", "timeout", "init"])(
  "refresh policy blocks %s failure without exposing credential diagnostics",
  async (mode) => {
    const g = golden("org");
    g.config.repos = g.config.repos.slice(0, 1);
    g.config.init = ["echo ready"];
    const failure = prepareLaunchWorkspace(
      {
        id: "boat",
        exec: async (request) => {
          const repository = request.command.includes("git fetch");
          const fails = mode === "init" ? !repository : repository;
          return {
            detached: false,
            exitCode: fails ? 1 : 0,
            stdout: "",
            stderr: !fails
              ? ""
              : mode === "auth"
                ? "fatal: could not read Username for https://github.com: terminal prompts disabled opaque-private-token"
                : mode === "merge-network"
                  ? "RPC failed\nARMADA_REPOSITORY_FETCH_FAILED\n"
                  : "ARMADA_REPOSITORY_FETCH_FAILED\nCould not resolve host",
            timedOut: fails && mode === "timeout",
            truncated: false,
          };
        },
      },
      "physical",
      "logical",
      g,
      ["opaque-private-token"],
      () => {},
    );
    if (mode === "auth")
      await expect(failure).rejects.toMatchObject({
        code: "no_credentials",
        message: expect.stringContaining("Repository web needs a GitHub connection"),
      });
    else await expect(failure).rejects.toMatchObject({ code: "init_failed" });
  },
);

test("native launch exposes snapshot fallback warnings in its existing GitHub result", async () => {
  const world = setup({
    golden: golden("org"),
    github: { status: "connected", token: GITHUB_TOKEN, identity: IDENTITY },
    exec: (command) =>
      command.includes("git fetch")
        ? { exitCode: 75, stderr: "Could not resolve host\nARMADA_REPOSITORY_FETCH_FAILED\n" }
        : { exitCode: 0 },
  });
  const result = await launchSandbox(world.provider, world.stores, owner, { golden: "web", harness: "claude" });
  expect(result.sandbox.status).toBe("ready");
  expect(result.github.message).toContain("snapshot checkout");
  expect(world.execs.some((exec) => exec.command === "pnpm i")).toBe(true);
});

test("generated refresh never merges after a failed fetch and preserves its completed failure marker", async () => {
  const { pullCommand } = await import("../src/index.ts");
  const spec = pullCommand(golden("org").config.repos[0]!);
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      `env() { [ "$1" = GIT_TERMINAL_PROMPT=0 ] || return 92; shift; "$@"; }
    git() { printf '%s\\n' "$1"; if [ "$1" = fetch ]; then printf 'Could not resolve host\\n' >&2; return 128; fi; return 0; }
    ${spec.command}`,
    ],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(75);
  expect(result.stdout.trim()).toBe("fetch");
  expect(result.stderr).toContain("ARMADA_REPOSITORY_FETCH_FAILED");
  expect(spec.command).not.toContain("credential.helper=");
});

test("generated refresh uses the installed caller helper without writing its token to commands or config", async () => {
  const { gitSetupCommand, pullCommand } = await import("../src/index.ts");
  const secret = "ghu_fixture_only";
  const spec = pullCommand(golden("org").config.repos[0]!);
  // Model only Git's helper selection protocol, never invoke real Git, a network,
  // or an ambient credential store. The executed helper is generated by setupGitHub.
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      `set -eu
    helper=''
    env() { [ "$1" = GIT_TERMINAL_PROMPT=0 ] || return 92; shift; "$@"; }
    git() {
      while [ "$1" = -c ]; do if [ "$2" = credential.helper= ]; then helper=''; fi; shift 2; done
      case "$1" in
        config) printf 'config:%s:%s:%s\\n' "$3" "$4" "\${5-}"; if [ "$2" = --global ] && [ "$3" = --add ] && [ "$4" = credential.https://github.com.helper ]; then helper="$5"; fi ;;
        pull|fetch)
          [ -n "$helper" ] || return 128
          local credential
          credential=$(printf 'protocol=https\\nhost=github.com\\nwwwauth[]=Basic realm=GitHub\\n\\n' | sh -c "\${helper#!} get") || return 128
          case "$credential" in *"password=$GH_TOKEN"*) printf 'fetch-authorized\\n' ;; *) return 128 ;; esac ;;
        merge) printf 'merge-authorized\\n' ;;
        *) return 93 ;;
      esac
    }
    ${gitSetupCommand({ ...IDENTITY, name: 'The "Octo\'cat"' })}
    ${spec.command}
    printf '%s\\n' "$helper"`,
    ],
    { env: { PATH: process.env.PATH ?? "", GH_TOKEN: secret }, encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('config:user.name:The "Octo\'cat":\n');
  expect(result.stdout).toContain("config:user.email:583231+octocat@users.noreply.github.com:\n");
  expect(result.stdout).toContain("config:--replace-all:url.https://github.com/.insteadOf:git@github.com:\n");
  expect(result.stdout).toContain("config:--add:url.https://github.com/.insteadOf:ssh://git@github.com/\n");
  expect(result.stdout).toContain("fetch-authorized");
  expect(result.stdout).toContain("merge-authorized");
  expect(spec.command + result.stdout + result.stderr).not.toContain(secret);
});

test("host_full fork refusal remains definite and does not publish or clean up a sandbox", async () => {
  const world = setup({ golden: golden("org") });
  const refusal = new ProviderError({
    provider: "docker",
    code: "host_full",
    retryable: false,
    message: "Stop a sandbox on the selected host or raise its limit.",
  });
  world.provider.fork = async () => {
    throw refusal;
  };
  await expect(launchSandbox(world.provider, world.stores, owner, { golden: "web", harness: "codex" })).rejects.toBe(
    refusal,
  );
  expect(world.rows.size).toBe(0);
  expect(world.stopped).toEqual([]);
  expect(world.deleted).toEqual([]);
});

test("Modal launch attributes readiness intervals in order and excludes the prompt", async () => {
  const world = setup({
    golden: {
      ...golden("org"),
      provider: "modal",
      providerSandboxId: "modal-builder",
      providerSnapshotId: "modal-image",
      modal: { workspace: "ws", environment: "main", appId: "app" },
    },
  });
  let time = 100;
  const clock = spyOn(performance, "now").mockImplementation(() => time);
  const logs: unknown[] = [];
  const logger = spyOn(console, "error").mockImplementation((line) => logs.push(JSON.parse(line)));
  const resolve = world.stores.credentials.resolve;
  world.stores.credentials.resolve = async (...args) => {
    time += 11;
    return resolve(...args);
  };
  world.stores.credentials.admit = async () => {
    time += 17;
  };
  const provider: Provider = {
    ...world.provider,
    id: "modal",
    async fork(request) {
      time += 23;
      return { ...(await world.provider.fork(request)), id: "modal-child" };
    },
    async get(id, options) {
      time += 4;
      return { ...(await world.provider.get(id, options)), id: "modal-child" };
    },
  };
  try {
    const result = await launchSandbox(
      provider,
      world.stores,
      owner,
      { golden: "web", harness: "codex", prompt: "go" },
      {
        runtime: {
          async start() {
            time += 31;
            return {
              epoch: "1",
              async prepareWorkspace() {
                time += 13;
                return { status: "not_connected" };
              },
              async prompt() {
                time += 1000;
                return { promptId: "p", conversationId: "c" };
              },
            };
          },
        },
      },
    );
    expect(logs).toContainEqual({
      event: "modal_launch_timing",
      sandboxId: result.sandbox.id,
      path: "enrolled",
      totalMs: 99,
      stages: [
        { stage: "launch_plan", ms: 0 },
        { stage: "credential_resolution", ms: 11 },
        { stage: "preallocation_admission", ms: 17 },
        { stage: "provider_allocation", ms: 23 },
        { stage: "registration_and_binding", ms: 0 },
        { stage: "machine_readiness", ms: 4 },
        { stage: "runtime_startup", ms: 31 },
        { stage: "workspace_preparation", ms: 13 },
        { stage: "finish_initialization", ms: 0 },
        { stage: "ready_stage_record", ms: 0 },
      ],
    });
    expect(result.promptId).toBe("p");
  } finally {
    logger.mockRestore();
    clock.mockRestore();
  }
});

// #2560: the launch itself records its stages; readiness precedes the launch prompt for every harness and path.
test.each([
  ["native", "claude"],
  ["native", "codex"],
  ["runtime", "claude"],
  ["runtime", "codex"],
] as const)("%s %s launch records each stage once, harness ready before its prompt", async (path, harness) => {
  const world = setup({ golden: golden("org") });
  const elapsed: Record<string, number> = {};
  const stored: Record<string, number> = {};
  // A deterministic monotonic clock: the fork returns at once and storing `accepted` is slow, the case where reading
  // the clock again per stage reported acceptance as younger than the provider claim.
  let clock = 0;
  const now = spyOn(performance, "now").mockImplementation(() => ++clock);
  world.stores.sandboxes.recordLaunchStage = async (_id, stage, ms) => {
    world.order.push(`stage:${stage}`);
    elapsed[stage] = ms ?? 0;
    stored[stage] = clock - (ms ?? 0);
    if (stage === "accepted") clock += 1_000;
  };
  const prompt = async () => {
    world.order.push("prompt");
    return { promptId: "p", conversationId: "c", status: "queued" as PromptStatus };
  };
  if (path === "runtime") world.provider.prompt = prompt;
  try {
    await launchSandbox(
      world.provider,
      world.stores,
      owner,
      { golden: "web", harness, prompt: "go" },
      path === "runtime"
        ? {
            boatRuntime: {
              async start() {
                world.order.push("start");
                return {
                  epoch: "1",
                  async prepareWorkspace() {
                    world.order.push("workspace");
                    return { status: "not_connected" as const };
                  },
                  prompt,
                };
              },
            },
          }
        : {},
    );
  } finally {
    now.mockRestore();
  }
  const stages = world.order.filter((step) => step.startsWith("stage:") || ["fork", "start", "prompt"].includes(step));
  expect(stages).toEqual([
    "fork",
    "stage:accepted",
    "stage:provider_claimed",
    "stage:machine_started",
    ...(path === "runtime" ? ["start"] : []),
    "stage:checkout_done",
    "stage:harness_ready",
    "prompt",
  ]);
  // Acceptance is dated from the request, before the fork the row waits for.
  expect(elapsed.accepted).toBeGreaterThanOrEqual(elapsed.provider_claimed!);
  // As stored: the database dates a stage by its own clock at write time minus the reported age.
  expect(stored.accepted).toBeLessThanOrEqual(stored.provider_claimed!);
});
