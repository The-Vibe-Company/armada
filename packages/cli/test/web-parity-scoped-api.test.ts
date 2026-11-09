import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryAuthStore } from "@armada/auth";
import { createSqlVaultStore, encryptSecret } from "@armada/core";
import { createSqlMcpRegistry } from "@armada/core/server";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { type ControlOptions, handleControlRequest } from "../../mcp-server/src/control.ts";
import { createSqlData } from "../../mcp-server/src/data.ts";
import { fakeBoat } from "../../mcp-server/test/support.ts";
import type { AuthIo } from "../src/auth-commands.ts";
import { filePreferences } from "../src/preferences.ts";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

// Owner-boundary regressions: old list lacks scoped filtering/count/offset, old CLI loses golden UUIDs
// and private-fork visibility, and bindings have no command. Existing MCP list tests only cover basic
// visibility. These use production HTTP/auth/SQL/registry paths, not parser/SQL implementation mirrors.
const me = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222";
const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  secondOrg = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  alienOrg = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const golden = "33333333-3333-4333-8333-333333333333",
  secondGolden = "44444444-4444-4444-8444-444444444444",
  modalGolden = "55555555-5555-4555-8555-555555555555";
const key = Buffer.alloc(32, 6).toString("base64");
const sid = (n: number) => `99999999-9999-4999-8999-${String(n).padStart(12, "0")}`;

