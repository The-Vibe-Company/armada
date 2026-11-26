import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import type { RunnerRequest } from "@armada/agent-runtime";
import {
  accountModelCountsSql,
  accountWaitingCountSql,
  accountWorkingCountSql,
  decryptSecret,
  encryptSecret,
  type Sql,
  VaultError,
} from "@armada/core/server";
import { PGlite } from "@electric-sql/pglite";
import {
  admitClaimedAccountTurn,
  createTurnDispatchJob,
  type DispatchTurn,
  dispatchAccountTurn,
} from "./account-turn-dispatch.ts";
import { createAccountTurnQueue } from "./account-turn-queue.ts";
import type { Caller } from "./caller.ts";
import { createJobsRunner, type Job } from "./jobs/runner.ts";
import { createJobsStore } from "./jobs/store.ts";
import { currentRequestId, observeRequest } from "./request-observability.ts";

import { callSharedTool, ToolApiError } from "./tool-api.ts";
import type { ToolContext } from "./tools.ts";

let connection: PGlite | undefined;

function database() {
  if (!connection) throw new Error("Database fixture is not open");
  return connection;
}
const org = "10000000-0000-4000-8000-000000000001";
const owner = "10000000-0000-4000-8000-000000000002";
const account = "10000000-0000-4000-8000-000000000003";
const ids = [1, 2, 3].map((n) => `2a000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const requests = [1, 2].map((n) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const caller: Caller = { userId: owner, via: "service", orgs: [{ orgId: org, role: "member" }] };
const sql = {
  query: (q: string, values?: unknown[]) => database().query(q, values),
  transaction: (work: (tx: Sql) => Promise<unknown>) =>
    database().transaction((tx) => work({ query: (q, v) => tx.query(q, v) } as Sql)),
} as Sql;
const queue = createAccountTurnQueue(sql, btoa("x".repeat(32)));
beforeAll(async () => {
  connection = new PGlite();
  await database().exec(`create table credentials(id uuid primary key,name text,max_agents int,version int,status text,expires_at timestamptz,scope text,owner_id uuid);
    create table orgs(id uuid primary key);
    create table members(org_id uuid,user_id uuid,role text);
    create table mcp_actor_epochs(org_id uuid,user_id uuid,epoch bigint);
    create table sandboxes(id uuid primary key,harness text default 'codex',provider text,boat_runtime boolean,runtime_transport text,model text,reasoning_effort text,credential_id uuid,credential_version int,org_id uuid,owner_id uuid,
      provider_sandbox_id text,conversation_ids text[],visibility text default 'private',status_reason text,preservation_note text,status text,deleted_at timestamptz,stopped_at timestamptz,stop_requested_at timestamptz,expires_at timestamptz,
      activity_lease_id uuid,activity_until timestamptz,task_prompt_id text,lifecycle_generation bigint default 1,stop_generation bigint not null default 0,reconcile_lease_until timestamptz,
      application_secret_tainted boolean not null default false,
      docker_host_id uuid,docker_installation_id uuid,docker_generation uuid);
    create table sandbox_transitions(id bigint generated always as identity, sandbox_id uuid,
      to_status text, actor text, code text, generation bigint);
    create table runtime_enrolments(sandbox_id uuid,epoch bigint,runtime_hash text,lifecycle_generation bigint,enrolment_hash text,docker_issuer_fence text);
    create table runtime_checkpoints(sandbox_id uuid,epoch bigint,merge_stop boolean);
    create table docker_host_jobs(bound_sandbox_id uuid,position bigint,request_id uuid,
      bound_actor_id uuid,host_id uuid,bound_operation text,bound_actor_epoch bigint,cancelled_at timestamptz,
      refused_resume_generation bigint,outcome text);
    create table docker_launch_manifests(sandbox_id uuid primary key,async_launch boolean not null,result_enc bytea);
    create table docker_hosts(id uuid,org_id uuid,installation_id uuid,owner_id uuid,hash text,
      registration_hash text,revoked_at timestamptz);
    create table runtime_resumes(sandbox_id uuid,request_id uuid,target_epoch bigint,phase text,receipt jsonb,source_epoch bigint,activated_at timestamptz,conversation_id text,request_hash text);
    create table runtime_idle_turns(sandbox_id uuid,prompt_id text,settled boolean);
    create table account_agent_reservations(sandbox_id uuid primary key,account_id uuid);`);
  // Apply this migration against a minimal real schema: no hand-written queue store behavior.
  const migration = await Bun.file(
    new URL("../../../supabase/migrations/20261115123000_account_turn_queue.sql", import.meta.url),
  ).text();
  // Role grants are outside the admission contract and these roles do not exist in PGlite.
  await database().exec(migration.split("alter table")[0]!);
  await database().exec("create role anon; create role authenticated; create role service_role");
  await database().exec(
    await Bun.file(new URL("../../../supabase/migrations/20261112140924_runtime_commands.sql", import.meta.url)).text(),
  );
  await database().exec(
    await Bun.file(
      new URL("../../../supabase/migrations/20261116060000_repair_account_turn_queue.sql", import.meta.url),
    ).text(),
  );
  await database().exec(
    await Bun.file(new URL("../../../supabase/migrations/20261119024017_jobs.sql", import.meta.url)).text(),
  );
  await database().exec(
    await Bun.file(new URL("../../../supabase/migrations/20261126100908_claim_next_job.sql", import.meta.url)).text(),
  );
  await database().query("insert into credentials values($1,'Shared account',1,1,'active',null,'user',$2)", [
    account,
    owner,
  ]);
  await database().exec(
    "alter table credentials add column model_limits jsonb not null default '{}'::jsonb; alter table account_agent_reservations add column model text; alter table account_turn_queue add column model text; alter table account_turn_queue add column native_prompt_id text",
  );
  await database().exec(
    await Bun.file(
      new URL("../../../supabase/migrations/20261117190000_resolve_uncertain_native_capacity.sql", import.meta.url),
    ).text(),
  );
  await database().query("insert into orgs values($1)", [org]);
  await database().query("insert into members values($1,$2,'member')", [org, owner]);
  await database().query("insert into mcp_actor_epochs values($1,$2,1)", [org, owner]);
  for (const id of ids)
    await database().query(
      "insert into sandboxes(id,credential_id,credential_version,org_id,owner_id,conversation_ids,status,expires_at) values($1,$2,1,$3,$4,array['history'],'ready',now()+interval '1 day')",
      [id, account, org, owner],
    );
});
afterAll(async () => {
  const db = connection;
  connection = undefined;
  await db?.close();
});
beforeEach(async () => {
  await database().exec(
    "update credentials set max_agents=1,model_limits='{}'::jsonb; delete from runtime_commands; delete from runtime_checkpoints; delete from runtime_enrolments; delete from docker_host_jobs; delete from docker_launch_manifests; delete from docker_hosts; delete from runtime_resumes; delete from jobs; delete from account_turn_queue; delete from account_agent_reservations; delete from runtime_idle_turns; delete from sandbox_transitions; update sandboxes set status='ready',status_reason=null,task_prompt_id=null,stopped_at=null,stop_requested_at=null,lifecycle_generation=1,activity_lease_id=null,provider=null,boat_runtime=false,runtime_transport=null; update mcp_actor_epochs set epoch=1;",
  );
});

test("an accepted request creates one generation-fenced dispatch job across identical retries", async () => {
  const input = { id: ids[0]!, request_id: requests[0]!, prompt: "next instruction" };
  await database().query("update sandboxes set lifecycle_generation=7 where id=$1", [input.id]);
  expect(await queue.accept(caller, input)).toMatchObject({ status: "queued" });
  await database().query("update sandboxes set lifecycle_generation=8 where id=$1", [input.id]);
  expect(await queue.accept(caller, input)).toMatchObject({ status: "queued" });
  const { rows } = await database().query<{
    kind: string;
    sandbox_id: string;
    org_id: string;
    generation: string;
    state: string;
    payload_enc: Uint8Array<ArrayBuffer>;
  }>("select kind,sandbox_id,org_id,generation::text,state,payload_enc from public.jobs");
  expect(rows).toEqual([
    {
      kind: "turn_dispatch",
      sandbox_id: input.id,
      org_id: org,
      generation: "7",
      state: "queued",
      payload_enc: expect.any(Uint8Array),
    },
  ]);
  expect(JSON.parse(await decryptSecret(rows[0]!.payload_enc, btoa("x".repeat(32))))).toEqual({
    requestId: input.request_id,
  });
});

async function recordRuntimeCommand(command: RunnerRequest) {
  const encrypted = await encryptSecret(JSON.stringify(command), btoa("x".repeat(32)));
  await sql.query("insert into runtime_commands(sandbox_id,request_id,epoch,request_enc) values($1,$2,1,$3)", [
    command.sandboxId,
    command.requestId,
    encrypted,
  ]);
}

function recordFollowupCommand(input: { id: string; request_id: string; prompt: string }) {
  return recordRuntimeCommand({
    version: 1,
    sandboxId: input.id,
    requestId: `follow_${input.request_id}`,
    op: "prompt",
    input: { sandboxId: input.id, text: input.prompt, conversationId: "history", harness: "codex" },
  });
}

async function claimTurn(requestId: string) {
  const worker = crypto.randomUUID();
  const {
    rows: [job],
  } = await sql.query<Job>(
    `select id,kind,sandbox_id,generation::text,lease_epoch::text,attempts,max_attempts,outcome
     from public.claim_job('turn_dispatch',$1,30,32)`,
    [worker],
  );
  if (!job) throw new Error("Expected a queued dispatch job.");
  const store = createJobsStore(sql);
  return {
    job: { ...job, payload: { requestId } },
    canDispatch: async (tx?: Sql) => (await store.inspect(job, worker, tx)) === "dispatch",
    handoffGeneration: (handoff: Parameters<typeof store.handoffGeneration>[2]) =>
      store.handoffGeneration(job, worker, handoff),
  };
}

function sharedRunner(send: DispatchTurn) {
  const key = btoa("x".repeat(32));
  return createJobsRunner(
    createJobsStore(sql, key),
    { turn_dispatch: createTurnDispatchJob(sql, key, send, () => Date.UTC(2070, 0, 1)) },
    console.error,
    () => () => {},
  );
}

function sharedDispatcher(send: DispatchTurn) {
  const runner = sharedRunner(send);
  const signal = new AbortController().signal;
  return async () => {
    expect(await runner.reconcileOne(signal)).toBe(true);
    await runner.drain();
  };
}

test.each(["boat", "modal"] as const)("%s initial turn precedes follow-ups", async (provider) => {
  const id = ids[0]!;
  const followup = { id, request_id: requests[0]!, prompt: "follow-up instruction" };
  await sql.query(
    "update sandboxes set status='starting',provider=$2,boat_runtime=$2='boat',runtime_transport=$3 where id=$1",
    [id, provider, provider === "modal" ? "dialout" : null],
  );
  const setup = await createJobsStore(sql).enqueue("launch_initial_turn", id, 1, id, null, {
    orgId: org,
    maxAttempts: 3,
  });
  expect(await queue.accept(caller, followup)).toMatchObject({ status: "queued", promptId: followup.request_id });
  const sent: string[] = [];
  const run = sharedDispatcher(async (_actor, input) => {
    sent.push(input.prompt);
    await sql.query("update sandboxes set status='running',task_prompt_id=$2 where id=$1", [id, "runtime-turn"]);
    return { promptId: "runtime-turn" };
  });
  await run();
  expect(await queue.status(caller, id, followup.request_id)).toMatchObject({ failed: false });
  expect(sent).toEqual([]);

  await sql.query("update sandboxes set status='ready',provider_sandbox_id='machine' where id=$1", [id]);
  await sql.query("insert into runtime_enrolments(sandbox_id,lifecycle_generation,runtime_hash) values($1,1,'bound')", [
    id,
  ]);
  const initial = { id, request_id: setup, prompt: "initial instruction" };
  expect(await queue.acceptInitialLaunch(caller, initial, "1", async () => true)).toBe(true);
  await sql.query("update jobs set state='done' where id=$1", [setup]);
  await sql.query(
    "update jobs set run_after='-infinity' where kind='turn_dispatch' and attempts=0 and run_after>now()",
  );
  await run();
  expect(sent).toEqual([]);
  await run();
  expect(sent).toEqual([initial.prompt]);

  await sql.query("update jobs set run_after='-infinity' where kind='turn_dispatch' and state='queued'");
  await run();
  expect(sent).toEqual([initial.prompt]);
  await sql.query("insert into runtime_idle_turns values($1,'runtime-turn',true)", [id]);
  await sql.query("update jobs set run_after='-infinity' where kind='turn_dispatch' and state='queued'");
  await run();
  expect(sent).toEqual([initial.prompt, followup.prompt]);
  expect(await queue.status(caller, id, followup.request_id)).toEqual({ nativePromptId: "runtime-turn" });
});

test.each(["done", "failed"] as const)("a launch without an initial turn leaves setup %s", async (state) => {
  const id = ids[0]!;
  const followup = { id, request_id: requests[0]!, prompt: "follow-up instruction" };
  await sql.query("update sandboxes set status='starting',provider='modal',runtime_transport='dialout' where id=$1", [
    id,
  ]);
  const setup = await createJobsStore(sql).enqueue("launch_initial_turn", id, 1, id, null, {
    orgId: org,
    maxAttempts: 3,
  });
  expect(await queue.accept(caller, followup)).toMatchObject({ status: "queued" });
  await sql.query("update sandboxes set status='ready' where id=$1", [id]);
  await sql.query("update jobs set state=$2 where id=$1", [setup, state]);
  const send = spyOn({ send: async () => ({ promptId: "runtime-turn" }) }, "send");
  await sharedDispatcher(send)();
  expect(send).toHaveBeenCalledTimes(state === "done" ? 1 : 0);
  expect(await queue.status(caller, id, followup.request_id)).toMatchObject(
    state === "done" ? { nativePromptId: "runtime-turn" } : { failed: true },
  );
});

test("a Docker follow-up waits for deferred launch publication and runtime turn settlement", async () => {
  const id = ids[0]!;
  const input = { id, request_id: requests[0]!, prompt: "follow-up instruction" };
  await sql.query("update sandboxes set status='starting',provider='docker' where id=$1", [id]);
  await sql.query("insert into docker_launch_manifests values($1,true,null)", [id]);
  expect(await queue.accept(caller, input)).toMatchObject({ status: "queued", promptId: input.request_id });
  const send = spyOn({ send: async () => ({ promptId: "follow-up-turn" }) }, "send");
  const run = sharedDispatcher(send);
  await run();
  expect(await queue.status(caller, id, input.request_id)).toMatchObject({ failed: false });

  await sql.query("update sandboxes set status='ready',task_prompt_id='initial-turn' where id=$1", [id]);
  await sql.query("update docker_launch_manifests set result_enc='sealed'::bytea where sandbox_id=$1", [id]);
  await sql.query("update jobs set run_after='-infinity' where kind='turn_dispatch'");
  await run();
  expect(send).not.toHaveBeenCalled();

  await sql.query("insert into runtime_idle_turns values($1,'initial-turn',true)", [id]);
  await sql.query("update jobs set run_after='-infinity' where kind='turn_dispatch'");
  await run();
  expect(send).toHaveBeenCalledTimes(1);
  expect(await queue.status(caller, id, input.request_id)).toEqual({ nativePromptId: "follow-up-turn" });
});

test.each(["provider replies", "provider refuses"])(
  "an expired shared claim cannot settle when the %s",
  async (outcome) => {
    const input = { id: ids[0]!, request_id: requests[0]!, prompt: "next instruction" };
    await queue.accept(caller, input);
    const claim = await claimTurn(input.request_id);
    const admitted = await admitClaimedAccountTurn(sql, claim);
    if (!admitted) throw new Error("Expected the turn to be admitted.");
    let sent = false;
    await dispatchAccountTurn(
      sql,
      btoa("x".repeat(32)),
      admitted.entry,
      admitted.caller,
      async () => {
        sent = true;
        await sql.query("update public.jobs set lease_until='-infinity' where id=$1", [claim.job.id]);
        if (outcome === "provider refuses") throw new VaultError("conflict", "Account is busy.");
        return { status: "running" };
      },
      claim,
    );
    expect(sent).toBe(true);
    expect((await sql.query("select state,result_enc,failure_reason from public.account_turn_queue")).rows).toEqual([
      { state: "dispatching", result_enc: null, failure_reason: null },
    ]);
    expect((await sql.query("select sandbox_id from public.account_agent_reservations")).rows).toEqual([
      { sandbox_id: input.id },
    ]);
  },
);

test("the shared claim publishes an uppercase sandbox UUID receipt after a generation handoff", async () => {
  const input = { id: ids[0]!.toUpperCase(), request_id: requests[0]!, prompt: "next instruction" };
  await queue.accept(caller, input);
  const claim = await claimTurn(input.request_id);
  const admitted = await admitClaimedAccountTurn(sql, claim);
  if (!admitted) throw new Error("Expected the turn to be admitted.");
  const result = { status: "running" };
  await dispatchAccountTurn(
    sql,
    btoa("x".repeat(32)),
    admitted.entry,
    admitted.caller,
    async (_caller, _input, authority) => {
      if (!authority) throw new Error("Shared dispatch lost the job authority.");
      await authority.handoffGeneration({
        async lockPrerequisites() {},
        async advance(tx) {
          await tx.query("update public.sandboxes set lifecycle_generation=2 where id=$1", [input.id]);
        },
      });
      return result;
    },
    claim,
  );
  expect(await queue.accept(caller, input)).toEqual(result);
  expect((await sql.query("select sandbox_id from public.account_agent_reservations")).rows).toEqual([]);
});

test("shared dispatch leaves the receipt untouched when encrypted input belongs to another sandbox", async () => {
  const key = btoa("x".repeat(32));
  const input = { id: ids[0]!, request_id: requests[0]!, prompt: "next instruction" };
  await queue.accept(caller, input);
  const claim = await claimTurn(input.request_id);
  const admitted = await admitClaimedAccountTurn(sql, claim);
  if (!admitted) throw new Error("Expected the turn to be admitted.");
  const input_enc = await encryptSecret(JSON.stringify({ ...input, id: ids[1]! }), key);
  const entry = { ...admitted.entry, input_enc };
  const send = () => {
    throw new Error("Provider must not be called for mismatched input.");
  };
  await expect(dispatchAccountTurn(sql, key, entry, admitted.caller, send, claim)).rejects.toThrow(
    "Encrypted turn input does not match its receipt.",
  );
  expect((await sql.query("select state,result_enc,failure_reason from public.account_turn_queue")).rows).toEqual([
    { state: "dispatching", result_enc: null, failure_reason: null },
  ]);
  expect((await sql.query("select sandbox_id from public.account_agent_reservations")).rows).toEqual([
    { sandbox_id: input.id },
  ]);
});

test("lease expiry during shared receipt publication rolls back settlement and capacity release", async () => {
  const input = { id: ids[0]!, request_id: requests[0]!, prompt: "next instruction" };
  await queue.accept(caller, input);
  const claim = await claimTurn(input.request_id);
  const admitted = await admitClaimedAccountTurn(sql, claim);
  if (!admitted) throw new Error("Expected the turn to be admitted.");
  const expiring = {
    ...claim,
    async canDispatch(tx?: Sql) {
      if (tx && (await tx.query("select 1 from public.account_turn_queue where state='admitted'")).rows.length) {
        await tx.query("update public.jobs set lease_until='-infinity' where id=$1", [claim.job.id]);
      }
      return claim.canDispatch(tx);
    },
  };
  await dispatchAccountTurn(
    sql,
    btoa("x".repeat(32)),
    admitted.entry,
    admitted.caller,
    async () => ({ status: "running" }),
    expiring,
  );
  expect((await sql.query("select state,result_enc from public.account_turn_queue")).rows).toEqual([
    { state: "dispatching", result_enc: null },
  ]);
  expect((await sql.query("select sandbox_id from public.account_agent_reservations")).rows).toEqual([
    { sandbox_id: input.id },
  ]);
});

test("a later shared claim cannot bypass the first eligible account receipt", async () => {
  const first = ids[0]!;
  const later = ids[1]!;
  const requestId = requests[0]!;
  for (const id of [first, later]) await queue.accept(caller, { id, request_id: requestId, prompt: "next" });
  await sql.query("update jobs set run_after='infinity' where sandbox_id=$1", [first]);
  const claim = await claimTurn(requestId);
  expect(claim.job.sandbox_id).toBe(later);
  expect(await admitClaimedAccountTurn(sql, claim)).toBeNull();
  await sql.query("update account_turn_queue set state='failed' where sandbox_id=$1", [first]);
  expect(await admitClaimedAccountTurn(sql, claim)).toMatchObject({ caller, entry: { sandbox_id: later } });
  expect((await sql.query("select sandbox_id from account_agent_reservations")).rows).toEqual([{ sandbox_id: later }]);
});

test("a shared claim that loses its lease leaves the receipt and capacity available", async () => {
  const sandboxId = ids[0]!;
  const requestId = requests[0]!;
  await queue.accept(caller, { id: sandboxId, request_id: requestId, prompt: "next" });
  const claim = await claimTurn(requestId);
  await sql.query("update jobs set lease_until='-infinity' where id=$1", [claim.job.id]);
  expect(await admitClaimedAccountTurn(sql, claim)).toBeNull();
  expect((await sql.query("select state,dispatch_until from account_turn_queue")).rows).toEqual([
    { state: "queued", dispatch_until: null },
  ]);
  expect((await sql.query("select sandbox_id from account_agent_reservations")).rows).toEqual([]);
});

test("lease expiry during shared admission rolls back the dispatch window and reservation", async () => {
  const sandboxId = ids[0]!;
  const requestId = requests[0]!;
  await queue.accept(caller, { id: sandboxId, request_id: requestId, prompt: "next" });
  const claim = await claimTurn(requestId);
  const expiring = {
    ...claim,
    async canDispatch(tx: Sql) {
      await tx.query(
        `update jobs set lease_until='-infinity' where id=$1
         and exists(select 1 from account_turn_queue where sandbox_id=$2 and request_id=$3 and state='dispatching')`,
        [claim.job.id, sandboxId, requestId],
      );
      return claim.canDispatch(tx);
    },
  };
  expect(await admitClaimedAccountTurn(sql, expiring)).toBeNull();
  expect((await sql.query("select state,dispatch_until from account_turn_queue")).rows).toEqual([
    { state: "queued", dispatch_until: null },
  ]);
  expect((await sql.query("select sandbox_id from account_agent_reservations")).rows).toEqual([]);
});

test.each([
  ["dispatch generation is missing", null, "-infinity", true],
  ["activity belongs to a different request", "1", "-infinity", false],
  ["the window is open and the wake has no receipt", "1", "infinity", true],
] as const)("shared recovery preserves the dispatch when %s", async (_reason, generation, until, ownActivity) => {
  const sandboxId = ids[0]!;
  const requestId = requests[0]!;
  await queue.accept(caller, { id: sandboxId, request_id: requestId, prompt: "next" });
  const claim = await claimTurn(requestId);
  await sql.query("update account_turn_queue set state='dispatching',dispatch_generation=$1,dispatch_until=$2", [
    generation,
    until,
  ]);
  await sql.query("update sandboxes set provider='boat',boat_runtime=true,activity_lease_id=$2 where id=$1", [
    sandboxId,
    ownActivity ? requestId : requests[1],
  ]);
  expect(await admitClaimedAccountTurn(sql, claim)).toBeNull();
  expect((await sql.query("select sandbox_id from account_agent_reservations")).rows).toEqual([]);
});

test.each(["-infinity", null])(
  "shared admission resets a window of %s after claim when there is no intent",
  async (until) => {
    const sandboxId = ids[0]!;
    const requestId = requests[0]!;
    await queue.accept(caller, { id: sandboxId, request_id: requestId, prompt: "next" });
    const claim = await claimTurn(requestId);
    await sql.query("update sandboxes set provider='boat',boat_runtime=true where id=$1", [sandboxId]);
    await sql.query("update account_turn_queue set state='dispatching',dispatch_generation=1,dispatch_until=$1", [
      until,
    ]);
    await sql.query("insert into account_agent_reservations(sandbox_id,account_id) values($1,$2)", [
      sandboxId,
      account,
    ]);
    expect(await admitClaimedAccountTurn(sql, claim)).toBeNull();
    expect((await sql.query("select state,dispatch_until from account_turn_queue")).rows).toEqual([
      { state: "queued", dispatch_until: null },
    ]);
    expect((await sql.query("select sandbox_id from account_agent_reservations")).rows).toEqual([]);
  },
);

test("interrupted shared admission rolls back the receipt and reservation together", async () => {
  const sandboxId = ids[0]!;
  const requestId = requests[0]!;
  await queue.accept(caller, { id: sandboxId, request_id: requestId, prompt: "next" });
  const claim = await claimTurn(requestId);
  const interrupted: Sql = {
    ...sql,
    transaction: (work) =>
      sql.transaction!(async (tx) => {
        await work(tx);
        throw new Error("Interrupted before admission commit.");
      }),
  };
  await expect(admitClaimedAccountTurn(interrupted, claim)).rejects.toThrow("Interrupted before admission commit.");
  expect((await sql.query("select state,dispatch_until from account_turn_queue")).rows).toEqual([
    { state: "queued", dispatch_until: null },
  ]);
  expect((await sql.query("select sandbox_id from account_agent_reservations")).rows).toEqual([]);
  expect(await admitClaimedAccountTurn(sql, claim)).toMatchObject({ entry: { sandbox_id: sandboxId } });
});

test("dispatch job insertion failure rolls back the queued prompt", async () => {
  const input = { id: ids[0]!, request_id: requests[0]!, prompt: "next instruction" };
  await database().exec("alter table public.jobs add constraint reject_dispatch check (kind <> 'turn_dispatch')");
  try {
    await expect(queue.accept(caller, input)).rejects.toThrow("reject_dispatch");
    expect(await queue.status(caller, input.id, input.request_id)).toBeNull();
  } finally {
    await database().exec("alter table public.jobs drop constraint reject_dispatch");
  }
  expect(await queue.accept(caller, input)).toMatchObject({ status: "queued" });
});

test.each(["modal", "boat", "docker"])("a pre-activation %s wake refusal fails the queued prompt", async (provider) => {
  const input = { id: ids[1]!, request_id: requests[0]!, prompt: "wake rejected" };
  await database().query(
    "update sandboxes set provider=$2,boat_runtime=$2='boat',runtime_transport=case when $2='modal' then 'dialout' end,status_reason=case when $2='docker' then 'idle_paused' end,status='stopped',stopped_at=now() where id=$1",
    [input.id, provider],
  );
  expect(await queue.accept(caller, input)).toMatchObject({ status: "queued" });
  const dispatchNext = sharedDispatcher(async () => {
    throw new VaultError("conflict", "No current synchronized checkpoint");
  });
  const log = spyOn(console, "error");
  try {
    await dispatchNext();
    expect(await queue.status(caller, input.id, input.request_id)).toMatchObject({
      failed: true,
      message: "Queued prompt rejected before dispatch; inspect sandbox and account settings before resending.",
    });
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        event: "operator_failure",
        phase: "account_turn.dispatch.send",
        sandboxId: input.id,
        operationSequence: expect.any(String),
        code: "conflict",
        errorClass: "VaultError",
      }),
    ]);
    expect(lines.join("\n")).not.toContain(input.request_id);
  } finally {
    log.mockRestore();
  }
});

test("a rejected first Modal turn logs bounded evidence and releases its reservation", async () => {
  const input = { id: ids[1]!, request_id: requests[0]!, prompt: "private instruction" };
  await database().query("update sandboxes set provider='modal',runtime_transport='dialout' where id=$1", [input.id]);
  let requestId: string | undefined;
  await observeRequest(
    async () => {
      requestId = currentRequestId();
      await queue.accept(caller, input);
      return undefined;
    },
    () => {},
  );
  const dispatchNext = sharedDispatcher((actor, request) =>
    callSharedTool(
      {
        caller: actor,
        now: () => new Date(0),
        data: {
          sandboxes: {
            get: async () => ({
              id: input.id,
              provider: "modal",
              status: "ready",
              credentialId: account,
              modalTransport: "dialout",
            }),
          },
        },
        async runtimeSend() {
          throw new VaultError("invalid", "private upstream detail");
        },
      } as unknown as ToolContext,
      "send",
      { ...request },
    ),
  );
  const log = spyOn(console, "error");
  try {
    await dispatchNext();
    expect(await queue.status(caller, input.id, input.request_id)).toMatchObject({ failed: true });
    expect((await database().query("select sandbox_id from account_agent_reservations")).rows).toEqual([]);
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        event: "operator_failure",
        phase: "account_turn.dispatch.send",
        code: "invalid",
        errorClass: "VaultError",
        sandboxId: input.id,
        operationSequence: expect.any(String),
        requestId: expect.any(String),
      }),
    ]);
    expect(JSON.parse(lines[0]!).requestId).toBe(requestId);
    expect(lines.join("\n")).not.toContain("private");
    expect(lines.join("\n")).not.toContain(input.request_id);
  } finally {
    log.mockRestore();
  }
});

test("send replay keeps the original receipt while new sends target the current conversation", async () => {
  const input = { id: ids[0]!, request_id: requests[0]!, prompt: "Original instruction" };
  const receipt = { id: input.id, promptId: "original_turn", conversationId: "history", status: "running" };
  await queue.accept(caller, input);
  await sharedDispatcher(async () => receipt)();
  await database().query("update sandboxes set conversation_ids=array['history','current'] where id=$1", [input.id]);
  try {
    await expect(queue.accept(caller, input)).resolves.toMatchObject(receipt);
    await expect(queue.accept(caller, { ...input, request_id: requests[1]! })).resolves.toMatchObject({
      conversationId: "current",
    });
  } finally {
    await database().query("update sandboxes set conversation_ids=array['history'] where id=$1", [input.id]);
  }
});

test.each(["after settlement", "before settlement"])(
  "an uncertain native dispatch never replays when physical stop is confirmed %s",
  async (stopTiming) => {
    await database().exec("update sandboxes set model=null");
    const first = { id: ids[1]!, request_id: requests[0]!, prompt: "uncertain instruction", model: "gpt-5.4" };
    const second = { id: ids[2]!, request_id: requests[1]!, prompt: "next instruction", model: "gpt-5.4" };
    await database().exec("update credentials set max_agents=null,model_limits='{\"gpt-5.4\":1}'::jsonb");
    await queue.accept(caller, first);
    await queue.accept(caller, second);
    await sql.query("update jobs set run_after='-infinity' where sandbox_id=$1", [first.id]);
    const dispatched: string[] = [];
    const dispatchNext = sharedDispatcher(async (_caller, input, claim) => {
      dispatched.push(input.id);
      if (input.request_id === second.request_id) {
        return { promptId: "actual_next", conversationId: "history", status: "running" };
      }
      if (!claim) throw new Error("Shared dispatch lost the job authority.");
      await claim.handoffGeneration({
        async lockPrerequisites() {},
        async advance(tx) {
          await tx.query(
            "update sandboxes set lifecycle_generation=lifecycle_generation+1,model='default_model',activity_lease_id=id where id=$1",
            [first.id],
          );
        },
      });
      // Normal dispatch cleanup releases the transient reservation even on error.
      await database().query("delete from account_agent_reservations where sandbox_id=$1", [ids[1]]);
      if (stopTiming === "before settlement")
        await database().query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [ids[1]]);
      throw Error("uncertain");
    });
    await dispatchNext();
    async function expectCapacityBlocked() {
      await sql.query("update jobs set run_after='-infinity' where sandbox_id=$1", [second.id]);
      await dispatchNext();
      expect(dispatched).toEqual([first.id]);
      expect(await queue.status(caller, second.id, second.request_id)).toMatchObject({
        failed: false,
        message: expect.stringContaining("Waiting for a free agent slot for model gpt-5.4"),
      });
    }
    expect(await queue.status(caller, first.id, first.request_id)).toMatchObject({
      failed: true,
      message: "Dispatch outcome uncertain; inspect sandbox history before resending.",
    });
    expect((await sql.query("select state,generation::text from jobs where sandbox_id=$1", [first.id])).rows).toEqual([
      { state: "done", generation: "2" },
    ]);
    if (stopTiming === "after settlement") {
      const usage = await database().query<{ total: number; default_model: number; override_model: number }>(
        `select ${accountWorkingCountSql("$1")} as total,
          ${accountWorkingCountSql("$1", "null::uuid", "'default_model'")} as default_model,
          ${accountWorkingCountSql("$1", "null::uuid", "'gpt-5.4'")} as override_model`,
        [account],
      );
      expect(
        usage.rows.map((row) => [Number(row.total), Number(row.default_model), Number(row.override_model)]),
      ).toEqual([[1, 0, 1]]);
      await expectCapacityBlocked();
      // Exec/steer can advance generations without resolving the uncertain prompt.
      await database().query("update sandboxes set lifecycle_generation=lifecycle_generation+2 where id=$1", [ids[1]]);
      await expectCapacityBlocked();
      expect((await queue.status(caller, first.id, first.request_id))?.failed).toBe(true);
      expect(
        (await database().query("select state from account_turn_queue where sandbox_id=$1", [first.id])).rows,
      ).toEqual([{ state: "failed" }]);
      await database().query(
        "update sandboxes set status='stopping',stop_requested_at=now(),lifecycle_generation=lifecycle_generation+2 where id=$1",
        [ids[1]],
      );
      await expectCapacityBlocked();
      await database().query("update sandboxes set status='failed' where id=$1", [ids[1]]);
      await expectCapacityBlocked();
      await database().query(
        "update sandboxes set status='stopped',stopped_at=now(),lifecycle_generation=lifecycle_generation+1 where id=$1",
        [ids[1]],
      );
    }
    // A later resume must not resurrect the old uncertain model charge.
    await database().query(
      "update sandboxes set status='ready',stopped_at=null,stop_requested_at=null,activity_lease_id=null,lifecycle_generation=lifecycle_generation+1 where id=$1",
      [ids[1]],
    );
    await sql.query("update jobs set run_after='-infinity' where sandbox_id=$1", [second.id]);
    await dispatchNext();
    expect(dispatched).toEqual([first.id, second.id]);
    expect(await queue.status(caller, ids[2]!, requests[1])).toEqual({ nativePromptId: "actual_next" });
  },
);

test("a shared successor cancelling an in-flight dispatch keeps the model charge until physical stop", async () => {
  const first = { id: ids[1]!, request_id: requests[0]!, prompt: "uncertain instruction", model: "gpt-5.4" };
  const second = { id: ids[2]!, request_id: requests[1]!, prompt: "next instruction", model: "gpt-5.4" };
  await database().exec("update credentials set max_agents=null,model_limits='{\"gpt-5.4\":1}'::jsonb");
  await queue.accept(caller, first);
  await queue.accept(caller, second);
  await sql.query("update jobs set run_after='-infinity' where sandbox_id=$1", [first.id]);
  const dispatched: Array<string | undefined> = [];
  const successor = sharedDispatcher(async (_caller, input) => {
    dispatched.push(input.request_id);
    return { promptId: "actual_next", conversationId: "history", status: "running" };
  });
  const readRetirement = () =>
    sql.query("select state, lease_epoch::text, outcome->>'reason' as reason from jobs where sandbox_id=$1", [
      first.id,
    ]);
  const readFirstReceipt = () => queue.status(caller, first.id, first.request_id);
  let beforeReply:
    | {
        jobs: Awaited<ReturnType<typeof readRetirement>>["rows"];
        receipt: Awaited<ReturnType<typeof readFirstReceipt>>;
      }
    | undefined;
  const original = sharedDispatcher(async (_caller, input, claim) => {
    dispatched.push(input.request_id);
    if (!claim) throw new Error("Shared dispatch lost the job authority.");
    await claim.handoffGeneration({
      async lockPrerequisites() {},
      async advance(tx) {
        await tx.query(
          "update sandboxes set lifecycle_generation=lifecycle_generation+1,model='default_model',activity_lease_id=id where id=$1",
          [first.id],
        );
      },
    });
    // Ordinary dispatch cleanup releases the transient reservation.
    await database().query("delete from account_agent_reservations where sandbox_id=$1", [first.id]);
    await database().query(
      "update sandboxes set status='stopping',stop_requested_at=now(),activity_lease_id=null where id=$1",
      [first.id],
    );
    await sql.query("update jobs set lease_until='-infinity' where sandbox_id=$1", [first.id]);
    await successor();
    beforeReply = { jobs: (await readRetirement()).rows, receipt: await readFirstReceipt() };
    throw Error("uncertain");
  });
  await original();
  if (!beforeReply) throw new Error("The successor did not settle while the original dispatch was in flight.");
  expect(beforeReply).toMatchObject({
    jobs: [{ state: "failed", lease_epoch: "2", reason: "cancelled_receipt" }],
    receipt: { failed: true },
  });
  expect({ jobs: (await readRetirement()).rows, receipt: await readFirstReceipt() }).toEqual(beforeReply);
  const usage = await database().query<{ total: number; default_model: number; override_model: number }>(
    `select ${accountWorkingCountSql("$1")} as total,
      ${accountWorkingCountSql("$1", "null::uuid", "'default_model'")} as default_model,
      ${accountWorkingCountSql("$1", "null::uuid", "'gpt-5.4'")} as override_model`,
    [account],
  );
  expect(usage.rows.map((row) => [Number(row.total), Number(row.default_model), Number(row.override_model)])).toEqual([
    [1, 0, 1],
  ]);
  await sql.query("update jobs set run_after='-infinity' where sandbox_id=$1", [second.id]);
  await successor();
  expect(dispatched).toEqual([first.request_id]);
  expect(await queue.status(caller, second.id, second.request_id)).toMatchObject({
    failed: false,
    message: expect.stringContaining("Waiting for a free agent slot for model gpt-5.4"),
  });

  await database().query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [first.id]);
  await sql.query("update jobs set run_after='-infinity' where sandbox_id=$1", [second.id]);
  await successor();
  expect(dispatched).toEqual([first.request_id, second.request_id]);
  expect(await queue.status(caller, second.id, second.request_id)).toEqual({ nativePromptId: "actual_next" });
});

test("queued public receipts remain usable across server reads, evidence, outcome and conversation controls", async () => {
  const { callSharedTool } = await import("./tool-api.ts");
  const input = { id: ids[1]!, request_id: requests[0]!, prompt: "queued Docker instruction" };
  const routedPrompts: unknown[] = [];
  const events = () => [
    {
      id: "positive_tool",
      at: 1,
      kind: "message",
      promptId: "actual_docker_prompt",
      tools: [{ id: "call", name: "launch", input: {} }],
    },
    {
      id: "negative_tool",
      at: 2,
      kind: "message",
      promptId: "second_native",
      tools: [{ id: "refusal", name: "launch", input: {}, result: { error: "no_option" } }],
    },
    { id: "unrelated", at: 0, kind: "prompt", promptId: "unmapped_native", status: "finished" },
  ];
  const outcome = { state: "ready" };
  const context = {
    caller,
    accountTurns: queue,
    data: {
      sandboxes: {
        get: async () => ({ id: input.id, provider: "docker", status: "ready" }),
      },
    },
    dockerControls: {
      invoke: async (_caller: Caller, name: string, args: Record<string, unknown>) => {
        if (name === "logs")
          return { handled: true, result: { events: events(), cursor: null, hasMore: false, settled: true } };
        if (name === "report") {
          expect(args.prompt_id).toBe("actual_docker_prompt");
          return { handled: true, result: { id: input.id, taskOutcome: args.outcome } };
        }
        if (name === "interrupt" || name === "steer") {
          expect(args).not.toHaveProperty("conversation_id");
          return {
            handled: true,
            result:
              name === "interrupt"
                ? { id: input.id, interrupted: true }
                : {
                    id: input.id,
                    promptId: "steer_native",
                    conversationId: "history",
                    delivery: "in-place",
                    mode: null,
                  },
          };
        }
        expect(name).toBe("status");
        routedPrompts.push(args.prompt_id);
        if (args.prompt_id !== undefined && args.prompt_id !== "actual_docker_prompt") throw Error("unknown prompt");
        return {
          handled: true,
          result: {
            id: input.id,
            provider: "docker",
            golden: null,
            visibility: "private",
            harness: "codex",
            repositoryDir: null,
            model: null,
            reasoningEffort: null,
            machineSize: null,
            statusReason: null,
            providerState: null,
            conversationIds: ["history"],
            usage: {
              computeSeconds: 0,
              turnCount: 3,
              turns: ["actual_docker_prompt", "second_native", "unmapped_native"].map((promptId) => ({
                promptId,
                model: "model",
                inputTokens: 3,
                outputTokens: 1,
                cachedTokens: 0,
              })),
            },
            status: "ready",
            settled: true,
            expiresAt: null,
            prompt: { promptId: "actual_docker_prompt", conversationId: "history", reason: null, state: "finished" },
          },
        };
      },
    },
    now: () => new Date(0),
    sleep: async () => {
      throw Error("No real waits");
    },
  } as unknown as import("./tools.ts").ToolContext;
  expect(await callSharedTool(context, "send", input)).toMatchObject({ promptId: input.request_id, status: "queued" });
  const waiting = await callSharedTool(context, "status", {
    id: input.id,
    prompt_id: input.request_id,
    recorded: true,
  });
  expect(waiting).toMatchObject({
    settled: false,
    statusMessage: "Prompt accepted; waiting for sandbox dispatch, not an account slot.",
  });
  expect(
    await callSharedTool(context, "wait", { id: input.id, prompt_id: input.request_id, timeout_seconds: 0 }),
  ).toMatchObject({ settled: false, timedOut: true });
  const dispatch = sharedDispatcher(async (_caller, request) => ({
    promptId: request.request_id === input.request_id ? "actual_docker_prompt" : "second_native",
    conversationId: "history",
    status: "finished",
  }));
  await dispatch();
  expect(await callSharedTool(context, "status", { id: input.id, prompt_id: input.request_id })).toMatchObject({
    settled: true,
    prompt: { promptId: input.request_id },
  });
  expect(
    await callSharedTool(context, "wait", { id: input.id, prompt_id: input.request_id, timeout_seconds: 0 }),
  ).toMatchObject({ settled: true, timedOut: false, prompt: { promptId: input.request_id, state: "finished" } });
  expect(routedPrompts).toEqual([undefined, undefined, "actual_docker_prompt", "actual_docker_prompt"]);
  // A second queued turn proves history is not projected using only the latest alias.
  await callSharedTool(context, "send", { ...input, request_id: requests[1], prompt: "second queued instruction" });
  await dispatch();
  const expectedIds = [requests[0]!, requests[1]!, "unmapped_native"];
  const logs = (await callSharedTool(context, "logs", { id: input.id })) as {
    events: { promptId: string; tools?: unknown[] }[];
  };
  expect(logs.events.map((event) => event.promptId)).toEqual(expectedIds);
  expect(logs.events.filter((event) => event.promptId === input.request_id)[0]?.tools).toHaveLength(1);
  const { readLogs } = await import("./control-logs.ts");
  const httpLogs = await readLogs(
    { dockerControls: context.dockerControls!, accountTurns: queue },
    caller,
    input.id,
    {},
  );
  expect(httpLogs.events.map((event) => event.promptId)).toEqual(expectedIds);
  const provider = {
    events: async () => ({ events: events(), cursor: null, hasMore: false }),
  } as unknown as import("@armada/core").Provider;
  const nativeContext = {
    ...context,
    dockerControls: undefined,
    provider: async () => provider,
    data: {
      sandboxes: {
        get: async () => ({ id: input.id, provider: "modal", providerSandboxId: "provider_sandbox", status: "ready" }),
      },
    },
  } as unknown as import("./tools.ts").ToolContext;
  const nativeLogs = (await callSharedTool(nativeContext, "logs", { id: input.id })) as {
    events: { promptId: string }[];
  };
  expect(nativeLogs.events.map((event) => event.promptId)).toEqual(expectedIds);
  const nativeHttpLogs = await readLogs(
    { accountTurns: queue, logs: async () => ({ provider, providerSandboxId: "provider_sandbox" }) },
    caller,
    input.id,
    {},
  );
  expect(nativeHttpLogs.events.map((event) => event.promptId)).toEqual(expectedIds);

  const status = (await callSharedTool(context, "status", { id: input.id, prompt_id: input.request_id })) as {
    usage: { turns: { promptId: string }[] };
  };
  expect(status.usage.turns.map((turn) => turn.promptId)).toEqual(expectedIds);
  await callSharedTool(context, "report", { id: input.id, prompt_id: input.request_id, outcome });
  expect(await callSharedTool(context, "interrupt", { id: input.id })).toMatchObject({
    interrupted: true,
  });
  expect(await callSharedTool(context, "steer", { id: input.id, text: "Continue" })).toMatchObject({
    promptId: "steer_native",
  });
});

test("a full account defers its turn without starving another account", async () => {
  const blocked = { id: ids[0]!, request_id: requests[0]!, prompt: "blocked instruction" };
  const available = {
    id: "90000000-0000-4000-8000-000000000001",
    request_id: requests[1]!,
    prompt: "next instruction",
  };
  const availableAccount = "80000000-0000-4000-8000-000000000001";
  await database().query("update sandboxes set status='running',task_prompt_id='active_turn' where id=$1", [ids[1]]);
  await database().query("insert into credentials values($1,'Available account',1,1,'active',null,'user',$2)", [
    availableAccount,
    owner,
  ]);
  await database().query(
    "insert into sandboxes(id,credential_id,credential_version,org_id,owner_id,conversation_ids,status,expires_at) values($1,$2,1,$3,$4,array['history'],'ready',now()+interval '1 day')",
    [available.id, availableAccount, org, owner],
  );
  await queue.accept(caller, blocked);
  await queue.accept(caller, available);
  await database().query("update jobs set run_after='-infinity' where sandbox_id=$1 and kind='turn_dispatch'", [
    blocked.id,
  ]);
  const dispatched: string[] = [];
  const dispatch = sharedDispatcher(async (_caller, input) => {
    dispatched.push(input.id);
    return { promptId: "actual", conversationId: "history", status: "running" };
  });

  await dispatch();
  expect(dispatched).toEqual([]);
  expect(await queue.accept(caller, blocked)).toMatchObject({ status: "queued" });
  const {
    rows: [deferred],
  } = await database().query(
    "select state, attempts, run_after > clock_timestamp() as deferred from jobs where sandbox_id=$1",
    [blocked.id],
  );
  expect(deferred).toEqual({ state: "queued", attempts: 0, deferred: true });

  await dispatch();
  expect(dispatched).toEqual([available.id]);
  expect(await queue.accept(caller, available)).toMatchObject({ promptId: "actual", status: "running" });
});

test("a proven pre-dispatch rejection requeues without leaking the account reservation", async () => {
  const input = { id: ids[1]!, request_id: requests[0]!, prompt: "retry after admission conflict" };
  const admit = () =>
    observeRequest(
      async () => Response.json(await queue.accept(caller, input), { status: 202 }),
      () => {},
    );
  const original = await admit();
  const correlationId = original?.headers.get("x-request-id") ?? undefined;
  expect(correlationId).toBeString();
  let calls = 0;
  const correlations: (string | undefined)[] = [];
  const dispatchNext = sharedDispatcher(async (_caller, dispatched) => {
    correlations.push(currentRequestId());
    expect(dispatched).toEqual(input);
    calls++;
    if (calls === 1) {
      await recordRuntimeCommand({
        version: 1,
        sandboxId: input.id,
        requestId: "readonly_get_prompt",
        op: "getPrompt",
        promptId: "prior_prompt",
      });
      const cause = new VaultError("conflict", "reconcile lease won admission after getPrompt probe");
      throw new ToolApiError("conflict", cause.message, undefined, { cause });
    }
    return { promptId: "accepted_after_retry", conversationId: "history", status: "running" };
  });
  await dispatchNext();
  expect((await database().query("select * from account_agent_reservations")).rows).toEqual([]);
  expect((await queue.status(caller, input.id, input.request_id))?.message).toContain("waiting for sandbox dispatch");
  const replay = await admit();
  expect(replay?.status).toBe(202);
  expect(replay?.headers.get("x-request-id")).not.toBe(correlationId);
  await sql.query("update jobs set run_after='-infinity' where sandbox_id=$1", [input.id]);
  await dispatchNext();
  expect(correlations).toEqual([correlationId, correlationId]);
  expect(calls).toBe(2);
  expect(await queue.status(caller, input.id, input.request_id)).toEqual({ nativePromptId: "accepted_after_retry" });
});

test("uppercase request UUIDs preserve one queue identity and status alias", async () => {
  const uppercase = "ABCDEF00-ABCD-4ABC-8ABC-000000000001";
  const input = { id: ids[1]!, request_id: uppercase, prompt: "case insensitive request identity" };
  expect(await queue.accept(caller, input)).toMatchObject({ requestId: uppercase.toLowerCase(), status: "queued" });
  expect(await queue.accept(caller, { ...input, request_id: uppercase.toLowerCase() })).toMatchObject({
    requestId: uppercase.toLowerCase(),
    status: "queued",
  });
  expect((await database().query("select * from account_turn_queue")).rows).toHaveLength(1);
  expect(await queue.status(caller, input.id, uppercase)).toMatchObject({
    requestId: uppercase.toLowerCase(),
    failed: false,
  });
  await sharedDispatcher(async (_caller, request) => {
    expect(request.request_id).toBe(uppercase.toLowerCase());
    return { promptId: "case_actual_prompt", conversationId: "history", status: "running" };
  })();
  expect(await queue.status(caller, input.id, uppercase)).toEqual({ nativePromptId: "case_actual_prompt" });
});

test("native invalid model settings are rejected before a durable prompt is queued", async () => {
  await expect(
    queue.accept(caller, {
      id: ids[1]!,
      request_id: requests[0]!,
      prompt: "instruction",
      model: "invalid model with spaces",
    }),
  ).rejects.toThrow();
  expect((await database().query("select * from account_turn_queue")).rows).toEqual([]);
});

test("a native request with its own durable mutating command stays uncertain rather than replaying", async () => {
  const input = { id: ids[1]!, request_id: requests[0]!, prompt: "possibly accepted instruction" };
  await sql.query("update sandboxes set provider='boat' where id=$1", [input.id]);
  await queue.accept(caller, input);
  let calls = 0;
  const worker = sharedRunner(async () => {
    calls++;
    await recordFollowupCommand(input);
    throw Error("reply lost");
  });
  const signal = new AbortController().signal;
  expect(await worker.reconcileOne(signal)).toBe(true);
  await worker.drain();
  expect(await worker.reconcileOne(signal)).toBe(false);
  expect(calls).toBe(1);
  expect(await queue.status(caller, input.id, input.request_id)).toMatchObject({
    failed: true,
    message: "Dispatch outcome uncertain; inspect sandbox history before resending.",
  });
  expect((await sql.query("select sandbox_id from account_agent_reservations")).rows).toEqual([
    { sandbox_id: input.id },
  ]);
});

test("cutover waits for a live native dispatch window before settling uncertainty", async () => {
  const input = { id: ids[1]!, request_id: requests[0]!, prompt: "already dispatching" };
  await sql.query("update sandboxes set provider='boat' where id=$1", [input.id]);
  await queue.accept(caller, input);
  // A draining replica has advanced the sandbox generation without holding a jobs lease.
  await sql.query(
    `update account_turn_queue set state='dispatching', dispatch_generation=queued_generation,
       dispatch_until=now()+interval '1 day' where sandbox_id=$1`,
    [input.id],
  );
  await sql.query("update sandboxes set lifecycle_generation=2 where id=$1", [input.id]);
  const sent: unknown[] = [];
  const run = sharedDispatcher(async (_caller, request) => {
    sent.push(request);
  });
  await run();
  expect((await sql.query("select state, attempts from jobs")).rows).toEqual([{ state: "queued", attempts: 0 }]);
  await sql.query("update account_turn_queue set dispatch_until='-infinity' where sandbox_id=$1", [input.id]);
  await sql.query("update jobs set run_after='-infinity' where sandbox_id=$1", [input.id]);
  await run();
  expect(sent).toEqual([]);
  expect(await queue.status(caller, input.id, input.request_id)).toMatchObject({
    failed: true,
    message: "Dispatch outcome uncertain; inspect sandbox history before resending.",
  });
});

test("a restarted Docker runner waits for the claim lease before recovering a dispatch without intent", async () => {
  const input = { id: ids[1]!, request_id: requests[0]!, prompt: "recover a claimed instruction" };
  await database().query("update sandboxes set provider='docker' where id=$1", [input.id]);
  await queue.accept(caller, input);
  const original = await claimTurn(input.request_id);
  expect(await admitClaimedAccountTurn(sql, original)).not.toBeNull();
  await sql.query("update account_turn_queue set dispatch_until='-infinity' where sandbox_id=$1", [input.id]);
  await sql.query("update jobs set lease_until='infinity' where id=$1", [original.job.id]);

  const sent: unknown[] = [];
  const successor = sharedRunner(async (_caller, request) => {
    sent.push(request);
    return { promptId: "recovered_prompt", conversationId: "history", status: "running" };
  });
  const signal = new AbortController().signal;
  expect(await successor.reconcileOne(signal)).toBe(false);
  expect(sent).toEqual([]);
  expect((await sql.query("select state from account_turn_queue where sandbox_id=$1", [input.id])).rows).toEqual([
    { state: "dispatching" },
  ]);
  expect((await sql.query("select sandbox_id from account_agent_reservations")).rows).toEqual([
    { sandbox_id: input.id },
  ]);

  await sql.query("update jobs set lease_until='-infinity' where id=$1", [original.job.id]);
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  expect(sent).toEqual([input]);
  expect(await queue.status(caller, input.id, input.request_id)).toEqual({ nativePromptId: "recovered_prompt" });
  expect((await sql.query("select id, state, lease_epoch::text from jobs")).rows).toEqual([
    { id: original.job.id, state: "done", lease_epoch: "2" },
  ]);
  expect((await sql.query("select sandbox_id from account_agent_reservations")).rows).toEqual([]);
});

test("explicit owner stop cancels waiting prompts before Docker no-op routing, but idle cleanup stays intact", async () => {
  const input = { id: ids[1]!, request_id: requests[0]!, prompt: "do not wake after explicit stop" };
  const waiting = { ...input, request_id: requests[1]! };
  await queue.accept(caller, input);
  const failuresAtRouting: (boolean | undefined)[][] = [];
  const context = {
    caller,
    accountTurns: queue,
    dockerControls: {
      invoke: async () => {
        failuresAtRouting.push([
          (await queue.status(caller, input.id, input.request_id))?.failed,
          (await queue.status(caller, waiting.id, waiting.request_id))?.failed,
        ]);
        return { handled: true, result: { id: input.id, status: "stopped" } };
      },
    },
  } as unknown as ToolContext;
  await callSharedTool(context, "stop", { id: input.id, only_if_idle: true });
  expect((await queue.status(caller, input.id, input.request_id))?.failed).toBe(false);
  const claim = await claimTurn(input.request_id);
  expect((await admitClaimedAccountTurn(sql, claim))?.entry.request_id).toBe(input.request_id);
  expect(await queue.accept(caller, waiting)).toMatchObject({ status: "queued" });

  await callSharedTool(context, "stop", { id: input.id });
  expect(failuresAtRouting).toEqual([
    [false, undefined],
    [true, true],
  ]);
  await sql.query("update jobs set lease_until='-infinity' where id=$1", [claim.job.id]);
  const sent: string[] = [];
  const dispatch = sharedDispatcher(async (_caller, prompt) => {
    sent.push(prompt.request_id!);
  });
  await dispatch();
  await dispatch();
  expect(sent).toEqual([]);
  for (const request of [input, waiting]) {
    expect(await queue.status(caller, request.id, request.request_id)).toMatchObject({
      failed: true,
      message: "Queued prompt was cancelled.",
    });
  }
  expect((await sql.query("select state from jobs")).rows).toEqual([{ state: "done" }, { state: "done" }]);
  expect((await sql.query("select sandbox_id from account_agent_reservations")).rows).toEqual([
    { sandbox_id: input.id },
  ]);
});

test("unlimited accounts dispatch three turns without waiting for another dispatch receipt", async () => {
  await database().exec("update credentials set max_agents=null");
  const started: string[] = [];
  const release = Promise.withResolvers<void>();
  const workers: ReturnType<typeof sharedRunner>[] = [];
  const signal = new AbortController().signal;
  const waiting = { id: ids[0]!, request_id: requests[1]!, prompt: "behind the busy sandbox" };
  try {
    for (const id of ids) {
      expect(await queue.accept(caller, { id, prompt: "next" })).toMatchObject({ status: "queued" });
      const entered = Promise.withResolvers<"sent">();
      const worker = sharedRunner(async (_caller, input) => {
        started.push(input.id);
        entered.resolve("sent");
        await release.promise;
        return { promptId: input.request_id, conversationId: "history", status: "running" };
      });
      workers.push(worker);
      expect(await worker.reconcileOne(signal)).toBe(true);
      expect(await Promise.race([entered.promise, worker.drain().then(() => "settled without sending")])).toBe("sent");
      if (id === waiting.id) {
        expect(await queue.accept(caller, waiting)).toMatchObject({ status: "queued" });
        const competingSends: string[] = [];
        await sharedDispatcher(async (_caller, input) => {
          competingSends.push(input.id);
        })();
        expect(competingSends).toEqual([]);
        expect(await queue.status(caller, waiting.id, waiting.request_id)).toMatchObject({
          failed: false,
          message: "Prompt accepted; waiting for the current sandbox turn or dispatch to finish.",
        });
      }
    }
    expect(started).toEqual(ids);
  } finally {
    release.resolve();
    await Promise.all(workers.map((worker) => worker.drain()));
  }

  await sql.query("update jobs set run_after='-infinity' where state='queued'");
  await sharedDispatcher(async (_caller, input) => ({
    promptId: input.request_id,
    conversationId: "history",
    status: "running",
  }))();
  expect(await queue.status(caller, waiting.id, waiting.request_id)).toEqual({ nativePromptId: waiting.request_id });
});

test("a stop after acceptance fails waiting work instead of resurrecting it", async () => {
  await queue.accept(caller, { id: ids[0]!, prompt: "next" });
  await database().query("update sandboxes set status='stopped',stopped_at=now(),lifecycle_generation=2 where id=$1", [
    ids[0],
  ]);
  const sent: string[] = [];
  await sharedDispatcher(async (_caller, input) => {
    sent.push(input.id);
  })();
  expect(sent).toEqual([]);
  expect(await queue.status(caller, ids[0]!)).toMatchObject({
    failed: true,
    message: "Queued prompt cannot start: sandbox stopped, deleted, expired, or stopping.",
  });
});

test("forward repair fails historical stopped rows and preserves live queued work for dispatch", async () => {
  for (const id of ids.slice(0, 2)) await queue.accept(caller, { id, prompt: "historical" });
  await database().query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [ids[0]]);
  await database().exec(
    "drop trigger set_account_turn_queue_generation on account_turn_queue; drop function set_account_turn_queue_generation(); alter table account_turn_queue drop column queued_generation",
  );
  await database().exec(
    await Bun.file(
      new URL("../../../supabase/migrations/20261116060000_repair_account_turn_queue.sql", import.meta.url),
    ).text(),
  );
  expect(await queue.status(caller, ids[0]!)).toMatchObject({ failed: true });
  expect(await queue.status(caller, ids[1]!)).toMatchObject({ failed: false });
  const sent: string[] = [];
  const dispatch = sharedDispatcher(async (_caller, input) => {
    sent.push(input.id);
    return { promptId: "preserved_history", status: "running" };
  });
  await dispatch();
  await dispatch();
  expect(sent).toEqual([ids[1]!]);
  expect(await queue.status(caller, ids[0]!)).toMatchObject({ failed: true });
  expect(await queue.status(caller, ids[1]!)).toMatchObject({ nativePromptId: "preserved_history" });
});

test("stranded receipts settle without replay while safe unlimited and paused work dispatches", async () => {
  for (const id of ids) await queue.accept(caller, { id, request_id: requests[0]!, prompt: "historical" });
  await database().query("update sandboxes set activity_lease_id=$2 where id=$1", [ids[0], requests[0]]);
  await database().query(
    "update sandboxes set status='stopped',status_reason='idle_paused',stopped_at=now() where id=$1",
    [ids[1]],
  );
  await database().query("update sandboxes set status='running',task_prompt_id='busy_turn' where id=$1", [ids[2]]);
  const count = async () =>
    Number(
      (
        await database().query<{ n: string }>(
          `select ${accountWaitingCountSql("'" + account + "'::uuid", "(select max_agents from credentials limit 1)")} as n`,
        )
      ).rows[0]!.n,
    );
  expect(await count()).toBe(1); // Only paused work needs a new slot; busy targets already own one.
  await database().exec("update credentials set max_agents=null");
  expect(await count()).toBe(0);
  await database().query("update sandboxes set status='ready',status_reason=null,task_prompt_id=null where id=$1", [
    ids[2],
  ]);
  const waiting = await database().query<{ n: string }>(
    `select ${accountWaitingCountSql("'" + account + "'::uuid", "null::int")} as n`,
  );
  expect(Number(waiting.rows[0]!.n)).toBe(0);
  await database().exec(
    await Bun.file(
      new URL("../../../supabase/migrations/20261116072000_settle_stranded_account_queue.sql", import.meta.url),
    ).text(),
  );
  expect(await queue.status(caller, ids[0]!, requests[0])).toMatchObject({ failed: true });
  const sent: string[] = [];
  const dispatch = sharedDispatcher(async (_caller, input) => {
    sent.push(input.id);
    if (input.id === ids[2]) throw new VaultError("invalid", "Invalid historical input");
    return { promptId: "preserved_paused_turn", status: "running" };
  });
  for (const _id of ids) await dispatch();
  expect(sent.toSorted()).toEqual([ids[1]!, ids[2]!]);
  expect(await queue.status(caller, ids[0]!, requests[0])).toMatchObject({ failed: true });
  expect(await queue.status(caller, ids[1]!, requests[0])).toMatchObject({ nativePromptId: "preserved_paused_turn" });
  expect(await queue.status(caller, ids[2]!, requests[0])).toMatchObject({ failed: true });
});

test.each(["boat", "modal"])("native %s restart replays only a proven pre-dispatch claim", async (provider) => {
  const input = { id: ids[1]!, request_id: requests[0]!, prompt: "recover abandoned claim" };
  const next = { id: ids[2]!, request_id: requests[1]!, prompt: "wait behind recovered claim" };
  await sql.query("update sandboxes set provider=$3,model=null where id in ($1,$2)", [input.id, next.id, provider]);
  await queue.accept(caller, input);
  const original = await claimTurn(input.request_id);
  expect(await admitClaimedAccountTurn(sql, original)).not.toBeNull();
  expect(await queue.accept(caller, next)).toMatchObject({ status: "queued" });
  await sql.query("update jobs set run_after='-infinity' where id=$1", [original.job.id]);
  await sql.query("update account_turn_queue set dispatch_until='-infinity' where sandbox_id=$1", [input.id]);
  await sql.query("update jobs set lease_until='-infinity' where id=$1", [original.job.id]);

  const sent: unknown[] = [];
  await sharedDispatcher(async (_caller, request) => {
    sent.push(request);
    return { promptId: "recovered_native" };
  })();

  expect(sent).toEqual([input]);
  expect(await queue.status(caller, next.id, next.request_id)).toMatchObject({ failed: false });
  expect(await queue.status(caller, input.id, input.request_id)).toEqual({ nativePromptId: "recovered_native" });
  expect((await sql.query("select sandbox_id from account_agent_reservations")).rows).toEqual([]);
});

test.each([
  {
    name: "spare capacity",
    busy: false,
    limit: 3,
    occupied: false,
    expected: "Prompt accepted; waiting for sandbox dispatch, not an account slot.",
  },
  {
    name: "same sandbox turn",
    busy: true,
    limit: 3,
    occupied: false,
    expected: "Prompt accepted; waiting for the current sandbox turn or dispatch to finish.",
  },
  {
    name: "account exhaustion",
    busy: false,
    limit: 1,
    occupied: true,
    expected: "Waiting for a free agent slot on account Shared account (1/1).",
  },
  {
    name: "same sandbox at full capacity",
    busy: true,
    limit: 1,
    occupied: false,
    expected: "Prompt accepted; waiting for the current sandbox turn or dispatch to finish.",
  },
])("queue messages identify $name in acceptance and status", async ({ busy, limit, occupied, expected }) => {
  await database().query("update credentials set max_agents=$1", [limit]);
  if (busy || occupied)
    await database().query("update sandboxes set status='running',task_prompt_id='active_turn' where id=$1", [
      busy ? ids[1] : ids[0],
    ]);
  const input = { id: ids[1]!, request_id: requests[0]!, prompt: "queued instruction" };
  expect(await queue.accept(caller, input)).toMatchObject({ statusMessage: expected });
  expect(await queue.status(caller, input.id, input.request_id)).toMatchObject({ message: expected });
});

test("a full model queues its override without blocking another model and reports the real limit", async () => {
  await database().exec(
    `update credentials set max_agents=4,model_limits='{"kimi":1,"deepseek":2}'; update sandboxes set model='deepseek';`,
  );
  await database().query(
    "update sandboxes set model='kimi',status='running',task_prompt_id='active_model' where id=$1",
    [ids[0]],
  );
  const blocked = await queue.accept(caller, {
    id: ids[1]!,
    request_id: requests[0]!,
    prompt: "kimi turn",
    model: "kimi",
  });
  expect(blocked?.statusMessage).toContain("model kimi on account Shared account (1/1)");
  const otherAccount = "10000000-0000-4000-8000-000000000099";
  await database().query("insert into credentials(id,name,max_agents,model_limits) values($1,'Other account',1,'{}')", [
    otherAccount,
  ]);
  const counts = await database().query<{
    id: string;
    model_counts: Record<string, { runningAgents: number; waitingAgents: number }>;
  }>(
    `select credentials.id,${accountModelCountsSql("credentials.id", "credentials.model_limits")} as model_counts from credentials`,
  );
  expect(counts.rows.find((row) => row.id === account)?.model_counts.kimi).toEqual({
    runningAgents: 1,
    waitingAgents: 1,
  });
  expect(counts.rows.find((row) => row.id === otherAccount)?.model_counts).toEqual({});
  await database().query("delete from credentials where id=$1", [otherAccount]);

  await queue.accept(caller, { id: ids[2]!, request_id: requests[1]!, prompt: "other model", model: "deepseek" });
  const dispatched: string[] = [];
  const dispatchNext = sharedDispatcher(async (_caller, input) => {
    dispatched.push(input.model!);
    return { promptId: input.request_id, status: "running" };
  });
  await sql.query("update jobs set run_after='-infinity' where sandbox_id=$1", [ids[1]]);
  await dispatchNext();
  expect(dispatched).toEqual([]);
  expect((await sql.query("select state,attempts from jobs where sandbox_id=$1", [ids[1]])).rows).toEqual([
    { state: "queued", attempts: 0 },
  ]);
  await dispatchNext();
  expect(dispatched).toEqual(["deepseek"]);
  await database().query("insert into runtime_idle_turns values($1,'active_model',true)", [ids[0]]);
  await sql.query("update jobs set run_after='-infinity' where sandbox_id=$1", [ids[1]]);
  await dispatchNext();
  expect(dispatched).toEqual(["deepseek", "kimi"]);
});

test("queued status retains its own model when a newer request targets another model on the same sandbox", async () => {
  await database().exec(
    `update credentials set max_agents=4,model_limits='{"kimi":1}'; update sandboxes set model='deepseek';`,
  );
  await database().query(
    "update sandboxes set model='kimi',status='running',task_prompt_id='active_model' where id=$1",
    [ids[0]],
  );
  const older = { id: ids[1]!, request_id: requests[0]!, prompt: "older kimi turn", model: "kimi" };
  await queue.accept(caller, older);
  await queue.accept(caller, {
    id: ids[1]!,
    request_id: requests[1]!,
    prompt: "newer deepseek turn",
    model: "deepseek",
  });
  expect(await queue.status(caller, older.id, older.request_id)).toMatchObject({
    message: "Waiting for a free agent slot for model kimi on account Shared account (1/1).",
  });
  expect(await queue.accept(caller, older)).toMatchObject({
    statusMessage: "Waiting for a free agent slot for model kimi on account Shared account (1/1).",
  });
});

test("terminal admission creates neither queue entries nor reservations", async () => {
  for (const status of ["stopped", "failed", "expired"]) {
    for (const provider of ["docker", "boat", "modal"]) {
      if (status === "stopped" && provider !== "docker") continue;
      await database().query(
        "update sandboxes set status=$2,provider=$3,status_reason=case when $2='stopped' then 'agent_finished' end where id=$1",
        [ids[0], status, provider],
      );
      await expect(queue.accept(caller, { id: ids[0]!, prompt: "continue" })).rejects.toThrow(
        `Cannot control ${provider} sandbox: ${status}`,
      );
    }
  }
  expect((await database().query("select * from account_turn_queue")).rows).toHaveLength(0);
  expect((await database().query("select * from account_agent_reservations")).rows).toHaveLength(0);
});

test.each(["boat", "docker"])("%s stopped runtime receipts are refused instead of resumed", async (provider) => {
  const input = { id: ids[1]!, request_id: requests[0]!, prompt: "old instruction" };
  await database().query(
    "update sandboxes set provider=$2,boat_runtime=($2='boat'),runtime_transport=case when $2='modal' then 'dialout' else null end where id=$1",
    [input.id, provider],
  );
  await queue.accept(caller, input);
  const original = await claimTurn(input.request_id);
  expect(await admitClaimedAccountTurn(sql, original)).not.toBeNull();
  await recordFollowupCommand(input);
  await database().query(
    "update sandboxes set status='stopped',lifecycle_generation=2,activity_lease_id='30000000-0000-4000-8000-000000000001' where id=$1",
    [input.id],
  );
  await sql.query("update account_turn_queue set dispatch_until='-infinity' where sandbox_id=$1", [input.id]);
  await sql.query("update jobs set lease_until='-infinity' where id=$1", [original.job.id]);
  let calls = 0;
  await sharedDispatcher(async () => {
    calls++;
    return { promptId: "unwanted_turn" };
  })();
  expect(calls).toBe(0);
  expect(await queue.status(caller, input.id, input.request_id)).toMatchObject({ failed: true });
});
test.each(["boat", "modal"] as const)("stopped %s native send reaches account admission", async (provider) => {
  await database().query("update sandboxes set provider=$2,status='stopped',status_reason=null where id=$1", [
    ids[1],
    provider,
  ]);
  expect(
    await queue.accept(caller, { id: ids[1]!, request_id: requests[0]!, prompt: "continue preserved work" }),
  ).toMatchObject({ status: "queued" });
  expect((await database().query("select * from account_turn_queue")).rows).toHaveLength(1);
});

test.each([
  ["boat", "matching mutating command"],
  ["modal", "generation advance"],
] as const)("native %s restart refuses to replay after a %s", async (provider, evidence) => {
  const input = { id: ids[1]!, request_id: requests[0]!, prompt: "uncertain after restart" };
  await database().query("update sandboxes set provider=$2 where id=$1", [input.id, provider]);
  await queue.accept(caller, input);
  const original = await claimTurn(input.request_id);
  expect(await admitClaimedAccountTurn(sql, original)).not.toBeNull();
  if (evidence === "matching mutating command") {
    await recordFollowupCommand(input);
  } else {
    await sql.query("update sandboxes set lifecycle_generation=2 where id=$1", [input.id]);
  }
  await sql.query("update account_turn_queue set dispatch_until='-infinity' where sandbox_id=$1", [input.id]);
  await sql.query("update jobs set lease_until='-infinity' where id=$1", [original.job.id]);

  const sent: unknown[] = [];
  await sharedDispatcher(async (_caller, request) => {
    sent.push(request);
  })();

  expect(sent).toEqual([]);
  expect(await queue.status(caller, input.id, input.request_id)).toMatchObject({
    failed: true,
    message: "Dispatch outcome uncertain; inspect sandbox history before resending.",
  });
  expect((await sql.query("select id,state,outcome->>'reason' as reason from jobs")).rows).toEqual([
    { id: original.job.id, state: "failed", reason: "native_dispatch_uncertain" },
  ]);
  expect((await sql.query("select sandbox_id from account_agent_reservations")).rows).toEqual([
    { sandbox_id: input.id },
  ]);
});

test.each([true, false])("retained stop intent fences new queued work (merged=%s)", async (merged) => {
  const id = ids[0]!;
  const input = { id, request_id: requests[0]!, prompt: "continue retained work" };
  await database().query("update sandboxes set provider='boat',boat_runtime=true where id=$1", [id]);
  await database().query("insert into runtime_enrolments values($1,1)", [id]);
  await database().query("insert into runtime_checkpoints values($1,1,$2)", [id, merged]);

  await expect(queue.accept(caller, input)).rejects.toThrow(
    merged ? "stopping after its pull requests were merged" : "Wait for a confirmed retained stop",
  );
  await database().query(
    "update sandboxes set status='stopped',status_reason=case when $2 then 'work_merged' else status_reason end,stopped_at=now() where id=$1",
    [id, merged],
  );
  expect(await queue.accept(caller, input)).toMatchObject({ status: "queued" });
});

test.each(["modal", "boat", "docker"])(
  "a send during %s idle stop waits for the retained stop before dispatch",
  async (provider) => {
    const input = { id: ids[0]!, request_id: requests[0]!, prompt: "continue after idle pause" };
    await sql.query(
      `update sandboxes set provider=$2,status='stopping',status_reason='idle_paused',stop_requested_at=now(),
      boat_runtime=$2='boat',runtime_transport=case when $2='modal' then 'dialout' end,lifecycle_generation=2
      where id=$1`,
      [input.id, provider],
    );
    await sql.query(
      "insert into sandbox_transitions(sandbox_id,to_status,actor,code,generation) values($1,'stopping','idle',$2,2)",
      [input.id, provider === "docker" ? "docker_idle_paused" : "runtime_checkpoint_idle_paused"],
    );
    expect(await queue.accept(caller, input)).toMatchObject({ status: "queued", promptId: input.request_id });
    const sent: (typeof input)[] = [];
    const run = sharedDispatcher(async (_actor, request) => {
      sent.push({ id: request.id, request_id: request.request_id!, prompt: request.prompt });
      return { promptId: "resumed-turn" };
    });

    await run();
    expect(sent).toEqual([]);
    expect(await queue.status(caller, input.id, input.request_id)).toMatchObject({ failed: false });
    expect((await sql.query("select sandbox_id from account_agent_reservations")).rows).toEqual([]);

    await sql.query("update sandboxes set status='stopped',stopped_at=now(),stop_requested_at=null where id=$1", [
      input.id,
    ]);
    await sql.query(
      "insert into sandbox_transitions(sandbox_id,to_status,actor,code,generation) values($1,'stopped',$2,$3,2)",
      provider === "docker"
        ? [input.id, "lifecycle_runner", "docker_stop_completed"]
        : [input.id, "reconciler", "provider_stopped"],
    );
    await sql.query("update jobs set run_after='-infinity' where sandbox_id=$1", [input.id]);

    await run();
    expect(sent).toEqual([input]);
    expect(await queue.status(caller, input.id, input.request_id)).toEqual({ nativePromptId: "resumed-turn" });
  },
);

test("an explicit retained stop refuses a new queued send even with an idle pause reason", async () => {
  const id = ids[0]!;
  await sql.query(
    `update sandboxes set provider='modal',runtime_transport='dialout',status='stopping',
      status_reason='idle_paused',stop_requested_at=now() where id=$1`,
    [id],
  );
  await sql.query(
    "insert into sandbox_transitions(sandbox_id,to_status,actor,code,generation) values($1,'stopping','api','runtime_retained_stop',1)",
    [id],
  );
  await expect(queue.accept(caller, { id, prompt: "continue after explicit stop" })).rejects.toThrow(
    "Sandbox cannot accept a queued prompt.",
  );
  expect(await queue.status(caller, id)).toBeNull();
});
