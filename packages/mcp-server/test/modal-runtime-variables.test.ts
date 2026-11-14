import { expect, test } from "bun:test";
import { createSqlAuthStore } from "@armada/auth";
import {
  createApplicationVault,
  createSqlVaultStore,
  createTemplateService,
  encryptSecret,
  type LaunchTemplate,
  resolveModelChoice,
  type Sql,
} from "@armada/core/server";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { modalRuntimeConfiguration, readModalRuntimeVariables } from "../src/modal-runtime-variables.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { database, ENCRYPTION_KEY, fakeBoat } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

// Real template claims/manifests and HTTP authorization; only physical compute is fake.
async function fixture(isolated = false, harness: "codex" | "claude" = "codex") {
  const { db, people } = await (isolated ? database() : sharedDatabase());
  const sql: Sql = { query: (q, v) => db.query(q, v), transaction: (work) => db.transaction((tx) => work(tx)) };
  const templates = createTemplateService(sql, ENCRYPTION_KEY);
  const application = createApplicationVault(sql, ENCRYPTION_KEY);
  const caller = {
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" as const }],
    via: "supabase" as const,
  };
  const binding = { workspace: "workspace", environment: "main", appId: "app" };
  const modal = (
    await db.query<{ id: string }>(
      `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
     values($1,$2,'variables-modal','private','modal','master','image',$3,$4,$5,'{"repos":[{"url":"https://github.com/example/web.git","branch":"main","dir":"web"}],"init":[]}') returning id`,
      [people.org, people.owner, binding.workspace, binding.environment, binding.appId],
    )
  ).rows[0]!;
  const variable = await application.command(caller, "variable", "set", {
    org: people.org,
    scope: "personal",
    name: "APP_REGION",
    value: "original\n$(not-a-command)",
  });
  const variableId = (variable.item as { id: string }).id;
  const account = (
    await db.query<{ id: string; version: number }>(
      "select id,version from credentials where kind=$2::public.credential_kind and owner_id=$1",
      [people.org, harness === "claude" ? "anthropic" : "openai"],
    )
  ).rows[0]!;
  const definition = {
    goldenId: modal.id,
    provider: "modal",
    harness,
    ...resolveModelChoice(harness, {}),
    modelAccount: account,
    variables: [{ key: "APP_REGION", variableId, version: 1 }],
    connections: [],
    skills: [],
  };
  const physical = fakeBoat();
  const host = {
    ...physical.provider,
    id: "modal" as const,
    configureReadableVariables: async () => {
      throw Error("Enrolled templates must never call the native variable port");
    },
  };
  const starts: Record<string, string>[] = [];
  let prompts = 0;
  const options: ControlOptions = {
    templates,
    data: createSqlData(sql),
    store: createSqlVaultStore(sql),
    encryptionKey: ENCRYPTION_KEY,
    authStore: createSqlAuthStore(sql),
    supabase: {
      supabaseUrl: "https://supabase.test",
      anonKey: "fixture",
      fetch: async () => Response.json({ id: people.owner }),
    },
    providers: {
      resolve: async () => {
        throw Error("Enrolled template launch must not resolve a native provider");
      },
    },
    modalRuntimeHostFor: async () => host,
    modalRuntimeLaunch: {
      start: async ({ sandbox, actor, credentials }) => {
        // A trusted descriptor fixture, not a CLI-install fixture; this owner
        // projects private credentials and readables into the selected environment.
        const plan = await modalRuntimeConfiguration(sql, {
          sandbox,
          actor,
          credentials,
          architecture: "x64",
          manifest: {
            protocol: 1,
            platform: "linux",
            libc: "glibc",
            architecture: "x64",
            runtime: { sha256: "a".repeat(64), bytes: 1 },
            harnesses: { [harness]: { files: [{ path: `bin/${harness}` }] } },
          },
        });
        const selectedEnv = harness === "claude" ? plan.configuration.claudeEnv : plan.configuration.codexEnv;
        const key = harness === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
        expect(selectedEnv[key]).toBe(credentials.env[key]);
        expect(Reflect.get(plan.configuration, "mcp")).toEqual({ revision: "modal_runtime_empty_v1", servers: {} });
        starts.push(Object.fromEntries(Object.entries(selectedEnv).filter(([key]) => key === "APP_REGION")));
        return {
          epoch: "7",
          prompt: async () => ({ promptId: `prompt-${++prompts}`, conversationId: "conversation", status: "queued" }),
        };
      },
    },
  };
  const create = async (def: unknown = definition) =>
    (
      await templates.command(caller, "create", {
        org: people.org,
        scope: "personal",
        name: crypto.randomUUID(),
        definition: def,
      })
    ).item as LaunchTemplate;
  const api = async (body: Record<string, unknown>, path = "sandbox/launch-modal-runtime-v1") => {
    const response = await handleControlRequest(
      new Request(`https://armada.test/api/v1/${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: people.owner })).replace(/=+$/, "")}.sig`,
        },
        body: JSON.stringify(body),
      }),
      options,
    );
    if (!response) throw Error("Missing control response");
    return response;
  };
  const request = (id: string) => ({
    runtimeVersion: 1,
    runtimeTransport: "dialout",
    provider: "modal",
    harness,
    org: people.org,
    id,
    revision: 1,
    requestKey: crypto.randomUUID(),
    prompt: "answer",
    skipSkillDefaults: true,
  });
  return {
    db,
    sql,
    people,
    caller,
    templates,
    application,
    variableId,
    modal,
    definition,
    physical,
    starts,
    api,
    create,
    request,
    prompts: () => prompts,
  };
}

