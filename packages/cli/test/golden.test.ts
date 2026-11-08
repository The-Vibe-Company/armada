import { describe, expect, test } from "bun:test";
import type { CreateGoldenRequest, GoldenRow, GoldenStore, NewGolden, Provider, SandboxInfo } from "@armada/core";
import { GoldenError } from "@armada/core";
import { parseRepoArg } from "../src/golden-command.ts";
import { run } from "../src/run.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const ADMIN = "44444444-4444-4444-8444-444444444444";
const OWNER = "22222222-2222-4222-8222-222222222222";

const env = { ARMADA_ORG_ID: ORG, ARMADA_USER_ID: ADMIN, ARMADA_ROLE: "admin" };

function session() {
  const store = memory();
  const boat = fake();
  return {
    store,
    boat,
    run(
      argv: string[],
      extra?: { env?: Record<string, string | undefined>; readText?: (path: string) => Promise<string> },
    ) {
      let out = "";
      let err = "";
      return run(
        argv,
        { out: (text) => (out += text), err: (text) => (err += text) },
        {
          env: extra?.env ?? env,
          store,
          provider: boat.provider,
          sleep: async () => {},
          ...(extra?.readText ? { readText: extra.readText } : {}),
        },
      ).then((exit) => ({ exit, out, err }));
    },
  };
}

function memory(): GoldenStore & { rows: GoldenRow[] } {
  const rows: GoldenRow[] = [];
  return {
    rows,
    async listOrg(orgId) {
      return rows.filter((row) => row.orgId === orgId);
    },
    async insert(row: NewGolden) {
      const stored: GoldenRow = { ...row, createdAt: "2026-11-08T12:00:00.000Z" };
      rows.push(stored);
      return stored;
    },
    async updateConfig(id, config) {
      const row = rows.find((item) => item.id === id);
      if (!row) throw new GoldenError("not_found", "missing");
      row.config = config;
    },
    async setSnapshot(id, boatSnapshotId) {
      const row = rows.find((item) => item.id === id);
      if (!row) throw new GoldenError("not_found", "missing");
      row.boatSnapshotId = boatSnapshotId;
    },
  };
}

