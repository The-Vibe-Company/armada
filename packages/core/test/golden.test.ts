import { describe, expect, test } from "bun:test";
import type {
  Caller,
  CreateGoldenRequest,
  ExecRequest,
  GoldenConfig,
  GoldenRow,
  GoldenStore,
  HarnessCapabilities,
  NewGolden,
  Provider,
  SandboxInfo,
  SnapshotInfo,
} from "../src/index.ts";
import {
  boatSnapshotName,
  connectGolden,
  createGolden,
  GOLDEN_BUILD_TTL_SECONDS,
  GOLDEN_WORKSPACE,
  GoldenError,
  goldenSetupCommands,
  LABEL_GOLDEN_ID,
  LABEL_PURPOSE,
  listGoldens,
  MODEL_CREDENTIAL_ENV,
  PURPOSE_GOLDEN,
  parseGoldenConfig,
  resolveGolden,
  snapshotGolden,
} from "../src/index.ts";
import { ProviderError } from "../src/provider.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const ADMIN = "44444444-4444-4444-8444-444444444444";

const admin: Caller = { userId: ADMIN, orgId: ORG, role: "admin" };
const owner: Caller = { userId: OWNER, orgId: ORG, role: "member" };
const other: Caller = { userId: OTHER, orgId: ORG, role: "member" };

const CAP: HarnessCapabilities = {
  steer: "none",
  interrupt: false,
  resume: false,
  parallelConversations: false,
  reasoningEffort: false,
  fast: false,
  streamsPartials: false,
  toolEvents: false,
  approvals: false,
};

function config(): GoldenConfig {
  return parseGoldenConfig({
    repos: [{ url: "https://example.com/app.git", branch: "main" }, { url: "git@github.com:example/web.git" }],
    init: ["pnpm i", "pnpm test"],
  });
}

function memory(initial: GoldenRow[] = []): GoldenStore & { rows: GoldenRow[] } {
  const rows = [...initial];
  return {
    rows,
    async listOrg(orgId) {
      return rows.filter((row) => row.orgId === orgId);
    },
    async insert(row: NewGolden) {
      const clash = rows.some((existing) => {
        if (existing.orgId !== row.orgId || existing.name !== row.name) return false;
        if (row.visibility === "org" && existing.visibility === "org") return true;
        return row.visibility === "private" && existing.visibility === "private" && existing.ownerId === row.ownerId;
      });
      if (clash) throw new GoldenError("exists", `golden '${row.name}' already exists`);
      const stored: GoldenRow = { ...row, createdAt: "2026-11-08T12:00:00.000Z" };
      rows.push(stored);
      return stored;
    },
    async updateConfig(id, next) {
      const row = rows.find((item) => item.id === id);
      if (!row) throw new GoldenError("not_found", "missing");
      row.config = next;
    },
    async setSnapshot(id, boatSnapshotId) {
      const row = rows.find((item) => item.id === id);
      if (!row) throw new GoldenError("not_found", "missing");
      row.boatSnapshotId = boatSnapshotId;
    },
  };
}

function sandbox(id: string, labels: Record<string, string>, state: SandboxInfo["state"] = "ready"): SandboxInfo {
  return { id, name: "golden", state, providerState: state, labels, createdAt: new Date("2026-11-08T12:00:00Z") };
}

