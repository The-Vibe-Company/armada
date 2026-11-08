import { describe, expect, test } from "bun:test";
import {
  boatSnapshotName,
  configFromFlags,
  connectGolden,
  createGolden,
  GOLDEN_BUILD_TTL_SECONDS,
  GOLDEN_ROOT,
  type GoldenActor,
  GoldenError,
  type GoldenRecord,
  type GoldenStore,
  goldenForLaunch,
  type Provider,
  ProviderError,
  parseGoldenConfig,
  type SandboxInfo,
  snapshotGolden,
} from "../src/server.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const ADMIN = "44444444-4444-4444-8444-444444444444";

const owner: GoldenActor = { userId: OWNER, orgId: ORG, role: "member" };
const member: GoldenActor = { userId: MEMBER, orgId: ORG, role: "member" };
const admin: GoldenActor = { userId: ADMIN, orgId: ORG, role: "admin" };

const WEB = "https://github.com/example/web.git";
const API = "https://github.com/example/api.git";

describe("golden config", () => {
  test("flags and a file become the same config, with a directory per repo", () => {
    const fromFlags = configFromFlags([`${WEB}@main`, `${API}@feature/login`], ["pnpm i", "pnpm build"]);
    const fromFile = parseGoldenConfig({
      repos: [
        { url: WEB, branch: "main" },
        { url: API, branch: "feature/login" },
      ],
      init: ["pnpm i", "pnpm build"],
    });
    expect(fromFlags).toEqual(fromFile);
    expect(fromFlags.repos.map((repo) => repo.dir)).toEqual(["web", "api"]);
  });

  test("an omitted branch is main, and two repos with the same name get distinct directories", () => {
    const config = parseGoldenConfig({
      repos: [{ url: WEB }, { url: "https://github.com/example/web.git" }],
    });
    expect(config.repos.map((repo) => [repo.branch, repo.dir])).toEqual([
      ["main", "web"],
      ["main", "web-2"],
    ]);
    expect(config.init).toEqual([]);
  });

  test("a secret key is refused, including inside a command and a repository URL", () => {
    expect(() => parseGoldenConfig({ repos: [{ url: WEB }], api_key: "nope" })).toThrow(
      /must not contain secrets \(key "api_key"\)/,
    );
    expect(() => parseGoldenConfig({ repos: [{ url: WEB }], env: { token: "nope" } })).toThrow(/key "env.token"/);
    expect(() => parseGoldenConfig({ repos: [{ url: WEB }], init: ["export API_KEY=sk-test"] })).toThrow(
      /key "API_KEY"/,
    );
    expect(() => configFromFlags(["https://user:ghp_example@github.com/example/web.git"], [])).toThrow(
      /must not contain credentials/,
    );
    expect(() => configFromFlags([WEB], [])).not.toThrow();
  });

  test("ssh and scp URLs keep an optional branch, and a query is refused", () => {
    expect(configFromFlags(["git@github.com:example/web.git@dev"], []).repos[0]).toMatchObject({
      url: "git@github.com:example/web.git",
      branch: "dev",
      dir: "web",
    });
    expect(configFromFlags(["ssh://git@github.com/example/web.git"], []).repos[0]?.url).toBe(
      "ssh://git@github.com/example/web.git",
    );
    expect(() => configFromFlags(["https://github.com/example/web.git?token=1"], [])).toThrow(/query/);
  });

  test("the boat snapshot name is namespaced, stable and a legal boat name", () => {
    const base = { orgId: ORG, ownerId: OWNER, visibility: "private" as const, name: "Web" };
    const name = boatSnapshotName(base);
    expect(name).toBe(boatSnapshotName(base));
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
    expect(name).toHaveLength(63);
    expect(boatSnapshotName({ ...base, orgId: MEMBER })).not.toBe(name);
    expect(boatSnapshotName({ ...base, ownerId: ADMIN })).not.toBe(name);
    expect(boatSnapshotName({ ...base, visibility: "org" })).not.toBe(name);
    expect(boatSnapshotName({ ...base, name: "web" })).not.toBe(name);
  });
});

