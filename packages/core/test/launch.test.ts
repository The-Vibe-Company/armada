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
const CLAUDE_TOKEN = "sk-ant-oat01-user-token-value";
const OPENAI_KEY = "sk-openai-user-key-value";
const AUTH_JSON = JSON.stringify({ tokens: { access_token: "codex-access-token-value", account_id: "acct" } });
const authCredentials = () =>
  toHarnessCredentials({
    env: {},
    files: [{ path: CODEX_AUTH_PATH, content: AUTH_JSON, mode: 0o600 }],
    sources: [],
  });

const GITHUB_TOKEN = "ghu_launch_test_token_aaaaaaaaaaaaaaaaaaaa";
const IDENTITY = {
  login: "octocat",
  id: 583231,
  name: "The Octocat",
  email: "583231+octocat@users.noreply.github.com",
};

const owner: GoldenActor = { userId: OWNER, orgId: ORG, role: "member" };
const other: GoldenActor = { userId: OTHER, orgId: ORG, role: "member" };

describe("launch", () => {
  test.each([true, false])(
    "ordinary runtime default prepares workspace before publication/inference (prompt=%s)",
    async (prompted) => {
      const world = setup({ golden: golden("org") }),
        order: string[] = [],
        commands: string[] = [];
      const resolve = world.stores.credentials.resolve.bind(world.stores.credentials);
      const credentials = {
        ...world.stores.credentials,
        async resolve(...args: Parameters<typeof resolve>) {
          return { ...(await resolve(...args)), binding: { credentialId: OWNER, credentialVersion: 1 } };
        },
      };
      const result = await launchSandbox(
        world.provider,
        world.stores,
        owner,
        { golden: "web", harness: "codex", ...(prompted ? { prompt: "ordinary request" } : {}) },
        {
          beforeStart: async () => {
            order.push("admit");
          },
          boatRuntimeDefault: {
            provider: async () => world.provider,
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
                        id: "boat",
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
          },
        },
      );
      expect(result.runtime).toEqual({ kind: "armada", epoch: "1" });
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
  test.each(["key", "auth"] as const)(
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
          harness: "codex",
          repo: "web",
          prompt: "runtime answer",
          model: "gpt-5.4",
          reasoningEffort: "high",
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
        { sandboxId: "bx_1", harness: "codex", text: "runtime answer", model: "gpt-5.4", reasoningEffort: "high" },
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

  test.each([
    "harness",
    "mcp",
    "mcp-prepare",
    "skills",
    "parent",
    "selection",
    "startup",
    "invalid-epoch",
    "prompt",
  ] as const)("experimental launch refuses %s without a native fallback", async (failure) => {
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
        failure === "harness"
          ? { ...world.provider, harnesses: [...world.provider.harnesses, "opencode"] }
          : world.provider,
        world.stores,
        owner,
        {
          golden: "web",
          harness: failure === "harness" ? "opencode" : "codex",
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
      ...(failure === "harness"
        ? { message: "The experimental runtime supports ordinary Boat Codex/Claude or Modal Codex workers only." }
        : {}),
      code: ["harness", "mcp", "skills", "parent"].includes(failure)
        ? "invalid_request"
        : failure === "prompt"
          ? "prompt_failed"
          : "start_failed",
    });
    expect(world.prompts).toEqual([]);
    expect(world.execs).toEqual([]);
    if (["harness", "mcp", "skills", "parent"].includes(failure)) expect(world.forks).toEqual([]);
    else {
      expect(world.stopped).toEqual(["bx_1"]);
      expect([...world.rows.values()][0]?.status).toBe("failed");
      expect([...world.rows.values()][0]?.statusReason).not.toContain(OPENAI_KEY);
    }
    expect(starts).toBe(["startup", "invalid-epoch", "prompt", "mcp-prepare"].includes(failure) ? 1 : 0);
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
      model: "armada/deepseek-flash",
      prompt: "hello",
    });
    expect(launched.sandbox.harness).toBe("opencode");
    expect(world.forks).toHaveLength(1);
    expect(world.prompts).toContainEqual(
      expect.objectContaining({
        harness: "opencode",
        model: "armada/deepseek-flash",
        reasoningEffort: "default",
        text: "hello",
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
    expect(world.execs[0]?.command).toContain("'pull' '--ff-only' 'origin' 'main'");
    expect(world.execs[1]?.command).toContain("'dev'");
    expect(world.execs[2]?.command).toBe("pnpm i");
    expect(world.prompts).toEqual([
      {
        signal: expect.any(AbortSignal),
        sandboxId: "bx_1",
        harness: "claude",
        text: "Fix the build",
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

  test("idle explicit repo is prepared before launch returns and a later native send", async () => {
    const world = setup({ golden: golden("org"), prepare: true });
    const result = await launchSandbox(world.provider, world.stores, owner, {
      golden: "web",
      harness: "claude",
      repo: "example/web",
    });
    expect(result.sandbox.status).toBe("ready");
    expect(world.prompts).toEqual([]);
    expect(world.order).toEqual(["credentials", "fork", "ready", "exec", "exec", "exec", "prepare", "exec"]);
    await world.provider.prompt({ sandboxId: result.sandbox.providerSandboxId, harness: "claude", text: "Later" });
    expect(world.order.slice(-3)).toEqual(["prepare", "exec", "prompt"]);
    expect(world.preparations).toHaveLength(1);
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
        command.includes("'pull'") ? { exitCode: 128, stderr: "fatal: not possible to fast-forward" } : { exitCode: 0 },
    });
    await expect(
      launchSandbox(world.provider, world.stores, owner, { golden: "web", harness: "claude" }),
    ).rejects.toThrow(/git pull of web failed \(exit 128\)\.\nfatal: not possible to fast-forward/);
    expect(world.execs.some((exec) => exec.command === "pnpm i")).toBe(false);
    expect(world.execs.filter((exec) => exec.command.includes("'pull'"))).toHaveLength(1);
  });

  test.each([
    { repo: undefined, transient: true },
    { repo: "example/web", transient: true },
    { repo: undefined, transient: false },
    { repo: "example/web", transient: false },
  ])("ownership rejection retries once, then succeeds or cleans up (%j)", async ({ repo, transient }) => {
    const diagnostics: string[] = [];
    const waits: number[] = [];
    const log = spyOn(console, "info").mockImplementation((line: string) => {
      diagnostics.push(line);
    });
    let rejectedPulls = 0;
    const world = setup({
      golden: golden("org"),
      prepare: true,
      exec: (command) =>
        command.includes("'pull'") && (!transient || rejectedPulls++ === 0)
          ? {
              exitCode: 128,
              stderr: "fatal: detected dubious ownership in repository at '/home/user/web'\n" + "x".repeat(2500),
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
            expect(world.execs.filter((exec) => exec.command.includes("'pull'"))).toHaveLength(1);
            waits.push(ms);
          },
        },
      ).catch((error: unknown) => error as LaunchError);
    } finally {
      log.mockRestore();
    }
    expect(waits).toEqual([1000]);
    expect(diagnostics.map((line) => JSON.parse(line))).toEqual([
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
    expect(world.execs.filter((exec) => exec.cwd === "/home/user/web" && exec.command.includes("'pull'"))).toHaveLength(
      2,
    );
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
    expect((error.cause as Error).message).toContain("git pull of web failed (exit 128)");
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
    ).toEqual({ state: "failed", reason: "out of credit" });
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
        reason: "Plan limit reached. Try again after the limit resets.",
        limit: { code: "usage_limit_exceeded" },
      });
    }
    expect(
      await promptOutcome(outcomeProvider("failed", events([prompt("failed", "authentication_failed"), limit])), {
        sandboxId: "s",
        promptId: "p1",
      }),
    ).toEqual({ state: "failed", reason: "authentication_failed" });
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
    async listBefore(cutoff) {
      return [...rows.values()].filter((row) => row.createdAt < cutoff && row.status !== "deleted");
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