function fake() {
  const created: CreateGoldenRequest[] = [];
  const sandboxes: SandboxInfo[] = [];
  const provider = {
    async createGolden(request: CreateGoldenRequest) {
      created.push(request);
      const info: SandboxInfo = {
        id: "bx_1",
        name: request.name ?? "golden",
        state: "ready",
        providerState: "ready",
        labels: request.labels ?? {},
        createdAt: new Date("2026-11-08T12:00:00Z"),
      };
      sandboxes.push(info);
      return info;
    },
    async get(id: string) {
      const found = sandboxes.find((item) => item.id === id);
      if (!found) throw new Error("missing");
      return found;
    },
    async list(request?: { labels?: Record<string, string> }) {
      const labels = request?.labels ?? {};
      return {
        items: sandboxes.filter((item) => Object.entries(labels).every(([key, value]) => item.labels[key] === value)),
        cursor: null,
      };
    },
    async exec() {
      return { detached: false as const, exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
    },
    async snapshot(request: { name: string }) {
      return { name: request.name, status: "ready" as const };
    },
    async getSnapshot(name: string) {
      return { name, status: "ready" as const };
    },
  };
  return { provider: provider as unknown as Provider, created };
}

describe("golden cli", () => {
  test("create, connect, snapshot and list a multi-repo golden", async () => {
    const cli = session();
    const created = await cli.run([
      "golden",
      "create",
      "web",
      "--private",
      "--repo",
      "https://example.com/app.git@main",
      "--repo",
      "git@github.com:example/web.git",
      "--init",
      "pnpm i",
      "--init",
      "pnpm test",
    ]);
    expect(created.exit).toBe(0);
    expect(created.out).toContain("created web private\n");
    expect(created.out).toContain("sandbox bx_1\n");
    expect(cli.boat.created[0]).toMatchObject({ name: "web", labels: { "armada/purpose": "golden" } });
    expect(cli.boat.created[0]).not.toHaveProperty("env");
    expect(cli.store.rows[0]?.config).toEqual({
      repos: [{ url: "https://example.com/app.git", branch: "main" }, { url: "git@github.com:example/web.git" }],
      init: ["pnpm i", "pnpm test"],
    });

    const connected = await cli.run(["golden", "connect", "web"]);
    expect(connected.exit).toBe(0);
    expect(connected.out).toContain("sandbox bx_1\n");
    expect(connected.out).toContain("repo app main ");
    expect(connected.out).toContain("shell boat ssh bx_1\n");

    const snapped = await cli.run(["golden", "snapshot", "web"]);
    expect(snapped.exit).toBe(0);
    expect(snapped.out).toContain("status ready\n");
    expect(cli.store.rows[0]?.boatSnapshotId).toBe(snapped.out.match(/boat-snapshot (\S+)/)?.[1]);

    const listed = await cli.run(["golden", "list"]);
    expect(listed.out).toContain(`web private saved ${ADMIN}`);
  });

  test("a config file is the repos and init, and a secret key is refused", async () => {
    const cli = session();
    const created = await cli.run(["golden", "create", "web", "--config", "golden.json"], {
      readText: async () =>
        JSON.stringify({
          repos: [{ url: "https://example.com/app.git", branch: "main" }],
          init: ["pnpm i"],
        }),
    });
    expect(created.exit).toBe(0);
    expect(cli.store.rows[0]?.config.repos[0]).toEqual({ url: "https://example.com/app.git", branch: "main" });

    const refused = await cli.run(["golden", "create", "other", "--config", "golden.json"], {
      readText: async () => JSON.stringify({ repos: [{ url: "https://example.com/app.git" }], token: "secret" }),
    });
    expect(refused.exit).toBe(1);
    expect(refused.err).toContain('key "token"');
    expect(cli.store.rows).toHaveLength(1);
  });

  test("usage errors do not run a command", async () => {
    const cli = session();
    const both = await cli.run([
      "golden",
      "create",
      "web",
      "--config",
      "a.json",
      "--repo",
      "https://example.com/app.git",
    ]);
    expect(both.exit).toBe(2);
    expect(both.err).toContain("either --config or --repo");
    expect(cli.boat.created).toHaveLength(0);

    const missing = await cli.run(["golden", "connect"]);
    expect(missing.exit).toBe(2);
    expect(missing.err).toContain("needs a name");
  });

  test("an admin does not see another member's private golden", async () => {
    const cli = session();
    cli.store.rows.push({
      id: "55555555-5555-4555-8555-555555555555",
      orgId: ORG,
      name: "secret",
      visibility: "private",
      ownerId: OWNER,
      boatSnapshotId: null,
      config: { repos: [{ url: "https://example.com/app.git" }], init: [] },
      createdAt: "2026-11-08T12:00:00.000Z",
    });
    const listed = await cli.run(["golden", "list"]);
    expect(listed.exit).toBe(0);
    expect(listed.out).toBe("no goldens\n");
    const launch = await cli.run(["golden", "connect", "secret"]);
    expect(launch.exit).toBe(1);
    expect(launch.err).toContain("not available");
  });

  test("a missing database does not print the boat key", async () => {
    let out = "";
    let err = "";
    const code = await run(
      ["golden", "list"],
      { out: (text) => (out += text), err: (text) => (err += text) },
      {
        env: { ...env, BOAT_API_KEY: "boat_secret_value" },
      },
    );
    expect(code).toBe(1);
    expect(err).toContain("ARMADA_DATABASE_URL");
    expect(err).not.toContain("boat_secret_value");
    expect(out).toBe("");
  });

  test("parseRepoArg keeps a git@ URL and takes a branch suffix", () => {
    expect(parseRepoArg("https://example.com/app.git@main")).toEqual({
      url: "https://example.com/app.git",
      branch: "main",
    });
    expect(parseRepoArg("git@github.com:example/web.git")).toEqual({ url: "git@github.com:example/web.git" });
    expect(parseRepoArg("git@github.com:example/web.git@develop")).toEqual({
      url: "git@github.com:example/web.git",
      branch: "develop",
    });
  });
});
