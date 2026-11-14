import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { PromptRequest, Provider, Sql } from "@armada/core/server";
import type { PGlite } from "@electric-sql/pglite";
import { openMigratedDatabase } from "../../../../scripts/test-support/migrated-database.ts";
import type { Caller } from "../caller.ts";
import { createSqlData } from "../data.ts";
import { createRuntimeCommands } from "../runtime-commands.ts";
import { createRuntimeEnrolments } from "../runtime-enrolment.ts";
import { createOttoEngineSessions, interviewCapability, isOttoInterviewProviderSandbox } from "./engine-session.ts";
import { interviewStore } from "./interview.ts";

let db: PGlite;
const orgId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const objectiveId = "33333333-3333-4333-8333-333333333333";
const goldenId = "44444444-4444-4444-8444-444444444444";
const sandboxId = "55555555-5555-4555-8555-555555555555";
const otherSandboxId = "66666666-6666-4666-8666-666666666666";
const key = Buffer.alloc(32, 9).toString("base64");
const caller: Caller = { userId: ownerId, orgs: [{ orgId, role: "admin" }], via: "supabase" };
const scope = { orgId, ownerId, objectiveId };
const sql: Sql = {
  query: (text, params) => db.query(text, params),
  transaction: (work) => db.transaction((tx) => work({ query: (text, params) => tx.query(text, params) })),
};
const data = createSqlData(sql);
beforeAll(async () => {
  db = await openMigratedDatabase();
  await db.query("insert into auth.users(id) values ($1)", [ownerId]);
  await db.query("insert into public.orgs(id,name) values ($1,'Engine session test')", [orgId]);
  await db.query("insert into public.members(org_id,user_id,role) values ($1,$2,'admin')", [orgId, ownerId]);
  await db.query(
    "insert into public.goldens(id,org_id,owner_id,name,visibility) values ($1,$2,$3,'engine_golden','private')",
    [goldenId, orgId, ownerId],
  );
  await db.query(
    "insert into public.otto_objectives(id,org_id,owner_id,repository,request) values ($1,$2,$3,'owner/repository','Interview request')",
    [objectiveId, orgId, ownerId],
  );
  for (const [id, providerSandboxId] of [
    [sandboxId, "provider_interview"],
    [otherSandboxId, "provider_ordinary"],
  ] as const) {
    await data(caller).sandboxes.insert({
      id,
      providerSandboxId,
      goldenId,
      orgId,
      ownerId,
      harness: "codex",
      status: "ready",
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
      provider: "boat",
    });
  }
  await data(caller).sandboxes.update(sandboxId, {
    taskPromptId: "previous_prompt",
    conversationIds: ["existing_conversation"],
  });
  const store = interviewStore(sql, scope);
  await store.start({ harness: "codex", model: "fallback_model", credentialId: "account_reference" }, goldenId);
  await store.bindSession(sandboxId);
});
afterAll(async () => {
  await db?.close();
});