describe("golden workflow", () => {
  test("create clones every repo and runs init, with no account environment", async () => {
    const rows: GoldenRecord[] = [];
    const boat = scripted();
    const created = await createGolden(boat.provider, memory(rows, admin), admin, {
      name: "web",
      visibility: "org",
      config: configFromFlags([`${WEB}@main`, `${API}@release`], ["pnpm i"]),
    });
    expect(created.sandboxId).toBe("bx_23456789");
    expect(created.snapshotName).toHaveLength(63);
    expect(boat.create).toEqual([
      {
        name: "web",
        ttlSeconds: GOLDEN_BUILD_TTL_SECONDS,
        idempotencyKey: created.golden.id,
        labels: {
          armada: "golden",
          org: ORG,
          owner: ADMIN,
          visibility: "org",
          golden: "web",
          snapshot: created.snapshotName,
        },
      },
    ]);
    expect(JSON.stringify(boat.create)).not.toMatch(/env|ANTHROPIC|api_key/i);
    expect(boat.exec.map((call) => call.command)).toEqual([
      expect.stringContaining(WEB),
      expect.stringContaining(API),
      "pnpm i",
    ]);
    expect(boat.exec.every((call) => call.cwd === GOLDEN_ROOT)).toBe(true);
    expect(boat.exec[0]?.command).toContain("credential.helper=");
    expect(boat.exec[0]?.command).not.toContain("ANTHROPIC");
    expect(rows[0]?.providerSandboxId).toBe("bx_23456789");
    expect(rows[0]?.providerSnapshotId).toBeNull();
  });

  test("a failed init leaves the sandbox recorded and does not snapshot", async () => {
    const rows: GoldenRecord[] = [];
    const boat = scripted({ execCode: 1 });
    await expect(
      createGolden(boat.provider, memory(rows, owner), owner, {
        name: "web",
        visibility: "private",
        config: configFromFlags([WEB], ["pnpm i"]),
      }),
    ).rejects.toMatchObject({ code: "setup_failed" });
    expect(rows[0]?.providerSandboxId).toBe("bx_23456789");
    expect(boat.snapshots).toHaveLength(0);
  });

  test("a lost sandbox id is retried with the same idempotency key", async () => {
    const rows: GoldenRecord[] = [];
    const boat = scripted({ failCreates: 1 });
    const store = memory(rows, owner);
    const input = { name: "web", visibility: "private" as const, config: configFromFlags([WEB], []) };
    await expect(createGolden(boat.provider, store, owner, input)).rejects.toBeInstanceOf(ProviderError);
    const created = await createGolden(boat.provider, store, owner, input);
    expect(boat.create.map((call) => call.idempotencyKey)).toEqual([created.golden.id, created.golden.id]);
    expect(rows).toHaveLength(1);
  });

  test("snapshot polls until the save is ready and records the namespaced name", async () => {
    const rows: GoldenRecord[] = [];
    const boat = scripted({ snapshotStatuses: ["saving", "ready"] });
    const store = memory(rows, owner);
    const created = await createGolden(boat.provider, store, owner, {
      name: "web",
      visibility: "private",
      config: configFromFlags([WEB, API], ["pnpm i"]),
    });
    let waits = 0;
    const saved = await snapshotGolden(boat.provider, store, owner, "web", {
      sleep: async () => {
        waits += 1;
      },
      snapshotPolls: 5,
    });
    expect(saved.snapshotName).toBe(created.snapshotName);
    expect(rows[0]?.providerSnapshotId).toBe(saved.snapshotName);
    expect(waits).toBe(1);
    const launch = await goldenForLaunch(store, owner, "web");
    expect(launch.providerSnapshotId).toBe(saved.snapshotName);
  });

  test("a save already in progress is polled instead of started again", async () => {
    const rows: GoldenRecord[] = [];
    const boat = scripted({
      snapshotStatuses: ["ready"],
      snapshotError: new ProviderError({
        provider: "boat",
        code: "conflict",
        message: "save in progress",
        providerCode: "save_in_progress",
        retryable: false,
      }),
    });
    const store = memory(rows, owner);
    await createGolden(boat.provider, store, owner, {
      name: "web",
      visibility: "private",
      config: configFromFlags([WEB], []),
    });
    const saved = await snapshotGolden(boat.provider, store, owner, "web", { sleep: async () => {}, snapshotPolls: 3 });
    expect(saved.snapshotName).toHaveLength(63);
    expect(boat.snapshots).toHaveLength(1);
  });

  test("only an admin creates or changes an org golden, and a member can launch it", async () => {
    const rows: GoldenRecord[] = [];
    const boat = scripted({ snapshotStatuses: ["ready"] });
    await createGolden(boat.provider, memory(rows, admin), admin, {
      name: "shared",
      visibility: "org",
      config: configFromFlags([WEB], []),
    });
    await expect(
      createGolden(boat.provider, memory(rows, member), member, {
        name: "other",
        visibility: "org",
        config: configFromFlags([WEB], []),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(rows.map((row) => row.name)).toEqual(["shared"]);
    await expect(snapshotGolden(boat.provider, memory(rows, member), member, "shared")).rejects.toMatchObject({
      code: "forbidden",
    });
    await snapshotGolden(boat.provider, memory(rows, admin), admin, "shared", {
      sleep: async () => {},
      snapshotPolls: 2,
    });
    expect((await goldenForLaunch(memory(rows, member), member, "shared")).name).toBe("shared");
  });

  test("a private golden is visible to its owner and absent for everyone else", async () => {
    const rows: GoldenRecord[] = [];
    const boat = scripted({ snapshotStatuses: ["ready"] });
    await createGolden(boat.provider, memory(rows, owner), owner, {
      name: "kept",
      visibility: "private",
      config: configFromFlags([WEB], []),
    });
    await snapshotGolden(boat.provider, memory(rows, owner), owner, "kept", {
      sleep: async () => {},
      snapshotPolls: 2,
    });
    expect((await goldenForLaunch(memory(rows, owner), owner, "kept")).visibility).toBe("private");
    expect(await memory(rows, member).list(ORG)).toEqual([]);
    expect(await memory(rows, admin).list(ORG)).toEqual([]);
    await expect(goldenForLaunch(memory(rows, member), member, "kept")).rejects.toMatchObject({ code: "not_found" });
    await expect(goldenForLaunch(memory(rows, admin), admin, "kept")).rejects.toMatchObject({ code: "not_found" });
    await expect(connectGolden(boat.provider, memory(rows, member), member, "kept")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  test("connect reports the sandbox once it is ready", async () => {
    const rows: GoldenRecord[] = [];
    const boat = scripted();
    const store = memory(rows, owner);
    await createGolden(boat.provider, store, owner, {
      name: "web",
      visibility: "private",
      config: configFromFlags([WEB], []),
    });
    const connected = await connectGolden(boat.provider, store, owner, "web", {
      sleep: async () => {},
      sandboxPolls: 3,
    });
    expect(connected.sandbox).toMatchObject({ id: "bx_23456789", state: "ready" });
    expect(connected.golden.config.repos[0]?.dir).toBe("web");
  });
});

function memory(rows: GoldenRecord[], actor: GoldenActor): GoldenStore {
  const visible = (row: GoldenRecord) =>
    row.orgId === actor.orgId && (row.visibility === "org" || row.ownerId === actor.userId);
  const writable = (row: GoldenRecord) =>
    visible(row) && (row.visibility === "private" ? row.ownerId === actor.userId : actor.role === "admin");

  return {
    async list(orgId) {
      return rows.filter((row) => row.orgId === orgId && visible(row));
    },
    async findByName(orgId, name) {
      return rows.filter((row) => row.orgId === orgId && row.name === name && visible(row));
    },
    async insert(input) {
      if (input.ownerId !== actor.userId) throw new GoldenError("forbidden", "You cannot change this golden.");
      if (input.visibility === "org" && actor.role !== "admin") {
        throw new GoldenError("forbidden", "You cannot change this golden.");
      }
      const row: GoldenRecord = {
        id: crypto.randomUUID(),
        orgId: input.orgId,
        name: input.name,
        visibility: input.visibility,
        ownerId: input.ownerId,
        provider: input.provider,
        providerSnapshotId: null,
        providerSandboxId: null,
        modal: input.modal,
        config: input.config,
        createdAt: "2026-11-08T12:00:00.000Z",
      };
      rows.push(row);
      return row;
    },
    async setConfig(id, config) {
      const row = rows.find((item) => item.id === id && writable(item));
      if (!row) throw new GoldenError("forbidden", "The golden could not be updated.");
      row.config = config;
    },
    async setSandbox(id, providerSandboxId) {
      const row = rows.find((item) => item.id === id && writable(item));
      if (!row) throw new GoldenError("forbidden", "The golden could not be updated.");
      row.providerSandboxId = providerSandboxId;
    },
    async setSnapshot(id, providerSnapshotId) {
      const row = rows.find((item) => item.id === id && writable(item));
      if (!row) throw new GoldenError("forbidden", "The golden could not be updated.");
      row.providerSnapshotId = providerSnapshotId;
    },
  };
}

function scripted(
  options: { execCode?: number; failCreates?: number; snapshotStatuses?: string[]; snapshotError?: Error } = {},
) {
  const create: { name: string; ttlSeconds: number; idempotencyKey: string; labels: Record<string, string> }[] = [];
  const exec: { command: string; cwd?: string }[] = [];
  const snapshots: unknown[] = [];
  let createsLeft = options.failCreates ?? 0;
  const statuses = [...(options.snapshotStatuses ?? ["ready"])];
  const sandbox = (state: SandboxInfo["state"]): SandboxInfo => ({
    id: "bx_23456789",
    name: "web",
    state,
    providerState: state,
    labels: {},
  });
  const provider = {
    id: "boat",
    harnesses: ["claude", "codex"],
    capabilities: { claude: caps(), codex: caps() },
    async createGolden(request: {
      name: string;
      ttlSeconds: number;
      idempotencyKey: string;
      labels: Record<string, string>;
    }) {
      create.push(request);
      if (createsLeft > 0) {
        createsLeft -= 1;
        throw new ProviderError({ provider: "fake", code: "unavailable", message: "lost response", retryable: true });
      }
      return sandbox("starting");
    },
    async get() {
      return sandbox("ready");
    },
    async exec(request: { command: string; cwd?: string }) {
      exec.push({ command: request.command, ...(request.cwd ? { cwd: request.cwd } : {}) });
      return {
        detached: false as const,
        exitCode: options.execCode ?? 0,
        stdout: "",
        stderr: options.execCode ? "missing package" : "",
        timedOut: false,
        truncated: false,
      };
    },
    async snapshot(request: unknown) {
      snapshots.push(request);
      if (options.snapshotError) throw options.snapshotError;
      return { name: "pending", status: "saving" as const };
    },
    async getSnapshot() {
      const status = statuses.shift() ?? "ready";
      if (status === "failed") return { name: "pending", status: "failed" as const, error: "disk full" };
      if (status === "saving") return { name: "pending", status: "saving" as const };
      return { name: "pending", status: "ready" as const };
    },
  };
  return { provider: provider as unknown as Provider, create, exec, snapshots };
}

function caps() {
  return {
    steer: "none" as const,
    interrupt: false,
    resume: false,
    parallelConversations: false,
    reasoningEffort: false,
    fast: false,
    streamsPartials: false,
    toolEvents: false,
    approvals: false,
  };
}

describe("GitHub golden normalization", () => {
  test("keeps branch slash names, custom directories, and init commands", async () => {
    const { normalizeGitHubGoldenConfig } = await import("../src/server.ts");
    const config = parseGoldenConfig({
      repos: [
        { url: "https://github.com/acme/web.git", branch: "feature/login", dir: "frontend" },
        { url: "git@github.com:acme/api.git", branch: "release/2026" },
      ],
      init: ["pnpm install"],
    });
    expect(normalizeGitHubGoldenConfig(config)).toEqual({
      repos: [
        { owner: "acme", repo: "web", branch: "feature/login", dir: "frontend" },
        { owner: "acme", repo: "api", branch: "release/2026", dir: "api" },
      ],
      init: ["pnpm install"],
    });
  });

  test("refuses non-GitHub or credential-bearing repository URLs without echoing them", async () => {
    const { normalizeGitHubGoldenConfig } = await import("../src/server.ts");
    const otherHost = parseGoldenConfig({ repos: [{ url: "https://evil.example/acme/web.git" }] });
    expect(() => normalizeGitHubGoldenConfig(otherHost)).toThrow("GitHub repository");
    expect(() => parseGoldenConfig({ repos: [{ url: "https://user:secret@github.com/acme/web.git" }] })).toThrow(
      "must not contain credentials",
    );
    try {
      parseGoldenConfig({ repos: [{ url: "https://user:secret@github.com/acme/web.git" }] });
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });
});

test("connect restores a stopped master from its saved snapshot", async () => {
  const row: GoldenRecord = {
    provider: "boat",
    modal: null,
    id: "g",
    orgId: ORG,
    name: "web",
    visibility: "private",
    ownerId: OWNER,
    providerSandboxId: "bx_old",
    providerSnapshotId: "golden-old",
    config: configFromFlags([WEB], []),
    createdAt: "now",
  };
  const store = memory([row], owner);
  let forked = false;
  const provider = {
    ...scripted().provider,
    async get(id: string) {
      return { id, name: "web", state: id === "bx_old" ? "stopped" : "ready", providerState: "", labels: {} };
    },
    async fork(input: { from: string; noEnv: boolean }) {
      forked = input.from === "golden-old" && input.noEnv;
      return { id: "bx_new", name: "web", state: "starting", providerState: "", labels: {} };
    },
  } as unknown as Provider;
  const connected = await connectGolden(provider, store, owner, "web", { sleep: async () => {} });
  expect(forked).toBe(true);
  expect(connected.golden.providerSandboxId).toBe("bx_new");
});

test("connect fallback still denies a private golden to another member", async () => {
  const row: GoldenRecord = {
    provider: "boat",
    modal: null,
    id: "g",
    orgId: ORG,
    name: "web",
    visibility: "private",
    ownerId: OWNER,
    providerSandboxId: "bx_old",
    providerSnapshotId: "golden-old",
    config: configFromFlags([WEB], []),
    createdAt: "now",
  };
  await expect(connectGolden(scripted().provider, memory([row], member), member, "web")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("core mutations reject an out-of-org row even if a privileged store returns it", async () => {
  const row: GoldenRecord = {
    id: "foreign",
    orgId: "another-org",
    name: "web",
    visibility: "org",
    ownerId: ADMIN,
    provider: "boat",
    providerSandboxId: "master",
    providerSnapshotId: "saved",
    modal: null,
    config: configFromFlags([WEB], []),
    createdAt: "2026-11-08T00:00:00Z",
  };
  let effects = 0;
  const store: GoldenStore = { ...memory([], admin), findByName: async () => [row] };
  const provider = {
    ...scripted().provider,
    get: async () => {
      effects++;
      throw new Error("provider touched");
    },
    snapshot: async () => {
      effects++;
      throw new Error("provider touched");
    },
  };
  await expect(connectGolden(provider, store, admin, "web")).rejects.toMatchObject({ code: "not_found" });
  await expect(snapshotGolden(provider, store, admin, "web")).rejects.toMatchObject({ code: "not_found" });
  await expect(
    createGolden(provider, store, admin, { name: "web", visibility: "org", config: row.config }),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(effects).toBe(0);
});