function okExec() {
  return { detached: false as const, exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
}

function provider(options?: {
  snapshot?: SnapshotInfo["status"];
  /** First matching exec fails once. */
  failCommand?: string;
  conflict?: boolean;
}) {
  const sandboxes: SandboxInfo[] = [];
  const created: CreateGoldenRequest[] = [];
  const executed: ExecRequest[] = [];
  const sleeps: number[] = [];
  let failed = false;
  let snapshotReads = 0;
  const base = {
    id: "test",
    harnesses: ["claude", "codex"] as const,
    capabilities: { claude: CAP, codex: CAP },
  };
  const unused = async (name: string) => {
    throw new Error(`provider.${name} was called`);
  };
  const impl: Provider = {
    ...base,
    async createGolden(request) {
      created.push(request);
      const info = sandbox(`bx_${sandboxes.length + 1}`, request.labels ?? {});
      sandboxes.push(info);
      return info;
    },
    async snapshot(request) {
      if (options?.conflict) {
        throw new ProviderError({
          provider: "test",
          code: "conflict",
          message: "save in progress",
          retryable: false,
          providerCode: "save_in_progress",
        });
      }
      const status = options?.snapshot ?? "ready";
      const info: SnapshotInfo = { name: request.name, status, sourceSandboxId: request.sandboxId };
      if (status === "failed") info.error = "disk full";
      return info;
    },
    async getSnapshot(name) {
      snapshotReads += 1;
      const requested = options?.snapshot ?? "ready";
      const status = requested === "saving" ? "ready" : requested;
      const info: SnapshotInfo = { name, status };
      if (status === "failed") info.error = "disk full";
      return info;
    },
    async get(id) {
      const found = sandboxes.find((item) => item.id === id);
      if (!found) throw new Error(`missing sandbox ${id}`);
      return found;
    },
    async list(request) {
      const labels = request?.labels ?? {};
      const items = sandboxes.filter((item) =>
        Object.entries(labels).every(([key, value]) => item.labels[key] === value),
      );
      return { items, cursor: null };
    },
    async exec(request) {
      executed.push(request);
      if (options?.failCommand && request.command.includes(options.failCommand) && !failed) {
        failed = true;
        return { ...okExec(), exitCode: 1 };
      }
      return okExec();
    },
    deleteSnapshot: () => unused("deleteSnapshot"),
    fork: () => unused("fork"),
    prompt: () => unused("prompt"),
    getPrompt: () => unused("getPrompt"),
    steer: () => unused("steer"),
    interrupt: () => unused("interrupt"),
    events: () => unused("events"),
    stop: () => unused("stop"),
    delete: () => unused("delete"),
  };
  return {
    provider: impl,
    created,
    executed,
    sleeps,
    sandboxes,
    snapshotReads: () => snapshotReads,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

describe("golden config", () => {
  test("accepts repos, branches and init in order", () => {
    const parsed = config();
    expect(parsed.repos.map((repo) => repo.branch ?? "default")).toEqual(["main", "default"]);
    expect(parsed.init).toEqual(["pnpm i", "pnpm test"]);
    expect(goldenSetupCommands(parsed).map((step) => step.command)).toEqual([
      `mkdir -p '${GOLDEN_WORKSPACE}'`,
      `if [ ! -d '${GOLDEN_WORKSPACE}/app/.git' ]; then GIT_TERMINAL_PROMPT=0 git clone --branch 'main' --single-branch 'https://example.com/app.git' '${GOLDEN_WORKSPACE}/app'; fi`,
      `if [ ! -d '${GOLDEN_WORKSPACE}/web/.git' ]; then GIT_TERMINAL_PROMPT=0 git clone 'git@github.com:example/web.git' '${GOLDEN_WORKSPACE}/web'; fi`,
      "bash -c 'pnpm i'",
      "bash -c 'pnpm test'",
    ]);
    expect(goldenSetupCommands(parsed)[3]?.cwd).toBe(GOLDEN_WORKSPACE);
  });

  test("rejects a config that is not repos and init", () => {
    expect(() => parseGoldenConfig([])).toThrow(GoldenError);
    expect(() => parseGoldenConfig({ note: "x" })).toThrow(/only allows repos and init/);
    expect(() => parseGoldenConfig({ repos: [] })).toThrow(/at least one repo/);
    expect(() => parseGoldenConfig({ repos: [{ url: "file:///tmp/app" }] })).toThrow(/https, http or ssh/);
    expect(() => parseGoldenConfig({ repos: [{ url: "https://user:token@example.com/app.git" }] })).toThrow(
      /must not contain credentials/,
    );
    expect(() =>
      parseGoldenConfig({
        repos: [{ url: "https://example.com/app.git" }, { url: "https://example.com/other/app.git" }],
      }),
    ).toThrow(/check out to 'app'/);
  });

  test.each([
    [{ token: "x" }, "token"],
    [{ repos: [{ url: "https://example.com/app.git", api_key: "sk" }] }, "repos.api_key"],
    [{ repos: [{ url: "https://example.com/app.git" }], ANTHROPIC_API_KEY: "sk" }, "ANTHROPIC_API_KEY"],
    [{ password: { nested: true }, repos: [{ url: "https://example.com/app.git" }] }, "password"],
  ])("rejects secret-like key %#", (value, key) => {
    const error = (() => {
      try {
        parseGoldenConfig(value);
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(GoldenError);
    expect(error).toMatchObject({ code: "invalid_config" });
    expect((error as Error).message).toContain(`key "${key}"`);
  });

  test("rejects an init command that names a model credential", () => {
    expect(() =>
      parseGoldenConfig({ repos: [{ url: "https://example.com/app.git" }], init: ["export OPENAI_API_KEY=sk"] }),
    ).toThrow(/OPENAI_API_KEY/);
  });
});

describe("snapshot names", () => {
  test("namespaces by org, owner, visibility and name inside boat's 63 characters", () => {
    const base = { orgId: ORG, ownerId: OWNER, visibility: "private" as const, name: "Web" };
    const name = boatSnapshotName(base);
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
    expect(name.startsWith(`a${ORG.replaceAll("-", "")}-`)).toBe(true);
    expect(name).toHaveLength(46);
    expect(boatSnapshotName(base)).toBe(name);
    expect(boatSnapshotName({ ...base, name: "web" })).not.toBe(name);
    expect(boatSnapshotName({ ...base, visibility: "org" })).not.toBe(name);
    expect(boatSnapshotName({ ...base, ownerId: OTHER })).not.toBe(name);
    expect(boatSnapshotName({ ...base, orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })).not.toBe(name);
  });
});

describe("golden lifecycle", () => {
  test("create checks out every repo and runs init, with no model credentials", async () => {
    const boat = provider();
    const store = memory();
    const created = await createGolden(
      { caller: admin, name: "web", visibility: "org", config: config() },
      { ...boat, store },
    );
    expect(boat.created).toEqual([
      {
        name: "web",
        ttlSeconds: GOLDEN_BUILD_TTL_SECONDS,
        idempotencyKey: `golden:${created.golden.id}`,
        labels: { [LABEL_GOLDEN_ID]: created.golden.id, [LABEL_PURPOSE]: PURPOSE_GOLDEN },
      },
    ]);
    expect(JSON.stringify(boat.created[0])).not.toContain("env");
    for (const key of MODEL_CREDENTIAL_ENV) {
      expect(boat.executed.some((call) => call.command.includes(key))).toBe(false);
    }
    expect(boat.executed.map((call) => call.command)).toEqual(
      goldenSetupCommands(config()).map((step) => step.command),
    );
    expect(created.golden.boatSnapshotId).toBeNull();
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ orgId: ORG, ownerId: ADMIN, visibility: "org", name: "web" });
  });

  test("create again reuses the build sandbox and does not start a second one", async () => {
    const boat = provider({ failCommand: "pnpm i" });
    const store = memory();
    const deps = { ...boat, store };
    await expect(
      createGolden({ caller: owner, name: "web", visibility: "private", config: config() }, deps),
    ).rejects.toMatchObject({
      code: "command_failed",
    });
    expect(boat.created).toHaveLength(1);
    const created = await createGolden({ caller: owner, name: "web", visibility: "private", config: config() }, deps);
    expect(boat.created).toHaveLength(1);
    expect(created.sandboxId).toBe("bx_1");
    expect(store.rows).toHaveLength(1);
  });

  test("a member cannot create an org golden", async () => {
    const boat = provider();
    const store = memory();
    await expect(
      createGolden({ caller: owner, name: "web", visibility: "org", config: config() }, { ...boat, store }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(boat.created).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  test("connect reports the build sandbox and its checkouts", async () => {
    const boat = provider();
    const store = memory();
    const deps = { ...boat, store };
    await createGolden({ caller: owner, name: "web", visibility: "private", config: config() }, deps);
    const connected = await connectGolden(owner, "web", deps);
    expect(connected.sandboxId).toBe("bx_1");
    expect(connected.state).toBe("ready");
    expect(connected.repos.map((repo) => repo.path)).toEqual([`${GOLDEN_WORKSPACE}/app`, `${GOLDEN_WORKSPACE}/web`]);
    expect(boat.created).toHaveLength(1);
  });

  test("snapshot polls until ready and records the namespaced name", async () => {
    const boat = provider({ snapshot: "saving" });
    const store = memory();
    const deps = { ...boat, store };
    const created = await createGolden({ caller: owner, name: "web", visibility: "private", config: config() }, deps);
    const snapped = await snapshotGolden(owner, "web", deps);
    const expected = boatSnapshotName(created.golden);
    expect(snapped).toMatchObject({ snapshotName: expected, status: "ready" });
    expect(store.rows[0]?.boatSnapshotId).toBe(expected);
    expect(boat.sleeps).toEqual([2_000]);
    expect(store.rows[0]).toMatchObject({ orgId: ORG, visibility: "private", ownerId: OWNER });
  });

  test("a failed save does not record a snapshot id", async () => {
    const boat = provider({ snapshot: "failed" });
    const store = memory();
    const deps = { ...boat, store };
    await createGolden({ caller: admin, name: "web", visibility: "org", config: config() }, deps);
    await expect(snapshotGolden(admin, "web", deps)).rejects.toMatchObject({ code: "snapshot_failed" });
    expect(store.rows[0]?.boatSnapshotId).toBeNull();
  });

  test("a save already in progress is polled instead of failing", async () => {
    const boat = provider({ conflict: true, snapshot: "ready" });
    const store = memory();
    const deps = { ...boat, store };
    await createGolden({ caller: admin, name: "web", visibility: "org", config: config() }, deps);
    const snapped = await snapshotGolden(admin, "web", deps);
    expect(snapped.status).toBe("ready");
    expect(store.rows[0]?.boatSnapshotId).toBe(snapped.snapshotName);
  });

  test("a private golden is hidden from another member and from an admin", async () => {
    const boat = provider();
    const store = memory();
    const deps = { ...boat, store };
    await createGolden({ caller: owner, name: "web", visibility: "private", config: config() }, deps);
    expect(await listGoldens(owner, deps)).toHaveLength(1);
    expect(await listGoldens(other, deps)).toEqual([]);
    expect(await listGoldens(admin, deps)).toEqual([]);
    expect(await resolveGolden(owner, "web", deps)).toMatchObject({ visibility: "private", ownerId: OWNER });
    await expect(resolveGolden(other, "web", deps)).rejects.toMatchObject({ code: "not_visible" });
    await expect(resolveGolden(admin, "web", deps)).rejects.toMatchObject({ code: "not_visible" });
    await expect(connectGolden(admin, "web", deps)).rejects.toMatchObject({ code: "not_visible" });
    await expect(snapshotGolden(other, "web", deps)).rejects.toMatchObject({ code: "not_visible" });
  });

  test("a member can launch an org golden and cannot change it", async () => {
    const boat = provider();
    const store = memory();
    const deps = { ...boat, store };
    await createGolden({ caller: admin, name: "web", visibility: "org", config: config() }, deps);
    expect(await resolveGolden(owner, "web", deps)).toMatchObject({ visibility: "org" });
    await expect(snapshotGolden(owner, "web", deps)).rejects.toMatchObject({ code: "forbidden" });
    expect(store.rows[0]?.boatSnapshotId).toBeNull();
  });

  test("the owner's private golden wins when an org golden shares its name", async () => {
    const store = memory([
      {
        id: "00000000-0000-4000-8000-000000000001",
        orgId: ORG,
        name: "web",
        visibility: "org",
        ownerId: ADMIN,
        boatSnapshotId: "aexample",
        config: config(),
        createdAt: "2026-11-08T12:00:00.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        orgId: ORG,
        name: "web",
        visibility: "private",
        ownerId: OWNER,
        boatSnapshotId: null,
        config: config(),
        createdAt: "2026-11-08T12:00:00.000Z",
      },
    ]);
    const boat = provider();
    const deps = { ...boat, store };
    expect(await resolveGolden(owner, "web", deps)).toMatchObject({ visibility: "private" });
    expect(await resolveGolden(other, "web", deps)).toMatchObject({ visibility: "org" });
    expect(await resolveGolden(admin, "web", deps)).toMatchObject({ visibility: "org" });
  });
});