test("native interview delivery waits durably for the active turn, preserves stored selection and replays one receipt", async () => {
  let done = false;
  const prompts: PromptRequest[] = [];
  const observed: { sandboxId: string; promptId: string }[] = [];
  // Only the remote provider boundary is simulated; all scope, sandbox activity,
  // pending admission and outcome journal operations use the real SQL stores.
  const remote: Pick<Provider, "id" | "prompt" | "getPrompt"> = {
    id: "boat",
    async getPrompt(request) {
      observed.push(request);
      return { promptId: request.promptId, status: done ? "finished" : "running", done };
    },
    async prompt(request) {
      prompts.push(request);
      return { promptId: "accepted_prompt", conversationId: "existing_conversation", status: "queued" };
    },
  };
  const provider = new Proxy(remote, {
    get(target, property) {
      if (property === "then") return undefined;
      if (!(property in target)) throw new Error(`Unexpected remote provider method: ${String(property)}`);
      return Reflect.get(target, property);
    },
  }) as Provider;
  const sessions = createOttoEngineSessions({
    sql,
    key,
    origin: "https://armada.example.com",
    data,
    credentials: {
      resolve: async () => {
        throw new Error("Message must not resolve a launch credential");
      },
    },
    provider: async () => {
      throw new Error("Message must not select a golden provider");
    },
    sandboxProvider: async () => provider,
    launch: {},
    commands: createRuntimeCommands(createRuntimeEnrolments(sql, key), key),
    runtimeSend: async () => {
      throw new Error("Native message must not use runtime transport");
    },
  });
  const interview = await interviewStore(sql, scope).read();
  if (!interview) throw new Error("Missing persisted interview");
  await expect(sessions.message(caller, scope, interview)).rejects.toThrow("active");
  expect(prompts).toHaveLength(0);
  expect(
    (await db.query<{ state: string }>("select state from public.otto_intentions where objective_id=$1", [objectiveId]))
      .rows,
  ).toEqual([{ state: "pending" }]);
  done = true;
  const receipt = await sessions.message(caller, scope, interview);
  expect(receipt).toEqual({
    status: "succeeded",
    result: { promptId: "accepted_prompt", conversationId: "existing_conversation" },
  });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toMatchObject({
    sandboxId: "provider_interview",
    harness: "codex",
    model: "gpt-6.1-sol",
    reasoningEffort: "high",
    conversationId: "existing_conversation",
  });
  expect(observed).toEqual([
    { sandboxId: "provider_interview", promptId: "previous_prompt" },
    { sandboxId: "provider_interview", promptId: "previous_prompt" },
  ]);
  expect(await sessions.message(caller, scope, interview)).toEqual(receipt);
  expect(prompts).toHaveLength(1);
  expect((await data(caller).sandboxes.get(sandboxId))?.taskPromptId).toBe("accepted_prompt");
});

test("native lifecycle isolation matches only the exact provider and durably bound interview sandbox", async () => {
  expect(await isOttoInterviewProviderSandbox(sql, "boat", "provider_interview")).toBe(true);
  expect(await isOttoInterviewProviderSandbox(sql, "modal", "provider_interview")).toBe(false);
  expect(await isOttoInterviewProviderSandbox(sql, "boat", "provider_ordinary")).toBe(false);
  expect(await isOttoInterviewProviderSandbox(sql, "boat", sandboxId)).toBe(false);
});

test("ordinary lifecycle remains available before the interview migration but other storage errors still deny turns", async () => {
  const missing: Sql = {
    query: async () => {
      throw Object.assign(Error("Missing additive table"), { code: "42P01" });
    },
  };
  expect(await isOttoInterviewProviderSandbox(missing, "boat", "ordinary")).toBe(false);
  const unavailable: Sql = {
    query: async () => {
      throw Object.assign(Error("Connection lost"), { code: "08006" });
    },
  };
  await expect(isOttoInterviewProviderSandbox(unavailable, "boat", "ordinary")).rejects.toThrow("Connection lost");
});

function sessionsFor(provider: () => Promise<Provider>) {
  return createOttoEngineSessions({
    sql,
    key,
    origin: "https://armada.example.com",
    data,
    credentials: {
      resolve: async () => ({
        env: { OPENAI_API_KEY: "fixture_model_value" },
        secrets: ["fixture_model_value"],
        codexAuthJson: false,
      }),
      skillpackKey: async () => "fixture_skillpack_value",
    },
    provider: async () => provider(),
    sandboxProvider: async () => provider(),
    launch: {},
    commands: createRuntimeCommands(createRuntimeEnrolments(sql, key), key),
    runtimeSend: async () => {
      throw Error("Unexpected runtime send");
    },
  });
}

