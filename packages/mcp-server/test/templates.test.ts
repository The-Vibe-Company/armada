import { expect, spyOn, test } from "bun:test";
import { createSqlAuthStore } from "@armada/auth";
import {
  createApplicationVault,
  createSkillDefaultsService,
  createSqlMcpLaunchPort,
  createSqlMcpRegistry,
  createSqlVaultStore,
  createTemplateService,
  encryptSecret,
  goldenForLaunch,
  type LaunchTemplate,
  type Sql,
  type TemplateRuntime,
} from "@armada/core/server";
import { resetMigratedDatabaseRows } from "../../../scripts/test-support/migrated-database.ts";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { enrolledLaunchPolicy } from "./launch-runtime.fixture.ts";
import { useMigratedDatabase } from "./migrated-database.ts";
import { modalAdmissionFixture } from "./modal-admission.fixture.ts";
import { publishedResponse } from "./published-response.ts";
import { ENCRYPTION_KEY, fakeBoat, seedDatabase } from "./support.ts";

const getDatabase = useMigratedDatabase();

// Primary contract owner: real migrations + service-role authorization/admission, fake physical provider only.
async function fixture() {
  const database = getDatabase();
  await resetMigratedDatabaseRows(
    database,
    `
    reset role;
    reset all;
    set search_path=public;
    delete from jobs;
    delete from template_launch_requests;
    alter table launch_template_revisions disable trigger immutable_template_revision;
    delete from launch_template_revisions;
    alter table launch_template_revisions enable trigger immutable_template_revision;
    delete from launch_templates;
    delete from ordinary_launch_receipts;
    delete from sandboxes;
    delete from golden_operation_fences;
    delete from mcp_connections;
    delete from readable_variables;
    delete from application_secrets;
    delete from credentials;
    alter table members disable trigger members_guard;
    delete from members;
    alter table members enable trigger members_guard;
    delete from orgs;
    delete from auth.users;
    delete from mcp_invalidations;
  `,
  );
  const { db, people, sharedGoldenId: goldenId, openaiCredentialId: credential } = await seedDatabase(database);
  const variableId = crypto.randomUUID();
  await db.query(
    `insert into public.readable_variables(id,org_id,owner_id,scope,name,value)
     values($1,$2,$3,'personal','APP_REGION',$4)`,
    [variableId, people.org, people.owner, "europe\n$(not-a-command)"],
  );
  const queries: string[] = [];
  const sql: Sql = {
    query: (s, p) => {
      queries.push(s);
      return db.query(s, p);
    },
    transaction: (work) => db.transaction((tx) => work(tx)),
  };
  const service = createTemplateService(sql, ENCRYPTION_KEY);
  const vault = createApplicationVault(sql, undefined);
  const actor = (userId = people.owner) => ({
    userId,
    orgs: [{ orgId: people.org, role: userId === people.admin ? ("admin" as const) : ("member" as const) }],
    via: "supabase" as const,
  });
  const definition = {
    goldenId,
    provider: "boat",
    harness: "codex",
    model: "gpt-5.4",
    reasoningEffort: "high",
    variables: [{ key: "APP_REGION", variableId, version: 1 }],
    connections: [],
  };
  const boat = fakeBoat();
  const configured: unknown[] = [];
  const provider = {
    ...boat.provider,
    configureReadableVariables: async (r: unknown) => {
      configured.push(r);
    },
  };
  const data = createSqlData(sql)(actor());
  const admit = await modalAdmissionFixture(sql, ENCRYPTION_KEY, createSqlVaultStore(sql), undefined, {
    ...provider,
    managementIdentity: async () => ({ scope: "org", ownerId: people.org }),
  });
  const runtime: TemplateRuntime = {
    stores: {
      goldens: data.goldens,
      sandboxes: data.sandboxes,
      connections: createSqlMcpLaunchPort(sql, createSqlMcpRegistry(sql, ENCRYPTION_KEY)),
      credentials: {
        resolve: async () => ({
          binding: { credentialId: credential, credentialVersion: 1 },
          env: { OPENAI_API_KEY: "test-model-only" },
          secrets: ["test-model-only"],
          codexAuthJson: false,
        }),
      },
    },
    admitModal: async (actor, golden, request, pin) => admit(actor, golden, data, request, { pin }),
    options: {
      runtime: enrolledLaunchPolicy(sql),
    },
  };
  const create = async (user = people.owner, scope = "personal", def: unknown = definition) =>
    await service.command(actor(user), "create", {
      org: people.org,
      name: crypto.randomUUID(),
      scope,
      definition: def,
    });
  const launch = async (templateId: string, key = "request-1", extra: Record<string, unknown> = {}) =>
    service.command(
      actor(),
      "launch",
      { org: people.org, id: templateId, requestKey: key, prompt: "Inspect configuration", ...extra },
      runtime,
    );
  return {
    close: async () => {
      await db.exec("reset role; reset all; set search_path=public");
    },
    queries,
    db,
    sql,
    people,
    actor,
    service,
    vault,
    definition,
    variableId,
    credential,
    goldenId,
    boat,
    provider,
    configured,
    runtime,
    create,
    launch,
  };
}