test("Modal experimental template launch freezes variables and its original runtime receipt across claim replay", async () => {
  const f = await fixture(false, "claude");
  const discovery = await f.api({}, "launch/options");
  expect(await discovery.json()).toMatchObject({ modalRuntime: { variablesVersion: 1 } });
  const template = await f.create();
  const request = f.request(template.id);
  const first = await f.api(request);
  expect(first.status).toBe(200);
  const launched = (await first.json()) as {
    id: string;
    state: string;
    runtime: { kind: string; epoch: string };
    manifest: { variables: Record<string, string> };
  };
  expect(launched).toMatchObject({ state: "succeeded", runtime: { kind: "armada", epoch: "7" } });
  expect(f.starts).toEqual([{ APP_REGION: "original\n$(not-a-command)" }]);
  const delivered = f.starts[0];
  if (!delivered) throw Error("Missing enrolled variable delivery");
  expect(launched.manifest.variables).toEqual(delivered);
  await f.application.command(f.caller, "variable", "update", {
    org: f.people.org,
    id: f.variableId,
    expectedVersion: 1,
    value: "changed-source",
  });
  const replay = await f.api(request);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(launched);
  await f.templates.command(f.caller, "delete", { org: f.people.org, id: template.id, expectedRevision: 1 });
  const tombstoneReplay = await f.api(request);
  expect(tombstoneReplay.status).toBe(200);
  expect(await tombstoneReplay.json()).toEqual(launched);
  expect(f.physical.forks).toHaveLength(1);
  expect(f.prompts()).toBe(1);
  // Resume reads the admitted manifest, not the mutable current variable source.
  expect(await readModalRuntimeVariables(f.sql, { userId: f.people.owner, orgId: f.people.org }, launched.id)).toEqual({
    APP_REGION: "original\n$(not-a-command)",
  });
});