async function fixture() {
  const db = await openDatabase();
  const directory = await mkdtemp(join(tmpdir(), "armada-web-parity-"));
  await applyMigrations(db);
  await db.query("insert into auth.users(id) values ($1),($2)", [me, other]);
  await db.query("insert into orgs(id,name) values ($1,'Selected'),($2,'Other'),($3,'Alien')", [
    org,
    secondOrg,
    alienOrg,
  ]);
  await db.query("insert into members(org_id,user_id,role) values ($1,$3,'admin'),($1,$4,'admin'),($2,$3,'admin')", [
    org,
    secondOrg,
    me,
    other,
  ]);
  const config = JSON.stringify({
    repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }],
    init: [],
  });
  for (const [id, name, organization, provider] of [
    [golden, "first", org, "boat"],
    [secondGolden, "second", org, "boat"],
    [modalGolden, "modal-golden", org, "modal"],
    [sid(100), "other-org", secondOrg, "boat"],
    [sid(101), "alien", alienOrg, "boat"],
  ]) {
    await db.query(
      "insert into goldens(id,org_id,name,visibility,owner_id,provider,provider_snapshot_id,config,modal_workspace,modal_environment,modal_app_id) values ($1,$2,$3,'org',$4,$5,$6,$7::jsonb,$8,$9,$10)",
      [
        id,
        organization,
        name,
        me,
        provider,
        `snapshot-${id}`,
        config,
        provider === "modal" ? "workspace" : null,
        provider === "modal" ? "main" : null,
        provider === "modal" ? "ap-fixture" : null,
      ],
    );
  }
  async function seed(
    n: number,
    status = "running",
    harness = "codex",
    owner = me,
    visibility = "org",
    source = golden,
    organization = org,
    provider = "boat",
  ) {
    await db.query(
      "insert into sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status,visibility,created_at,deleted_at,stopped_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [
        sid(n),
        provider,
        `physical-${n}`,
        source,
        organization,
        owner,
        harness,
        status,
        visibility,
        new Date(n === 32 ? "2026-11-08T00:00:00Z" : "2026-11-09T00:00:00Z"),
        status === "deleted" ? new Date("2026-11-09T00:01:00Z") : null,
        status === "stopped" ? new Date("2026-11-09T00:01:00Z") : null,
      ],
    );
  }
  for (let n = 1; n <= 30; n++) await seed(n);
  await seed(31, "ready", "claude", other);
  await seed(32, "stopped", "codex", other, "org", secondGolden);
  await seed(33, "deleted");
  await seed(34, "ready", "claude", other, "private");
  await seed(35, "ready", "claude", me, "private");
  await seed(36, "ready", "codex", me, "org", sid(100), secondOrg);
  await seed(37, "ready", "codex", other, "org", sid(101), alienOrg);
  await seed(38, "ready", "codex", me, "org", modalGolden, org, "modal");
  const authStore = createMemoryAuthStore();
  authStore.addMembership(me, { orgId: org, name: "Selected", role: "admin" });
  authStore.addMembership(me, { orgId: secondOrg, name: "Other", role: "admin" });
  authStore.addMembership(other, { orgId: org, name: "Selected", role: "member" });
  const options: ControlOptions = {
    authStore,
    store: createSqlVaultStore(db),
    encryptionKey: key,
    data: createSqlData(db),
    supabase: {
      supabaseUrl: "https://supabase.test",
      anonKey: "anon",
      fetch: async (_input, init) => {
        const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
        const subject = JSON.parse(atob(bearer.split(".")[1] ?? "")).sub;
        return subject === me || subject === other
          ? Response.json({ id: subject })
          : new Response(null, { status: 401 });
      },
    },
    providers: {
      resolve: async () => {
        throw new Error("List must not resolve or allocate a provider.");
      },
    },
  };
  const path = join(directory, "preferences.json");
  await filePreferences(path).write("https://armada.test", org);
  let out = "",
    err = "";
  const requests: { path: string; body: Record<string, unknown>; response: unknown; status: number }[] = [];
  const auth: AuthIo = {
    env: { ARMADA_URL: "https://armada.test" },
    preferences: filePreferences(path),
    session: memorySessionStore({
      accessToken: `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: me })).replace(/=+$/, "")}.sig`,
      refreshToken: "fixture",
      expiresAt: "2099-01-01T00:00:00Z",
    }),
    out: (s) => {
      out += s;
    },
    err: (s) => {
      err += s;
    },
    now: () => new Date(),
    open: () => undefined,
    fetch: async (input, init) => {
      const request = new Request(String(input), init);
      const body = (await request.clone().json()) as Record<string, unknown>;
      const response = (await handleControlRequest(request, options)) ?? new Response(null, { status: 404 });
      requests.push({
        path: new URL(request.url).pathname,
        body,
        response: await response.clone().json(),
        status: response.status,
      });
      return response;
    },
  };
  return {
    db,
    options,
    requests,
    async setActor(userId: string) {
      await auth.session.write({
        accessToken: `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: userId })).replace(/=+$/, "")}.sig`,
        refreshToken: "fixture",
        expiresAt: "2099-01-01T00:00:00Z",
      });
    },
    async cli(args: string[], readFile?: (path: string) => Promise<string>) {
      out = "";
      err = "";
      const code = await run(args, { out: auth.out, err: auth.err }, { auth, ...(readFile ? { readFile } : {}) });
      return { code, out, err };
    },
    async close() {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("CLI list matches scoped web filters, exact totals and stable pages without exposing private or foreign rows", async () => {
  const f = await fixture();
  try {
    const defaultList = await f.cli(["list", "--json"]);
    expect(defaultList.code).toBe(0);
    const defaultEnvelope = JSON.parse(defaultList.out);
    expect(Object.keys(defaultEnvelope)).toEqual(["sandboxes"]);
    expect(defaultEnvelope.sandboxes).toHaveLength(25);
    const emptyDefault = await f.cli(["list", "--json", "--golden", sid(100)]);
    expect(emptyDefault.code).toBe(0);
    expect(JSON.parse(emptyDefault.out)).toEqual({ sandboxes: [] });
    const first = await f.cli(["list", "--json", "--page-info"]);
    expect(first.code).toBe(0);
    const page = JSON.parse(first.out);
    expect(page).toMatchObject({ total: 34, page: 1, limit: 25, hasMore: true, nextPage: 2 });
    expect(page.sandboxes.map((s: { id: string }) => s.id)).toEqual(Array.from({ length: 25 }, (_, n) => sid(n + 1)));
    expect(f.requests.at(-1)).toMatchObject({ path: "/api/v1/sandbox/list", body: { org } });
    const secondResponse = await f.cli(["list", "--json", "--page-info", "--page", "2"]);
    expect(secondResponse.code).toBe(0);
    const second = JSON.parse(secondResponse.out);
    expect(second).toMatchObject({ total: 34, page: 2, limit: 25, hasMore: false, nextPage: null });
    expect(second.sandboxes.map((s: { id: string }) => s.id)).toEqual([26, 27, 28, 29, 30, 31, 35, 38, 32].map(sid));
    expect(
      JSON.parse((await f.cli(["list", "--json", "--status", "deleted"])).out).sandboxes.map(
        (s: { id: string }) => s.id,
      ),
    ).toEqual([sid(33)]);
    expect(
      JSON.parse((await f.cli(["list", "--json", "--harness", "claude"])).out).sandboxes.map(
        (s: { id: string }) => s.id,
      ),
    ).toEqual([sid(31), sid(35)]);
    expect(
      JSON.parse(
        (await f.cli(["list", "--json", "--agent", "codex", "--golden", secondGolden, "--owner", other])).out,
      ).sandboxes.map((s: { id: string }) => s.id),
    ).toEqual([sid(32)]);
    const mine = JSON.parse((await f.cli(["list", "--json", "--page-info", "--owner", "me", "--limit", "200"])).out);
    expect(mine.total).toBe(32);
    expect(mine.sandboxes).toHaveLength(32);
    const filtered = JSON.parse(
      (
        await f.cli([
          "list",
          "--json",
          "--page-info",
          "--status",
          "running",
          "--agent",
          "codex",
          "--golden",
          golden,
          "--owner",
          "me",
          "--page",
          "3",
          "--limit",
          "10",
        ])
      ).out,
    );
    expect(filtered).toMatchObject({ total: 30, page: 3, limit: 10, hasMore: false, nextPage: null });
    expect(filtered.sandboxes.map((s: { id: string }) => s.id)).toEqual(
      [21, 22, 23, 24, 25, 26, 27, 28, 29, 30].map(sid),
    );
    const beyond = JSON.parse(
      (await f.cli(["list", "--json", "--page-info", "--page", "1000000", "--limit", "1"])).out,
    );
    expect(beyond).toMatchObject({ total: 34, sandboxes: [], hasMore: false, nextPage: null });
    const foreign = JSON.parse((await f.cli(["list", "--json", "--org", secondOrg])).out);
    expect(foreign.sandboxes.map((s: { id: string }) => s.id)).toEqual([sid(36)]);
    expect(JSON.parse((await f.cli(["list", "--json", "--page-info", "--golden", sid(100)])).out)).toEqual({
      total: 0,
      page: 1,
      limit: 25,
      hasMore: false,
      nextPage: null,
      sandboxes: [],
    });
    const before = f.requests.length;
    for (const flags of [
      ["--status", "unknown"],
      ["--harness", "wrong"],
      ["--golden", "first"],
      ["--owner", "someone"],
      ["--limit", "0"],
      ["--limit", "201"],
      ["--page", "0"],
      ["--page", "1000001"],
      ["--page", "1.5"],
      ["--agent", "claude", "--harness", "codex"],
      ["--status", "running", "--status", "failed"],
      ["--model", "not-a-filter"],
      ["--", "--status", "deleted"],
    ])
      expect((await f.cli(["list", "--json", ...flags])).code).toBe(2);
    expect(f.requests).toHaveLength(before);
    const modal =
      page.sandboxes.find((s: { id: string }) => s.id === sid(38)) ??
      second.sandboxes.find((s: { id: string }) => s.id === sid(38));
    expect(modal).toMatchObject({ provider: "modal", providerSandboxId: "physical-38", boatId: null });
    await f.setActor(other);
    const otherOwner = JSON.parse((await f.cli(["list", "--json", "--owner", "me", "--agent", "claude"])).out);
    expect(otherOwner.sandboxes.map((s: { id: string }) => s.id)).toEqual([sid(31), sid(34)]);
    await f.setActor(me);
    await f.db.query("delete from members where org_id=$1 and user_id=$2", [org, me]);
    const revoked = await f.cli(["list", "--json", "--page-info"]);
    expect(revoked.code).not.toBe(0); // selected-org guard rechecks membership before the SQL read
    expect(revoked.out).toBe("");
    expect((await f.cli(["org", "use", "none"])).code).toBe(0);
    const stalePrincipal = JSON.parse((await f.cli(["list", "--json", "--page-info"])).out);
    expect(stalePrincipal.total).toBe(1);
    expect(stalePrincipal.sandboxes.map((s: { id: string }) => s.id)).toEqual([sid(36)]);
  } finally {
    await f.close();
  }
});

test("CLI golden list preserves discoverable UUIDs and provider-neutral metadata", async () => {
  const f = await fixture();
  try {
    const goldens = JSON.parse((await f.cli(["golden", "list", "--json"])).out);
    expect(goldens.find((g: { id: string }) => g.id === golden)).toMatchObject({
      id: golden,
      orgId: org,
      name: "first",
      provider: "boat",
    });
    expect(goldens.find((g: { id: string }) => g.id === modalGolden)).toMatchObject({
      id: modalGolden,
      orgId: org,
      provider: "modal",
      modal: { workspace: "workspace", environment: "main", appId: "ap-fixture" },
    });
  } finally {
    await f.close();
  }
});

test("CLI sandbox-connections reads authorized persisted bindings without hidden mutations", async () => {
  const f = await fixture();
  try {
    const registry = createSqlMcpRegistry(f.db, key);
    f.options.mcp = { registry };
    const connection = await registry.save(me, org, {
      name: "Bound public service",
      scope: "personal",
      transport: "http",
      url: "https://example.com/mcp",
      authType: "none",
    });
    await f.db.query("update mcp_grants set status='connected' where connection_id=$1", [connection.id]);
    await f.db.query(
      "insert into mcp_bindings(sandbox_id,connection_id,grant_id) select $1,connection_id,id from mcp_grants where connection_id=$2",
      [sid(35), connection.id],
    );
    const grantMetadata = async () =>
      (
        await f.db.query(
          "select g.generation,g.version,g.status,g.revoked_at,c.disabled from mcp_grants g join mcp_connections c on c.id=g.connection_id where c.id=$1",
          [connection.id],
        )
      ).rows;
    const beforeRead = await grantMetadata();
    const bindings = await f.cli(["mcp", "sandbox-connections", sid(35), "--json"]);
    expect(bindings.code).toBe(0);
    expect(JSON.parse(bindings.out).connections).toEqual([
      expect.objectContaining({ id: connection.id, name: "Bound public service", scope: "personal", orgId: org }),
    ]);
    expect(f.requests.at(-1)).toMatchObject({
      path: "/api/v1/mcp/sandbox-connections",
      body: { org, sandboxId: sid(35) },
    });
    const adminRead = await f.cli(["mcp", "sandbox-connections", sid(34), "--json"]);
    expect(adminRead.code).toBe(0);
    expect(JSON.parse(adminRead.out).connections).toEqual([]);
    expect((await f.cli(["mcp", "sandbox-connections", sid(35), "--org", secondOrg, "--json"])).code).toBe(1);
    await f.db.query("update members set role='member' where org_id=$1 and user_id=$2", [org, other]);
    await f.setActor(other);
    expect((await f.cli(["mcp", "sandbox-connections", sid(35), "--json"])).code).toBe(1);
    expect((await f.db.query("select sandbox_id from mcp_bindings")).rows).toHaveLength(1);
    expect(await grantMetadata()).toEqual(beforeRead);
  } finally {
    await f.close();
  }
});

test("CLI launch JSON and text report persisted private sandbox visibility, not its org golden", async () => {
  const f = await fixture();
  try {
    const boat = fakeBoat();
    f.options.providerFor = boat.providerFor;
    delete f.options.providers;
    await f.db.query("update orgs set boat_api_key_enc=$1 where id=$2", [
      await encryptSecret("fixture-boat-key", key),
      org,
    ]);
    await f.db.query("insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'openai',$2)", [
      me,
      await encryptSecret("fixture-model-key", key),
    ]);
    const launched = await f.cli(["launch", "first", "--agent", "codex", "--visibility", "private", "--json"]);
    expect(launched.code).toBe(0);
    const dto = JSON.parse(launched.out);
    expect(dto).toMatchObject({ visibility: "private", golden: "first", provider: "boat" });
    expect(
      (
        await f.db.query<{ visibility: string; source_golden_visibility: string }>(
          "select visibility,source_golden_visibility from sandboxes where id=$1",
          [dto.id],
        )
      ).rows[0],
    ).toEqual({ visibility: "private", source_golden_visibility: "org" });
    const text = await f.cli(["launch", "first", "--agent", "codex", "--visibility", "private"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("(private)");
    expect(text.out).not.toContain("first (org)");
  } finally {
    await f.close();
  }
});

test("CLI catalog service create and metadata actions use the API and preserve UUID identity", async () => {
  const f = await fixture();
  f.options.mcp = { registry: createSqlMcpRegistry(f.db, key) };
  try {
    const catalog = await f.cli(["mcp", "catalog", "--json"]);
    expect(catalog.code).toBe(0);
    expect(JSON.parse(catalog.out).services.find((s: { id: string }) => s.id === "slack").availability).toBe(
      "setup_required",
    );
    const added = await f.cli(["mcp", "add", "Work", "--service", "linear", "--json"]);
    expect(added.code).toBe(0);
    const id = JSON.parse(added.out).connection.id;
    const renamed = await f.cli(["mcp", "rename", id, "Second account", "--json"]);
    expect(JSON.parse(renamed.out).connection).toMatchObject({ id, name: "Second account", catalogId: "linear" });
    const defaults = await f.cli(["mcp", "default", id, "on", "--json"]);
    expect(JSON.parse(defaults.out).connection).toMatchObject({ id, defaultForLaunch: true });
  } finally {
    await f.close();
  }
});

test("CLI retirement dry-run and reconcile reach scoped authorized API without provider mutations", async () => {
  const f = await fixture();
  try {
    const { GoldenSnapshotRetirements } = await import("@armada/core/server");
    let mutations = 0;
    f.options.goldenRetirements = new GoldenSnapshotRetirements({
      sql: f.db,
      encryptionKey: key,
      provider: async () => ({
        ...fakeBoat().provider,
        id: "boat",
        backendIdentity: async () => ({ id: "account" }),
        managementIdentity: async () => ({ scope: "org", ownerId: org }),
        deleteSnapshot: async () => {
          mutations++;
        },
      }),
    });
    for (const action of ["dry-run", "reconcile"]) {
      const result = await f.cli(
        [
          "golden",
          "retirement",
          action,
          golden,
          "--limit",
          "2",
          "--json",
          ...(action === "reconcile" ? ["--file", "review.json"] : []),
        ],
        async () => JSON.stringify({ results: [{ receipt: "a".repeat(64) }] }),
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out)).toEqual({ results: [{ outcome: "deferred", reason: "binding_unavailable" }] });
      expect(f.requests.at(-1)).toMatchObject({
        path: "/api/v1/golden/retirement/" + action,
        body: { id: golden, org, limit: 2 },
        status: 200,
      });
    }
    expect((await f.cli(["golden", "retirement", "dry-run", golden, "--org", secondOrg, "--json"])).code).toBe(1);
    expect((await f.cli(["golden", "retirement", "dry-run", golden, "--limit", "51", "--json"])).code).toBe(1);
    await f.db.query("update members set role='member' where org_id=$1 and user_id=$2", [org, me]);
    expect(
      (
        await f.cli(["golden", "retirement", "reconcile", golden, "--json", "--file", "review.json"], async () =>
          JSON.stringify({ results: [{ receipt: "a".repeat(64) }] }),
        )
      ).code,
    ).toBe(1);
    expect((await f.db.query("select * from golden_snapshot_retirements")).rows).toEqual([]);
    expect(mutations).toBe(0);
  } finally {
    await f.close();
  }
});