test("snapshot, host and tool admission failures keep the same launch pending and core pre-allocation refusal is retryable", async () => {
  const id = "77777777-7777-4777-8777-777777777777",
    launchScope = { ...scope, objectiveId: id };
  await db.query(
    "insert into public.otto_objectives(id,org_id,owner_id,repository,request) values($1,$2,$3,'owner/repository','Retry admission')",
    [id, orgId, ownerId],
  );
  const interview = await interviewStore(sql, launchScope).start(
    { harness: "codex", model: "unsupported_fixture_model", credentialId: "account_reference" },
    goldenId,
  );
  await db.query("update public.goldens set config=$2::jsonb where id=$1", [
    goldenId,
    JSON.stringify({
      repos: [{ url: "https://github.com/owner/repository", dir: "repository", branch: "main" }],
      init: [],
    }),
  ]);
  let phase = "host";
  let forks = 0;
  const sessions = sessionsFor(async () => {
    if (phase === "host") throw Error("Host configuration unavailable");
    return {
      id: "boat",
      harnesses: ["codex"],
      ...(phase === "tools" ? {} : { configureMcp: async () => {} }),
      fork: async () => {
        forks++;
        throw Error("Must not allocate");
      },
    } as unknown as Provider;
  });
  await expect(sessions.start(caller, launchScope, interview)).rejects.toThrow("snapshot unavailable");
  await db.query(
    "update public.goldens set provider_snapshot_id='fixture_snapshot',boat_snapshot_id='fixture_snapshot' where id=$1",
    [goldenId],
  );
  await expect(sessions.start(caller, launchScope, interview)).rejects.toThrow("Host configuration unavailable");
  phase = "tools";
  await expect(sessions.start(caller, launchScope, interview)).rejects.toThrow("tools unsupported");
  phase = "core";
  expect(await sessions.start(caller, launchScope, interview)).toEqual({ status: "pending", result: null });
  expect(forks).toBe(0);
  expect((await interviewStore(sql, launchScope).read())?.sandboxId).toBeNull();
  expect(
    (await db.query<{ state: string }>("select state from public.otto_intentions where objective_id=$1", [id])).rows,
  ).toEqual([{ state: "pending" }]);
});

test("restart requires observed stopped allocation, rotates one generation with CAS and preserves durable state", async () => {
  let state = "running";
  const provider = { id: "boat", get: async () => ({ id: "provider_interview", state }) } as unknown as Provider;
  const sessions = sessionsFor(async () => provider),
    store = interviewStore(sql, scope),
    before = (await store.read())!;
  await db.query(
    "insert into public.otto_intentions(org_id,owner_id,objective_id,idempotency_key,kind,payload,state) values($1,$2,$3,'engine_start:0','engine_start',$4::jsonb,'unknown')",
    [orgId, ownerId, objectiveId, JSON.stringify({ generation: 0, sandboxId })],
  );
  await expect(sessions.restart(caller, scope, before)).rejects.toThrow("not observably");
  state = "stopped";
  const after = await sessions.restart(caller, scope, before);
  expect(after).toMatchObject({
    sessionGeneration: 1,
    sandboxId: null,
    revision: before.revision + 1,
    answers: before.answers,
    round: before.round,
    engine: before.engine,
  });
  await expect(sessions.restart(caller, scope, before)).rejects.toThrow("revision conflict");
  expect(
    (
      await db.query<{ state: string }>(
        "select state from public.otto_intentions where kind='engine_start' and objective_id=$1",
        [objectiveId],
      )
    ).rows,
  ).toEqual([{ state: "retired" }]);
  // Retired engines never regain automatic generic MCP/GitHub authority.
  expect(await isOttoInterviewProviderSandbox(sql, "boat", "provider_interview")).toBe(true);
});

test("interview capabilities are domain-derived rather than signatures under the encryption root", () => {
  const capability = interviewCapability(key, scope, sandboxId);
  const directRoot = createHmac("sha256", key)
    .update(JSON.stringify(["otto/interview/v1", orgId, ownerId, objectiveId, sandboxId]))
    .digest("hex");
  expect(capability).not.toBe(directRoot);
  expect(capability).not.toBe(interviewCapability(key, scope, otherSandboxId));
  expect(capability).not.toBe(interviewCapability(key, { ...scope, ownerId: goldenId }, sandboxId));
});