test("Modal template selection rejects secrets, foreign provider/harness, invalid pins and mixed source overrides before allocation", async () => {
  const f = await fixture();
  const valid = await f.create();
  const boat = (
    await f.db.query<{ id: string }>("select id from goldens where name='shared' and org_id=$1", [f.people.org])
  ).rows[0]!;
  const foreignProvider = await f.create({ ...f.definition, provider: "boat", goldenId: boat.id });
  const foreignHarness = await f.create({
    ...f.definition,
    ...resolveModelChoice("claude", {}),
    harness: "claude",
    modelAccount: undefined,
  });
  const secret = (
    await f.db.query<{ id: string }>(
      "insert into application_secrets(org_id,owner_id,scope,name,value_enc) values($1,$2,'personal','APP_TOKEN',$3) returning id",
      [f.people.org, f.people.owner, await encryptSecret(crypto.randomUUID(), ENCRYPTION_KEY)],
    )
  ).rows[0]!;
  const secretBound = await f.create({
    ...f.definition,
    secrets: [{ key: "APP_TOKEN", secretId: secret.id, version: 1 }],
  });
  const base = f.request(valid.id);
  for (const request of [
    { ...base, id: secretBound.id },
    { ...base, id: foreignProvider.id },
    { ...base, id: foreignHarness.id },
    { ...base, revision: undefined },
    { ...base, revision: 0 },
    { ...base, revision: 1.5 },
    { ...base, golden: "variables-modal" },
    { ...base, credentialId: crypto.randomUUID() },
    { ...base, model: "other" },
    { ...base, connections: [] },
    { ...base, env: { APP_REGION: "override" } },
  ]) {
    expect((await f.api(request)).status).toBe(400);
  }
  expect(f.physical.forks).toHaveLength(0);
  expect(f.starts).toEqual([]);
});

test("frozen Modal environment rejects reserved keys and secret manifests even if internal storage is corrupted", async () => {
  // This test deliberately bypasses an immutable-row trigger in an isolated DB;
  // settings/trigger mutations must never use the row-only shared fixture.
  const f = await fixture(true);
  try {
    const template = await f.create();
    const response = await f.api(f.request(template.id));
    expect(response.status).toBe(200);
    const launched = (await response.json()) as { id: string };
    const row = (
      await f.db.query<{ manifest: Record<string, unknown> & { definition: Record<string, unknown> } }>(
        "select manifest from template_launch_requests where sandbox_id=$1",
        [launched.id],
      )
    ).rows[0]!;
    for (const manifest of [
      {
        ...row.manifest,
        variables: { OPENAI_API_KEY: "readable-canary" },
        definition: {
          ...row.manifest.definition,
          variables: [{ key: "OPENAI_API_KEY", variableId: f.variableId, version: 1 }],
        },
      },
      {
        ...row.manifest,
        definition: {
          ...row.manifest.definition,
          secrets: [{ key: "APP_TOKEN", secretId: crypto.randomUUID(), version: 1 }],
        },
      },
    ]) {
      await f.db.exec("set session_replication_role=replica");
      try {
        await f.db.query("update template_launch_requests set manifest=$2::jsonb where sandbox_id=$1", [
          launched.id,
          JSON.stringify(manifest),
        ]);
      } finally {
        await f.db.exec("set session_replication_role=origin");
      }
      await expect(
        readModalRuntimeVariables(f.sql, { userId: f.people.owner, orgId: f.people.org }, launched.id),
      ).rejects.toMatchObject({
        code: "unavailable",
        message: "Frozen runtime readable configuration is unavailable.",
      });
    }
  } finally {
    await f.db.close();
  }
});

// The opt-in route strips transport headers before calling the shared service;
// its trusted runtime selection must still be part of durable request identity.
test("native template replay cannot adopt an enrolled request key", async () => {
  const f = await fixture();
  const template = await f.create();
  const request = f.request(template.id);
  const launched = await f.api(request);
  expect(launched.status).toBe(200);
  const native = Object.fromEntries(
    Object.entries(request).filter(
      ([key]) => !["runtimeVersion", "runtimeTransport", "provider", "harness"].includes(key),
    ),
  );
  const replay = await f.api(native, "templates/launch");
  expect(replay.status).toBe(409);
  expect(f.physical.forks).toHaveLength(1);
  expect(f.prompts()).toBe(1);
});
