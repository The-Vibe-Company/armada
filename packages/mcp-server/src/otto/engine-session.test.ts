import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PromptRequest, Provider, Sql } from "@armada/core/server";
import type { PGlite } from "@electric-sql/pglite";
import { openMigratedDatabase } from "../../../../scripts/test-support/migrated-database.ts";
import type { Caller } from "../caller.ts";
import { createSqlData } from "../data.ts";
import { createRuntimeCommands } from "../runtime-commands.ts";
import { createRuntimeEnrolments } from "../runtime-enrolment.ts";
import { createOttoEngineSessions, isOttoInterviewProviderSandbox } from "./engine-session.ts";
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