test("immutable revisions enforce personal/org ownership, optimistic publication, tombstones and JWT grants", async () => {
  // Session identity is restored before the next fixture is seeded.
  const f = await fixture();
  try {
    const created = await f.create();
    const t = created.item as LaunchTemplate;
    for (const user of [f.people.member, f.people.admin]) {
      expect((await f.service.command(f.actor(user), "list", { org: f.people.org })).items).toEqual([]);
      await expect(f.service.command(f.actor(user), "get", { org: f.people.org, id: t.id })).rejects.toMatchObject({
        code: "not_found",
      });
    }
    await expect(f.create(f.people.owner, "org")).rejects.toMatchObject({ code: "forbidden" });
    await expect(f.create(f.people.admin, "org")).rejects.toMatchObject({ code: "conflict" }); // Author's personal variable is never shareable.
    const shared = await f.create(f.people.admin, "org", { ...f.definition, variables: [] });
    const sharedId = (shared.item as LaunchTemplate).id;
    await expect(
      f.service.command(f.actor(), "delete", { org: f.people.org, id: sharedId, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const published = await f.service.command(f.actor(), "publish", {
      org: f.people.org,
      id: t.id,
      expectedRevision: 1,
      definition: { ...f.definition, model: "gpt-5.4-mini" },
    });
    expect((published.item as LaunchTemplate).currentRevision).toBe(2);
    const historical = await f.service.command(f.actor(), "get", { org: f.people.org, id: t.id, revision: 1 });
    expect((historical.revision as { definition: { model: string } }).definition.model).toBe("gpt-5.4");
    await expect(
      f.service.command(f.actor(), "publish", {
        org: f.people.org,
        id: t.id,
        expectedRevision: 1,
        definition: f.definition,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      f.db.query("update launch_template_revisions set digest=repeat('a',64) where template_id=$1", [t.id]),
    ).rejects.toThrow("immutable");
    await f.db.exec("set role anon");
    await expect(f.db.query("select * from launch_templates")).rejects.toThrow("permission denied");
    await f.db.exec("reset role");
    await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [f.people.member]);
    await f.db.exec("set role authenticated");
    expect((await f.db.query<{ id: string }>("select id from launch_templates")).rows.map((r) => r.id)).toEqual([
      sharedId,
    ]);
    expect((await f.db.query("select * from launch_template_revisions")).rows).toHaveLength(1);
    await expect(f.db.query("update launch_templates set name='bypass'")).rejects.toThrow("permission denied");
    await f.db.exec("reset role");
    await f.service.command(f.actor(), "delete", { org: f.people.org, id: t.id, expectedRevision: 2 });
    await expect(f.service.command(f.actor(), "get", { org: f.people.org, id: t.id })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(
      (await f.db.query("select * from launch_template_revisions where template_id=$1", [t.id])).rows,
    ).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("template launch records externalRef on the sandbox and keys it into the request fingerprint", async () => {
  const f = await fixture();
  try {
    const t = (await f.create()).item as LaunchTemplate;
    await expect(f.launch(t.id, "request-1", { externalRef: "" })).rejects.toMatchObject({ code: "invalid" });
    const result = await f.launch(t.id, "request-1", { externalRef: "tender:42" });
    expect(result).toMatchObject({ state: "succeeded", externalRef: "tender:42" });
    expect((await f.db.query("select external_ref from sandboxes where id=$1", [result.id])).rows).toEqual([
      { external_ref: "tender:42" },
    ]);
    await expect(f.launch(t.id, "request-1", { externalRef: "tender:43" })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(f.boat.forks).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("changed variable, removed membership and invalid authority overrides fail before fork", async () => {
  const f = await fixture();
  try {
    const t = (await f.create()).item as LaunchTemplate;
    for (const extra of [{ env: { X: "y" } }, { connections: [] }, { model: "other" }, { secretBindings: [] }])
      await expect(f.launch(t.id, crypto.randomUUID(), extra)).rejects.toMatchObject({ code: "invalid" });
    await f.vault.command(f.actor(), "variable", "update", {
      org: f.people.org,
      id: f.variableId,
      expectedVersion: 1,
      value: "changed",
    });
    await expect(f.launch(t.id)).rejects.toMatchObject({ code: "conflict" });
    expect(f.boat.forks).toHaveLength(0);
    await f.db.query("delete from members where org_id=$1 and user_id=$2", [f.people.org, f.people.owner]);
    await expect(f.launch(t.id)).rejects.toMatchObject({ code: "forbidden" });
    expect(f.boat.forks).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("Template REST validates authoring and launch requests", async () => {
  const f = await fixture();
  try {
    const store = createSqlVaultStore(f.sql);
    const options: ControlOptions = {
      launch: {
        boatRuntimeDefault: {
          policy: enrolledLaunchPolicy(f.sql),
          provider: async () => f.provider,
          credentials: launchCredentials(store, ENCRYPTION_KEY),
          connections: { async validate() {}, async bind() {} },
        },
      },
      templates: f.service,
      admitModalLaunch: (actor, golden, _stores, request, admission) =>
        f.runtime.admitModal!(actor, golden, request, admission!.pin!),
      store,
      authStore: createSqlAuthStore(f.sql),
      encryptionKey: ENCRYPTION_KEY,
      data: createSqlData(f.sql),
      providers: { resolve: async () => f.provider },
      supabase: {
        supabaseUrl: "https://supabase.test",
        anonKey: "synthetic-anon",
        fetch: async () => Response.json({ id: f.people.owner }),
      },
    };
    const api = async (op: string, body: unknown, bearer = true, query = "") =>
      handleControlRequest(
        new Request(`https://armada.test/api/v1/templates/${op}${query}`, {
          method: "POST",
          headers: bearer ? { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig" } : {},
          body: JSON.stringify(body),
        }),
        options,
      );
    expect((await api("list", { org: f.people.org }, false))?.status).toBe(401);
    expect((await api("list", { org: f.people.org }, true, "?ignored=1"))?.status).toBe(400);
    expect(
      (
        await api("create", {
          org: f.people.org,
          name: "bad",
          scope: "personal",
          definition: { ...f.definition, secretBindings: [] },
        })
      )?.status,
    ).toBe(400);
    const created = await api("create", {
      org: f.people.org,
      name: "transport",
      scope: "personal",
      definition: f.definition,
    });
    expect(created?.status).toBe(200);
    expect(created?.headers.get("cache-control")).toBe("no-store");
    const saved = (await created!.json()) as { item: LaunchTemplate };
    // A visible Claude template without a compatible account is an admission refusal, never a missing template.
    await f.db.query("delete from credentials where kind in ('anthropic','claude_oauth')");
    const claude = (
      await f.create(f.people.owner, "personal", {
        ...f.definition,
        harness: "claude",
        model: "claude-opus-5-5",
        reasoningEffort: "medium",
      })
    ).item as LaunchTemplate;
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const [reason, accounts, status] of [
        ["model_account_unavailable", 0, "active"],
        ["model_account_ambiguous", 2, "active"],
        ["model_account_refused", 1, "revoked"],
      ] as const) {
        await f.db.query("delete from credentials where kind='anthropic'");
        if (accounts > 0)
          await f.db.query(
            `insert into credentials(scope,owner_id,kind,value_enc,status)
             select 'user',$1,'anthropic',value_enc,$2
             from credentials cross join generate_series(1,$3::integer)
             where id=$4 and version=1`,
            [f.people.owner, status, accounts, f.credential],
          );
        warning.mockClear();
        const refused = await api("launch", { org: f.people.org, id: claude.id, requestKey: reason });
        if (reason === "model_account_ambiguous") {
          expect(refused?.status).toBe(409);
          expect(await refused!.json()).toEqual({
            error: { code: "conflict", message: `Template launch refused: ${reason}.` },
          });
          expect(warning.mock.calls).toHaveLength(1);
        } else {
          expect(refused?.status).toBe(accounts === 0 ? 404 : 422);
          const body = (await refused!.json()) as { error: { code: string; message: string } };
          expect(body.error.code).toBe(accounts === 0 ? "missing_credential" : "credential_refused");
          expect(body.error.message).not.toContain("Template launch refused");
          expect(warning.mock.calls).toHaveLength(0);
        }
        expect(f.boat.forks).toHaveLength(0);
        expect((await f.db.query("select id from template_launch_requests")).rows).toHaveLength(0);
        expect((await api("get", { org: f.people.org, id: claude.id }))?.status).toBe(200);
      }
      expect(
        (await api("launch", { org: f.people.org, id: crypto.randomUUID(), requestKey: "missing-template" }))?.status,
      ).toBe(404);
    } finally {
      warning.mockRestore();
    }
    // An unpinned revision can bill an explicitly selected eligible account, not its default.
    const alternate = (
      await f.db.query<{ id: string; version: number }>(
        "insert into credentials(scope,owner_id,kind,name,value_enc) select 'user',$1,'openai','Alternate API',value_enc from credentials where kind='openai' limit 1 returning id,version",
        [f.people.owner],
      )
    ).rows[0]!;
    const chosen = await api("launch", {
      org: f.people.org,
      id: saved.item.id,
      requestKey: "alternate-account",
      modelAccount: alternate,
    });
    expect(chosen?.status).toBe(200);
    expect(await chosen!.json()).toMatchObject({ state: "succeeded", manifest: { account: alternate } });
    const pinned = (await f.create(f.people.owner, "personal", { ...f.definition, modelAccount: alternate }))
      .item as LaunchTemplate;
    const refusedOverride = await api("launch", {
      org: f.people.org,
      id: pinned.id,
      requestKey: "pinned-override",
      modelAccount: alternate,
    });
    expect(refusedOverride?.status).toBe(400);
  } finally {
    await f.close();
  }
});

test("template admission freezes merged defaults and explicit overrides; opt-out excludes only defaults", async () => {
  const f = await fixture();
  try {
    const defaults = createSkillDefaultsService(f.sql);
    await defaults.command(f.actor(f.people.admin), "set", {
      org: f.people.org,
      scope: "org",
      skills: ["shared@2.0.0", "org-only@1.0.0"],
    });
    await defaults.command(f.actor(f.people.admin), "set", {
      org: f.people.org,
      scope: "golden",
      goldenId: f.goldenId,
      skills: ["shared@1.0.0", "environment@1.0.0"],
    });
    await defaults.command(f.actor(), "set", {
      org: f.people.org,
      scope: "personal",
      skills: ["shared@3.0.0", "personal@1.0.0"],
    });
    const t = (await f.create(undefined, undefined, { ...f.definition, skills: ["shared@4.0.0", "template@1.0.0"] }))
      .item as LaunchTemplate;
    const result = await f.launch(t.id, "merged", { skills: ["shared@5.0.0"] });
    expect(result.state).toBe("succeeded");
    const expected = ["shared@5.0.0", "environment@1.0.0", "org-only@1.0.0", "personal@1.0.0", "template@1.0.0"];
    expect(result.manifest).toMatchObject({
      resolvedSkills: expected,
      definition: { skills: ["shared@4.0.0", "template@1.0.0"] },
    });
    await defaults.command(f.actor(), "set", { org: f.people.org, scope: "personal", skills: ["changed@1.0.0"] });
    expect(await f.launch(t.id, "merged", { skills: ["shared@5.0.0"] })).toEqual(result);
    const optedOut = await f.launch(t.id, "opt-out", { skipSkillDefaults: true, skills: ["explicit@1.0.0"] });
    expect(optedOut.state).toBe("succeeded");
    expect(optedOut.manifest).toMatchObject({ resolvedSkills: ["shared@4.0.0", "template@1.0.0", "explicit@1.0.0"] });
    await expect(f.launch(t.id, "bad-opt-out", { skipSkillDefaults: "true" })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(f.launch(t.id, "bad-pins", { skills: ["floating@latest"] })).rejects.toMatchObject({
      code: "invalid",
    });
    expect(f.boat.forks).toHaveLength(0);
  } finally {
    await f.close();
  }
});

// Owns combined transport admission: neither per-list validation nor provider stubs enforce this contract.
test("template publication caps readable and secret bindings at 64 combined entries", async () => {
  const f = await fixture();
  try {
    const secretId = (
      await f.db.query<{ id: string }>(
        "insert into application_secrets(org_id,owner_id,scope,name,value_enc) values($1,$2,'personal','APP_TOKEN',$3) returning id",
        [f.people.org, f.people.owner, await encryptSecret(crypto.randomUUID(), ENCRYPTION_KEY)],
      )
    ).rows[0]!.id;
    const variables = Array.from({ length: 64 }, (_, i) => ({
      key: `CONFIG_${i}`,
      variableId: f.variableId,
      version: 1,
    }));
    const secrets = [{ key: "APP_TOKEN", secretId, version: 1 }];
    await expect(f.create(f.people.owner, "personal", { ...f.definition, variables, secrets })).rejects.toThrow(
      "environment_limits_exceeded",
    );
    const valid = await f.create(f.people.owner, "personal", {
      ...f.definition,
      variables: variables.slice(1),
      secrets,
    });
    expect((valid.item as LaunchTemplate).currentRevision).toBe(1);
  } finally {
    await f.close();
  }
});

test("template admission validates decrypted combined byte budget before any fork", async () => {
  const f = await fixture();
  try {
    // Generated in memory, never included in assertion output, fixtures or receipts.
    const canary = crypto.randomUUID().repeat(228).slice(0, 8192);
    const secretId = (
      await f.db.query<{ id: string }>(
        "insert into application_secrets(org_id,owner_id,scope,name,value_enc) values($1,$2,'personal','APP_TOKEN',$3) returning id",
        [f.people.org, f.people.owner, await encryptSecret(canary, ENCRYPTION_KEY)],
      )
    ).rows[0]!.id;
    const secrets = Array.from({ length: 8 }, (_, i) => ({ key: `APP_TOKEN_${i}`, secretId, version: 1 }));
    const oversized = (await f.create(f.people.owner, "personal", { ...f.definition, secrets })).item as LaunchTemplate;
    await expect(f.launch(oversized.id, "over-budget")).rejects.toThrow("environment_limits_exceeded");
    expect(f.boat.forks).toHaveLength(0);
    expect(f.configured).toHaveLength(0);
    const exact = (await f.create(f.people.owner, "personal", { ...f.definition, variables: [], secrets }))
      .item as LaunchTemplate;
    const accepted = await f.launch(exact.id, "exact-budget");
    expect(accepted.state).toBe("succeeded");
    expect(f.boat.forks).toHaveLength(0);
    expect(JSON.stringify(accepted).includes(canary)).toBe(false);
  } finally {
    await f.close();
  }
});

test("template golden admission preserves direct-launch public classifications", async () => {
  const f = await fixture();
  try {
    const t = (await f.create()).item as LaunchTemplate;
    await f.db.query("update goldens set provider_snapshot_id=null,boat_snapshot_id=null where id=$1", [f.goldenId]);
    await expect(
      goldenForLaunch(
        f.runtime.stores.goldens,
        { userId: f.people.owner, orgId: f.people.org, role: "member" },
        "shared",
        "boat",
      ),
    ).rejects.toMatchObject({ code: "conflict", message: "Golden 'shared' has no snapshot yet." });
    // HTTP 200 without a durable request: the published refusal variant, not a receipt.
    const refusal = await f.launch(t.id, "no-snapshot");
    expect(refusal).toEqual({ state: "failed", reason: "conflict", message: "Golden 'shared' has no snapshot yet." });
    publishedResponse("templates/launch").parse(refusal);
    await f.db.query("update goldens set removed_at=now() where id=$1", [f.goldenId]);
    expect(await f.launch(t.id, "removed-golden")).toMatchObject({
      state: "failed",
      reason: "not_found",
      message: "No such golden.",
    });
    expect(f.boat.forks).toHaveLength(0);
  } finally {
    await f.close();
  }
});
