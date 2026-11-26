import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryAuthStore } from "@armada/auth";
import { encryptSecret } from "@armada/core";
import { createSqlVaultStore } from "@armada/core/server";
import { type ControlOptions, handleControlRequest } from "../../mcp-server/src/control.ts";
import { createSqlData } from "../../mcp-server/src/data.ts";
import { withBoatManagementIdentity } from "../../mcp-server/src/observed-boat.ts";
import { modalAdmissionFixture } from "../../mcp-server/test/modal-admission.fixture.ts";
import { rowOnlyConnection } from "../../mcp-server/test/row-only-database.ts";
import { bunLikeSql, fakeBoat, ENCRYPTION_KEY as key } from "../../mcp-server/test/support.ts";
import type { AuthIo } from "../src/auth-commands.ts";
import { filePreferences } from "../src/preferences.ts";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const me = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222";
const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  secondOrg = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  alienOrg = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const golden = "33333333-3333-4333-8333-333333333333",
  secondGolden = "44444444-4444-4444-8444-444444444444",
  modalGolden = "55555555-5555-4555-8555-555555555555";
const sid = (n: number) => `99999999-9999-4999-8999-${String(n).padStart(12, "0")}`;

const database = rowOnlyConnection();

async function fixture() {
  const db = await database();
  const directory = await mkdtemp(join(tmpdir(), "armada-web-parity-"));
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
      armadaUrl: "https://armada.test",
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
    seed,
    clearSelection: () => filePreferences(path).write("https://armada.test", undefined),
    async setActor(userId: string) {
      await auth.session.write({
        armadaUrl: "https://armada.test",
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
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("CLI list matches scoped web filters, exact totals and stable pages with safe metadata for legacy private rows but no foreign rows", async () => {
  const f = await fixture();
  try {
    for (let n = 1; n <= 30; n++) await f.seed(n);
    await f.seed(31, "ready", "claude", other);
    await f.seed(32, "stopped", "codex", other, "org", secondGolden);
    await f.seed(33, "deleted");
    await f.seed(34, "ready", "claude", other, "private");
    await f.seed(35, "ready", "claude", me, "private");
    await f.seed(36, "ready", "codex", me, "org", sid(100), secondOrg);
    await f.seed(37, "ready", "codex", other, "org", sid(101), alienOrg);
    await f.seed(38, "ready", "codex", me, "org", modalGolden, org, "modal");
    const defaultList = await f.cli(["ls", "--json"]);
    expect(defaultList.code).toBe(0);
    const defaultEnvelope = JSON.parse(defaultList.out);
    expect(Object.keys(defaultEnvelope)).toEqual(["sandboxes"]);
    expect(defaultEnvelope.sandboxes).toHaveLength(25);
    const emptyDefault = await f.cli(["ls", "--json", "--golden", sid(100)]);
    expect(emptyDefault.code).toBe(0);
    expect(JSON.parse(emptyDefault.out)).toEqual({ sandboxes: [] });
    const first = await f.cli(["ls", "--json", "--page-info"]);
    expect(first.code).toBe(0);
    const page = JSON.parse(first.out);
    expect(page).toMatchObject({ total: 35, page: 1, limit: 25, hasMore: true, nextPage: 2 });
    expect(page.sandboxes.map((s: { id: string }) => s.id)).toEqual(Array.from({ length: 25 }, (_, n) => sid(n + 1)));
    expect(f.requests.at(-1)).toMatchObject({ path: "/api/v1/sandbox/list", body: { org } });
    const secondResponse = await f.cli(["ls", "--json", "--page-info", "--page", "2"]);
    expect(secondResponse.code).toBe(0);
    const second = JSON.parse(secondResponse.out);
    expect(second).toMatchObject({ total: 35, page: 2, limit: 25, hasMore: false, nextPage: null });
    expect(second.sandboxes.map((s: { id: string }) => s.id)).toEqual(
      [26, 27, 28, 29, 30, 31, 34, 35, 38, 32].map(sid),
    );
    expect(
      JSON.parse((await f.cli(["ls", "--json", "--status", "deleted"])).out).sandboxes.map((s: { id: string }) => s.id),
    ).toEqual([sid(33)]);
    expect(
      JSON.parse((await f.cli(["ls", "--json", "--harness", "claude"])).out).sandboxes.map((s: { id: string }) => s.id),
    ).toEqual([sid(31), sid(34), sid(35)]);
    expect(
      JSON.parse(
        (await f.cli(["ls", "--json", "--agent", "codex", "--golden", secondGolden, "--owner", other])).out,
      ).sandboxes.map((s: { id: string }) => s.id),
    ).toEqual([sid(32)]);
    const mine = JSON.parse((await f.cli(["ls", "--json", "--page-info", "--owner", "me", "--limit", "200"])).out);
    expect(mine.total).toBe(32);
    expect(mine.sandboxes).toHaveLength(32);
    const filtered = JSON.parse(
      (
        await f.cli([
          "ls",
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
    const beyond = JSON.parse((await f.cli(["ls", "--json", "--page-info", "--page", "1000000", "--limit", "1"])).out);
    expect(beyond).toMatchObject({ total: 35, sandboxes: [], hasMore: false, nextPage: null });
    const foreign = JSON.parse((await f.cli(["ls", "--json", "--org", secondOrg])).out);
    expect(foreign.sandboxes.map((s: { id: string }) => s.id)).toEqual([sid(36)]);
    expect(JSON.parse((await f.cli(["ls", "--json", "--page-info", "--golden", sid(100)])).out)).toEqual({
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
      expect((await f.cli(["ls", "--json", ...flags])).code).toBe(2);
    expect(f.requests).toHaveLength(before);
    const modal =
      page.sandboxes.find((s: { id: string }) => s.id === sid(38)) ??
      second.sandboxes.find((s: { id: string }) => s.id === sid(38));
    expect(modal).toMatchObject({ provider: "modal", providerSandboxId: "physical-38" });
    await f.setActor(other);
    const otherOwner = JSON.parse((await f.cli(["ls", "--json", "--owner", "me", "--agent", "claude"])).out);
    expect(otherOwner.sandboxes.map((s: { id: string }) => s.id)).toEqual([sid(31), sid(34)]);
    await f.setActor(me);
    await f.db.query("delete from members where org_id=$1 and user_id=$2", [org, me]);
    const revoked = await f.cli(["ls", "--json", "--page-info"]);
    expect(revoked.code).not.toBe(0);
    expect(revoked.out).toBe("");
    await f.clearSelection();
    const stalePrincipal = JSON.parse((await f.cli(["ls", "--json", "--page-info"])).out);
    expect(stalePrincipal.total).toBe(1);
    expect(stalePrincipal.sandboxes.map((s: { id: string }) => s.id)).toEqual([sid(36)]);
  } finally {
    await f.close();
  }
});

test("CLI golden list preserves discoverable UUIDs and provider-neutral metadata", async () => {
  const f = await fixture();
  try {
    const goldens = JSON.parse((await f.cli(["snapshot", "ls", "--json"])).out);
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

test("CLI retires launch visibility without changing source golden authority", async () => {
  const f = await fixture();
  try {
    const boat = fakeBoat();
    f.options.admitModalLaunch = await modalAdmissionFixture(
      bunLikeSql(f.db),
      key,
      f.options.store,
      undefined,
      withBoatManagementIdentity(boat.provider, "org", org),
    );
    await f.db.query("update orgs set boat_api_key_enc=$1 where id=$2", [
      await encryptSecret("fixture-boat-key", key),
      org,
    ]);
    await f.db.query("insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'openai',$2)", [
      me,
      await encryptSecret("fixture-model-key", key),
    ]);
    const rejected = await f.cli([
      "new",
      "first",
      "--provider",
      "boat",
      "--agent",
      "codex",
      "--visibility",
      "private",
      "--json",
    ]);
    expect(rejected.code).toBe(2);
    const launched = await f.cli(["new", "first", "--provider", "boat", "--agent", "codex", "--json"]);
    expect(launched.code).toBe(0);
    const dto = JSON.parse(launched.out);
    expect(dto.sandbox).toMatchObject({ status: "starting" });
    expect(dto).not.toHaveProperty("visibility");
    expect(
      (
        await f.db.query<{ visibility: string; source_golden_visibility: string }>(
          "select visibility,source_golden_visibility from sandboxes where id=$1",
          [dto.sandbox.id],
        )
      ).rows[0],
    ).toEqual({ visibility: "org", source_golden_visibility: "org" });
    const text = await f.cli(["new", "first", "--provider", "boat", "--agent", "codex"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("Status: starting");
    expect(text.out).not.toContain("(private)");
    expect(text.out).not.toContain("first (org)");
  } finally {
    await f.close();
  }
});
