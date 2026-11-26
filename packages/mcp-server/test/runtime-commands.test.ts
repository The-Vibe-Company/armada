import { expect, mock, spyOn, test } from "bun:test";
import type { RunnerRequest } from "@armada/agent-runtime";
import type { Sql } from "@armada/core/server";
import { encryptSecret } from "@armada/core/server";
import { runtimeOperatorDiagnostic } from "../../core/src/runtime-operator-diagnostic.ts";
import { controlFailureResponse } from "../src/control-errors.ts";
import { createJobsStore } from "../src/jobs/store.ts";
import { createOutboundWebhooks } from "../src/outbound-webhooks.ts";
import { continueRequest, observeRequest } from "../src/request-observability.ts";
import { createRuntimeAgent } from "../src/runtime-agent.ts";
import { authorityExtensionRequestId } from "../src/runtime-authority-extension.ts";
import { createRuntimeCommands, RuntimeCommandConflict, RuntimeCommandRefused } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments, RuntimeEnrolmentDenied } from "../src/runtime-enrolment.ts";
import { unsettledRuntimeCommands } from "../src/runtime-idle-evidence.ts";
import { createRuntimeProgress } from "../src/runtime-progress.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

async function fixture(waitAdvanceMs = 20_000, boatRuntime = false) {
  const { db, people } = await sharedDatabase();
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,boat_runtime)
    select $1,id,org_id,owner_id,'command-native','codex','ready',$3 from goldens where owner_id=$2 and visibility='private' limit 1`,
    [id, people.owner, boatRuntime],
  );
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const authority = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
  let now = 0;
  let waiting: (() => Promise<void>) | undefined;
  const clock = {
    now: () => now,
    async wait(_ms: number, _signal: AbortSignal) {
      const callback = waiting;
      waiting = undefined;
      await callback?.();
      now += waitAdvanceMs;
    },
  };
  const bridge = (time = clock) => createRuntimeCommands(authority, ENCRYPTION_KEY, time);
  const enrol = async () =>
    authority.enrol(
      (await authority.issue({ ownerId: people.owner, sandboxId: id, configuration: {} })).enrolmentToken,
    );
  const command = (requestId: string): RunnerRequest => ({ version: 1, sandboxId: id, requestId, op: "health" });
  const request = async (path: string, token: string, epoch: string, body: unknown, commands = bridge()) => {
    const response = await commands.route(
      new Request(`https://armada.example/api/runtime/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-armada-runtime-epoch": epoch },
        body: JSON.stringify(body),
      }),
    );
    if (!response) throw Error("missing_command_route");
    return response;
  };
  return {
    db,
    sql,
    people,
    id,
    authority,
    bridge,
    enrol,
    command,
    request,
    onWait(callback: () => Promise<void>) {
      waiting = callback;
    },
  };
}

test.each([
  ["advertised", 1, true],
  ["absent", undefined, false],
  ["unknown version", 2, false],
  ["stale generation", 1, false],
  ["stale expected epoch", 1, false],
  ["late reply", 1, false],
] as const)("extension capability health handles %s", async (kind, capability, supported) => {
  const f = await fixture(kind === "late reply" ? 5_000 : 250);
  const initial = await f.enrol();
  const active = kind === "stale expected epoch" ? await f.enrol() : initial;
  const bridge = f.bridge();
  const agent = createRuntimeAgent(bridge, {
    provider: "boat",
    harness: "codex",
    ownerId: f.people.owner,
    sandboxId: f.id,
    providerSandboxId: "command-native",
    cwd: "/home/user",
    defaults: { model: "gpt-5.4", reasoningEffort: "high" },
  });
  f.onWait(async () => {
    const { command } = await bridge.next(active.runtimeToken, active.epoch);
    if (command?.op !== "health") throw Error("Expected a fresh health probe");
    await bridge.complete(active.runtimeToken, active.epoch, {
      epoch: active.epoch,
      requestId: command.requestId,
      status: 200,
      body: {
        version: 1,
        requestId: command.requestId,
        result: {
          ready: true,
          generation: kind === "stale generation" ? "0" : active.epoch,
          commandAuthorityExtension: capability,
        },
      },
    });
  });
  const health = agent.health(undefined, undefined, {
    expectedEpoch: initial.epoch,
    async assertClaim() {},
    requireCommandAuthorityExtension: true,
  });
  if (supported) {
    expect(await health).toEqual({ runtime: "armada", epoch: active.epoch });
  } else {
    await expect(health).rejects.toMatchObject({ code: "sandbox_not_ready" });
  }
  if (kind === "stale expected epoch")
    expect((await f.db.query("select request_id from runtime_commands where sandbox_id=$1", [f.id])).rows).toEqual([]);
});

test.each([
  "covers target",
  "short deadline",
  "wrong ACK epoch",
  "replacement epoch",
  "late ACK",
  "lost claim",
  "expired dispatch",
  "expired claim after ACK",
  "successor rebinds",
] as const)("extension authority receipt handles %s", async (kind) => {
  const f = await fixture(kind === "late ACK" ? 2_500 : 250, true);
  const bridge = f.bridge();
  let active = await f.enrol();
  const jobs = createJobsStore(f.sql, ENCRYPTION_KEY);
  const {
    rows: [sandbox],
  } = await f.db.query<{ generation: number; deadline: Date }>(
    "select lifecycle_generation::int as generation, now()+interval '1 day' as deadline from sandboxes where id=$1",
    [f.id],
  );
  if (!sandbox) throw Error("Missing fixture sandbox");
  const jobId = await jobs.enqueue("boat_runtime_extend", f.id, sandbox.generation, f.id, null, {
    orgId: f.people.org,
    maxAttempts: 2,
    deadline: sandbox.deadline,
  });
  if (!jobId) throw Error("Missing fixture job");
  await f.db.query("insert into boat_runtime_extension_state (sandbox_id,pending_job_id) values ($1,$2)", [
    f.id,
    jobId,
  ]);
  const claim = async () => {
    const lease = await jobs.claim("boat_runtime_extend", crypto.randomUUID(), 300, 1);
    if (!lease) throw Error("Missing fixture lease");
    return lease.lease_epoch;
  };
  let leaseEpoch = await claim();
  let ownsClaim = true;
  const agent = createRuntimeAgent(bridge, {
    provider: "boat",
    harness: "codex",
    ownerId: f.people.owner,
    sandboxId: f.id,
    providerSandboxId: "command-native",
    cwd: "/home/user",
    defaults: { model: "gpt-5.4", reasoningEffort: "high" },
  });
  const target = 60_000;
  const requestId = authorityExtensionRequestId(jobId);
  const busy = async () =>
    (await f.db.query(unsettledRuntimeCommands("$1", "$2"), [f.id, sandbox.generation])).rows.length > 0;
  const extend = () =>
    agent.extendCommandAuthority({
      jobId,
      leaseEpoch,
      expectedEpoch: active.epoch,
      expiresAt: target,
      signal: new AbortController().signal,
      async assertClaim() {
        if (!ownsClaim) throw Error("extension claim lost");
      },
    });
  const answer = async (op: "health" | "extendCommandAuthority", result: Record<string, unknown>) => {
    const { command } = await bridge.next(active.runtimeToken, active.epoch);
    if (command?.op !== op) throw Error(`Expected ${op} command`);
    if (op === "extendCommandAuthority")
      expect(command).toMatchObject({ requestId, epoch: active.epoch, expiresAt: target });
    await bridge.complete(active.runtimeToken, active.epoch, {
      epoch: active.epoch,
      requestId: command.requestId,
      status: 200,
      body: { version: 1, requestId: command.requestId, result },
    });
  };
  const answerHealth = () => answer("health", { ready: true, generation: active.epoch, commandAuthorityExtension: 1 });
  const answerAck = async () => {
    await answer("extendCommandAuthority", {
      epoch: kind === "wrong ACK epoch" ? "0" : active.epoch,
      expiresAt: kind === "short deadline" ? target - 1 : target + 1,
    });
    if (kind === "lost claim") ownsClaim = false;
    if (kind === "expired claim after ACK") await f.db.query("update jobs set lease_until=now() where id=$1", [jobId]);
  };
  f.onWait(async () => {
    await answerHealth();
    f.onWait(async () => {
      if (kind === "expired dispatch") {
        expect(await busy()).toBe(true);
        await f.db.query("update jobs set lease_until=now() where id=$1", [jobId]);
        expect(await busy()).toBe(false);
        const later = f.command("later-health");
        await bridge.enqueue(f.people.owner, later, active.epoch);
        expect((await bridge.next(active.runtimeToken, active.epoch)).command).toEqual(later);
        return;
      }
      if (kind === "successor rebinds") return;
      if (kind !== "late ACK") return answerAck();
      f.onWait(answerAck);
    });
  });
  if (kind === "short deadline" || kind === "wrong ACK epoch") {
    await expect(extend()).rejects.toMatchObject({ code: "unavailable" });
  } else if (kind === "late ACK" || kind === "expired dispatch") {
    await expect(extend()).rejects.toThrow("runtime_command_pending");
  } else if (kind === "lost claim") {
    await expect(extend()).rejects.toThrow("extension claim lost");
  } else if (kind === "expired claim after ACK") {
    const receipt = extend();
    await expect(receipt).rejects.toBeInstanceOf(RuntimeCommandConflict);
    await expect(receipt).rejects.not.toBeInstanceOf(RuntimeCommandRefused);
    f.onWait(answerHealth);
    const replay = extend();
    await expect(replay).rejects.toBeInstanceOf(RuntimeCommandConflict);
    await expect(replay).rejects.not.toBeInstanceOf(RuntimeCommandRefused);
  } else if (kind === "successor rebinds") {
    await expect(extend()).rejects.toThrow("runtime_command_pending");
    await f.db.query("update jobs set lease_until=now() where id=$1", [jobId]);
    leaseEpoch = await claim();
    f.onWait(async () => {
      await answerHealth();
      f.onWait(answerAck);
    });
    expect(await extend()).toEqual({ epoch: active.epoch, expiresAt: target + 1 });
  } else {
    expect(await extend()).toEqual({ epoch: active.epoch, expiresAt: target + 1 });
    if (kind === "replacement epoch") {
      active = await f.enrol();
      f.onWait(answerHealth);
      await expect(extend()).rejects.toThrow("runtime_command_conflict");
      expect((await bridge.next(active.runtimeToken, active.epoch)).command).toBeNull();
    }
  }
});

test("generic mailbox admission refuses a command-authority extension", async () => {
  const f = await fixture();
  const active = await f.enrol();
  const bridge = f.bridge();
  const command = {
    version: 1,
    requestId: authorityExtensionRequestId(crypto.randomUUID()),
    sandboxId: f.id,
    op: "extendCommandAuthority",
    epoch: active.epoch,
    expiresAt: 60_000,
  } as const;
  await expect(bridge.enqueue(f.people.owner, command)).rejects.toBeInstanceOf(RuntimeCommandRefused);
  await expect(bridge.call(f.people.owner, command)).rejects.toBeInstanceOf(RuntimeCommandRefused);
});

test("an exact command replay checks the claim again before returning a stored reply", async () => {
  const f = await fixture();
  const active = await f.enrol();
  const bridge = f.bridge();
  const command = f.command("replay-fence");
  await bridge.enqueue(f.people.owner, command, active.epoch);
  const reply = {
    epoch: active.epoch,
    requestId: command.requestId,
    status: 200,
    body: { version: 1, requestId: command.requestId, result: { ready: true } },
  };
  await bridge.complete(active.runtimeToken, active.epoch, reply);
  let current = true;
  await expect(
    bridge.call(f.people.owner, command, {
      expectedEpoch: active.epoch,
      async assertClaim() {
        if (!current) throw Error("Claim expired during replay");
        current = false;
      },
    }),
  ).rejects.toThrow("Claim expired during replay");
  expect(await bridge.result(f.people.owner, f.id, command.requestId, active.epoch)).toEqual({
    state: "finished",
    reply,
  });
});

test("encrypted command mailbox survives replica restart, redelivers one stable ID and pins the first durable result", async () => {
  const f = await fixture();

  const active = await f.enrol();
  const first = {
    ...f.command("z-first"),
    op: "prompt",
    input: { sandboxId: f.id, harness: "codex", text: "private-command-marker" },
  } as const;
  const last = f.command("a-second");
  await f.bridge().enqueue(f.people.owner, first);
  await f.bridge().enqueue(f.people.owner, last);
  await f.bridge().enqueue(f.people.owner, first);
  expect((await f.db.query("select request_id from runtime_commands")).rows).toHaveLength(2);
  const stored = (
    await f.db.query<{ request_enc: Uint8Array }>("select request_enc from runtime_commands where request_id='z-first'")
  ).rows[0];
  expect(Buffer.from(stored?.request_enc ?? []).includes(Buffer.from("private-command-marker"))).toBe(false);
  const poll = async () => f.request("poll", active.runtimeToken, active.epoch, { epoch: active.epoch });
  const response = await poll();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ epoch: active.epoch, command: first });
  expect(await (await poll()).json()).toEqual({ epoch: active.epoch, command: first });
  const promptId = crypto.randomUUID();
  const reply = {
    epoch: active.epoch,
    requestId: first.requestId,
    status: 200,
    body: { requestId: first.requestId, result: { marker: "private-result-marker", promptId } },
  };
  expect(await (await f.request("results", active.runtimeToken, active.epoch, reply)).json()).toEqual({
    epoch: active.epoch,
    requestId: first.requestId,
  });
  expect(
    (
      await f.request("results", active.runtimeToken, active.epoch, {
        ...reply,
        body: { result: { promptId: crypto.randomUUID() } },
      })
    ).status,
  ).toBe(200);
  expect(await f.bridge().result(f.people.owner, f.id, first.requestId)).toEqual({ state: "finished", reply });
  const sealed = (
    await f.db.query<{ result_enc: Uint8Array }>("select result_enc from runtime_commands where request_id='z-first'")
  ).rows[0];
  expect(Buffer.from(sealed?.result_enc ?? []).includes(Buffer.from("private-result-marker"))).toBe(false);
  expect(await (await poll()).json()).toEqual({ epoch: active.epoch, command: last });
  expect(
    (
      await f.request("results", active.runtimeToken, active.epoch, {
        ...reply,
        requestId: last.requestId,
        body: { result: { promptId } },
      })
    ).status,
  ).toBe(200);
  expect(
    (await f.db.query("select request_id, accepted_prompt_id from runtime_commands order by sequence")).rows,
  ).toEqual([
    { request_id: first.requestId, accepted_prompt_id: promptId },
    { request_id: last.requestId, accepted_prompt_id: null },
  ]);
  await expect(
    f.bridge().enqueue(f.people.owner, { ...first, input: { ...first.input, text: "changed" } }),
  ).rejects.toThrow("runtime_command_conflict");
  await expect(f.bridge().enqueue(f.people.member, f.command("foreign-owner"))).rejects.toThrow(
    "runtime_enrolment_denied",
  );
  expect(
    (await f.request("results", active.runtimeToken, active.epoch, { ...reply, requestId: "not-enqueued", body: {} }))
      .status,
  ).toBe(409);
});

test("replacement epoch refuses old replies and never silently adopts unfinished commands", async () => {
  const f = await fixture();

  const old = await f.enrol();
  const request = f.command("before-resume");
  await f.bridge().enqueue(f.people.owner, request);
  const current = await f.enrol();
  const reply = { epoch: old.epoch, requestId: request.requestId, status: 200, body: {} };
  expect((await f.request("results", old.runtimeToken, old.epoch, reply)).status).toBe(401);
  expect(await f.bridge().result(f.people.owner, f.id, request.requestId)).toEqual({ state: "superseded" });
  expect((await f.bridge().next(current.runtimeToken, current.epoch)).command).toBeNull();
  // The old-epoch row may already have executed: this refusal must stay ambiguous, never a definite refusal.
  const resent = await f
    .bridge()
    .enqueue(f.people.owner, request)
    .catch((error: unknown) => error);
  expect(resent).toBeInstanceOf(Error);
  expect((resent as Error).message).toBe("runtime_command_conflict");
  expect(resent).not.toBeInstanceOf(RuntimeCommandRefused);
  expect(
    (await f.request("results", current.runtimeToken, current.epoch, { ...reply, epoch: current.epoch })).status,
  ).toBe(409);
  const healthPinnedCheck: RunnerRequest = {
    version: 1,
    sandboxId: f.id,
    requestId: "old-health-check",
    op: "testModelConnection",
    harness: "codex",
    model: "deployment",
  };
  // Fenced before any row is written: a definite refusal.
  await expect(f.bridge().enqueue(f.people.owner, healthPinnedCheck, old.epoch)).rejects.toBeInstanceOf(
    RuntimeCommandRefused,
  );
  expect(
    (await f.db.query("select request_id from runtime_commands where request_id='old-health-check'")).rows,
  ).toHaveLength(0);
  const fresh = f.command("after-resume");
  await f.bridge().enqueue(f.people.owner, fresh);
  expect(await f.bridge().next(current.runtimeToken, current.epoch)).toEqual({
    epoch: current.epoch,
    command: fresh,
  });
  await f.db.query("update sandboxes set stop_requested_at=now() where id=$1", [f.id]);
  expect((await f.request("poll", current.runtimeToken, current.epoch, { epoch: current.epoch })).status).toBe(401);
});

test("a checkpoint fences new exec work but an admitted exec replay stays unknown, then reconciles its stored reply", async () => {
  const f = await fixture();

  const active = await f.enrol();
  const agent = createRuntimeAgent(f.bridge(), {
    provider: "docker",
    harness: "codex",
    ownerId: f.people.owner,
    sandboxId: f.id,
    providerSandboxId: "physical",
    cwd: "/home/user",
    defaults: { model: "gpt-5.4", reasoningEffort: "high" },
  });
  // The public exec error path: runtime agent, then the shared control failure formatter.
  const exec = async (requestId: string) => {
    const response = await agent
      .exec({ sandboxId: "physical", command: "printf x > app.txt", timeoutSeconds: 1 }, requestId)
      .then((result) => Response.json(result))
      .catch(controlFailureResponse);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const unknown = { status: 503, body: { error: { code: "outcome_unknown" } } };
  // The original call admits the exec, then loses its reply.
  expect(await exec("exec-admitted")).toMatchObject(unknown);
  await f.db.query("insert into runtime_checkpoints(sandbox_id,epoch,request_id) values($1,$2,$3)", [
    f.id,
    active.epoch,
    crypto.randomUUID(),
  ]);
  // Replaying the admitted ID under the checkpoint is not a definite refusal: it may still run.
  expect(await exec("exec-admitted")).toMatchObject(unknown);
  // Once the runtime answers, the replay reconciles with the stored reply.
  const stored = { detached: false, exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
  expect(
    (
      await f.request("results", active.runtimeToken, active.epoch, {
        epoch: active.epoch,
        requestId: "exec-admitted",
        status: 200,
        body: { version: 1, requestId: "exec-admitted", result: stored },
      })
    ).status,
  ).toBe(200);
  expect(await exec("exec-admitted")).toMatchObject({ status: 200, body: { exitCode: 0, detached: false } });
  // New work is fenced before any row is written: a definite refusal.
  const refused = await exec("exec-new");
  expect(refused).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
  expect((await f.db.query("select 1 from runtime_commands where request_id='exec-new'")).rows).toHaveLength(0);
});

test("a held runtime poll returns a locally enqueued command with the clock frozen", async () => {
  const f = await fixture();
  const active = await f.enrol();
  const command = f.command("arrived-during-idle");
  const waiting = Promise.withResolvers<AbortSignal>();
  const delay = Promise.withResolvers<void>();
  const commands = f.bridge({
    now: () => 0,
    wait(_ms, signal) {
      signal.addEventListener("abort", () => delay.resolve(), { once: true });
      waiting.resolve(signal);
      return delay.promise;
    },
  });
  const poll = f.request("poll", active.runtimeToken, active.epoch, { epoch: active.epoch }, commands);
  const signal = await Promise.race([
    waiting.promise,
    poll.then(() => {
      throw new Error("Runtime poll returned before waiting");
    }),
  ]);
  try {
    await f.bridge().enqueue(f.people.owner, command);
    expect(signal.aborted).toBe(true);
  } finally {
    if (!signal.aborted) delay.reject(new Error("Runtime poll received no enqueue wake"));
  }
  const response = await poll;
  expect(await response.json()).toEqual({ epoch: active.epoch, command });
});

test("empty polls release the transaction while waiting and private routes/grants reject malformed authority", async () => {
  const f = await fixture();

  const active = await f.enrol();
  let time = 0;
  const waits: number[] = [];
  const commands = f.bridge({
    now: () => time,
    async wait(ms) {
      waits.push(ms);
      time += ms;
    },
  });
  const response = await f.request("poll", active.runtimeToken, active.epoch, { epoch: active.epoch }, commands);
  expect(await response.json()).toEqual({ epoch: active.epoch, command: null });
  expect(waits).toEqual(Array(20).fill(1000));
  expect((await f.request("poll", "invalid", active.epoch, { epoch: active.epoch })).status).toBe(401);
  expect((await f.request("poll", active.runtimeToken, active.epoch, { epoch: "wrong" })).status).toBe(409);
  for (const role of ["anon", "authenticated"]) {
    expect(
      (
        await f.db.query<{ allowed: boolean }>(
          "select has_table_privilege($1,'runtime_commands','select,insert,update,delete') as allowed",
          [role],
        )
      ).rows[0]?.allowed,
    ).toBe(false);
    expect(
      (
        await f.db.query<{ allowed: boolean }>(
          "select has_sequence_privilege($1,'runtime_commands_sequence_seq','usage,select,update') as allowed",
          [role],
        )
      ).rows[0]?.allowed,
    ).toBe(false);
  }
  expect(await f.bridge().route(new Request("https://armada.example/healthz"))).toBeNull();
  expect((await f.bridge().route(new Request("https://armada.example/api/runtime/poll")))?.status).toBe(405);
  const aborted = new AbortController();
  aborted.abort();
  expect(
    (
      await f.bridge().route(
        new Request("https://armada.example/api/runtime/poll", {
          method: "POST",
          signal: aborted.signal,
          headers: { authorization: `Bearer ${active.runtimeToken}`, "x-armada-runtime-epoch": active.epoch },
          body: JSON.stringify({ epoch: active.epoch }),
        }),
      )
    )?.status,
  ).toBe(499);
});

test.each(["maximum-frame"] as const)(
  "dialout client wire contract round-trips a real Runner response (%s)",
  async () => {
    const { RuntimeDialout } = await import("../../agent-runtime/src/dialout.ts");
    const { Journal, Runner } = await import("../../agent-runtime/src/index.ts");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const f = await fixture();
    const root = await mkdtemp(join(tmpdir(), "command-wire-"));
    const journal = new Journal(join(root, "journal"), (value) => value);
    const stop = new AbortController();
    try {
      await f.authority.issue({ ownerId: f.people.owner, sandboxId: f.id, configuration: {} });
      await f.db.query("update runtime_enrolments set epoch=9223372036854775805");
      const active = await f.enrol();
      const empty = {
        ...f.command("client-wire"),
        op: "prompt",
        input: { sandboxId: f.id, harness: "codex", text: "" },
      } as const;
      const rawBudget = 1048576 - Buffer.byteLength(JSON.stringify(empty));
      await expect(
        f.bridge().enqueue(f.people.owner, { ...empty, input: { ...empty.input, text: "x".repeat(rawBudget) } }),
      ).rejects.toThrow("runtime_command_conflict");
      const budget =
        1048576 - Buffer.byteLength(JSON.stringify({ type: "command", epoch: active.epoch, request: empty }));
      const command = { ...empty, input: { ...empty.input, text: "x".repeat(budget) } };
      const driver = {
        start() {
          return { done: Promise.resolve("finished" as const), async interrupt() {}, async steer() {} };
        },
        async close() {},
      };
      const runner = new Runner(
        journal,
        { token: active.runtimeToken, sandboxId: f.id, generation: active.epoch, expiresAt: Date.now() + 60000 },
        { codex: driver, claude: driver },
      );
      const channel = new RuntimeDialout("https://armada.example", active, {
        socket() {
          throw Error("upgrade rejected");
        },
        after() {
          throw Error("unexpected retry/idle wait");
        },
        every() {
          return () => {};
        },
        async fetch(url, options) {
          const response = await f.bridge().route(new Request(url.href, options));
          if (!response) throw Error("wire path mismatch");
          if (url.pathname.endsWith("/results")) stop.abort();
          return response;
        },
      });
      f.onWait(async () =>
        channel.run(
          (request) =>
            runner.handle(
              new Request("http://runtime/v1", {
                method: "POST",
                headers: { "x-armada-runner-grant": active.runtimeToken },
                body: JSON.stringify(request),
              }),
            ),
          stop.signal,
        ),
      );
      const result = await f.bridge().call(f.people.owner, command);
      expect(result).toMatchObject({
        epoch: active.epoch,
        requestId: command.requestId,
        status: 200,
        body: { result: { promptId: expect.any(String) } },
      });
    } finally {
      stop.abort();
      journal.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["timeout", "abort", "replacement", "stop"] as const)(
  "waiting caller preserves durable identity without replay on %s",
  async (scenario) => {
    const f = await fixture();

    const active = await f.enrol();
    const command = f.command(`waiting-${scenario}`);
    const abort = new AbortController();
    f.onWait(async () => {
      // A different replica sees the admitted request: waiting holds no locks.
      expect((await f.bridge().next(active.runtimeToken, active.epoch)).command).toEqual(command);
      if (scenario === "abort") abort.abort();
      if (scenario === "replacement") {
        // Simulate a remote commit followed by rotation before the local fallback tick.
        const staleReply = { epoch: active.epoch, requestId: command.requestId, status: 200, body: {} };
        await f.db.query("update runtime_commands set result_enc=$1 where sandbox_id=$2 and request_id=$3", [
          await encryptSecret(JSON.stringify(staleReply), ENCRYPTION_KEY),
          f.id,
          command.requestId,
        ]);
        await f.enrol();
        // Historical readback stays available, but it is not a current call reply.
        expect((await f.bridge().result(f.people.owner, f.id, command.requestId)).state).toBe("finished");
      }
      if (scenario === "stop") await f.db.query("update sandboxes set stop_requested_at=now() where id=$1", [f.id]);
    });
    await expect(f.bridge().call(f.people.owner, command, { signal: abort.signal, timeoutMs: 1000 })).rejects.toThrow(
      scenario === "timeout"
        ? "runtime_command_pending"
        : scenario === "replacement"
          ? "runtime_command_conflict"
          : scenario === "stop"
            ? "runtime_enrolment_denied"
            : "abort",
    );
    expect((await f.db.query("select request_id from runtime_commands")).rows).toEqual([
      { request_id: command.requestId },
    ]);
    if (scenario !== "timeout" && scenario !== "abort") return;
    // A lost/aborted HTTP wait is not proof of non-execution. Finish under the
    // original identity, then reconcile from another caller without a new turn.
    const reply = {
      epoch: active.epoch,
      requestId: command.requestId,
      status: 200,
      body: { result: { ready: true } },
    };
    await f.bridge().complete(active.runtimeToken, active.epoch, reply);
    expect(await f.bridge().call(f.people.owner, command)).toEqual(reply);
    expect((await f.bridge().next(active.runtimeToken, active.epoch)).command).toBeNull();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      f.bridge().call(f.people.owner, f.command("never-admitted"), { signal: cancelled.signal }),
    ).rejects.toThrow();
    expect((await f.db.query("select request_id from runtime_commands")).rows).toHaveLength(1);
  },
);

test("Codex agent bridge translates Boat identity and reconciles prompt/status/journal without native APIs", async () => {
  const { createRuntimeAgent } = await import("../src/runtime-agent.ts");
  const { Journal, Runner } = await import("../../agent-runtime/src/index.ts");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), "runtime-agent-"));
  const journal = new Journal(join(root, "journal"), (value) => value);
  try {
    const active = await f.enrol();
    const inputs: import("../../agent-runtime/src/protocol.ts").RuntimePromptRequest[] = [];
    const driver: import("../../agent-runtime/src/protocol.ts").Driver = {
      start(context) {
        inputs.push(context.request);
        context.session("native-session");
        context.emit({ kind: "message", text: "Armada answer", partial: false, tools: [], responseKind: "assistant" });
        return { done: Promise.resolve("finished"), async interrupt() {}, async steer() {} };
      },
      async close() {},
    };
    const runner = new Runner(
      journal,
      {
        token: active.runtimeToken,
        sandboxId: f.id,
        generation: active.epoch,
        expiresAt: Date.now() + 60000,
      },
      { codex: driver, claude: driver },
    );
    const serve = async () => {
      const pending = await f.bridge().next(active.runtimeToken, active.epoch);
      if (!pending.command) throw Error("missing admitted command");
      const response = await runner.handle(
        new Request("http://runtime/v1", {
          method: "POST",
          headers: { "x-armada-runner-grant": active.runtimeToken },
          body: JSON.stringify(pending.command),
        }),
      );
      const body = (await response.clone().json()) as { error?: unknown };
      if (pending.command.requestId === "second") expect(body).toEqual({ error: "native_auth_writer_busy" });
      expect(
        (
          await f.request("results", active.runtimeToken, active.epoch, {
            epoch: active.epoch,
            requestId: pending.command.requestId,
            status: response.status,
            body: await response.json(),
          })
        ).status,
      ).toBe(200);
    };
    const agent = createRuntimeAgent(f.bridge(), {
      harness: "codex",
      ownerId: f.people.owner,
      sandboxId: f.id,
      providerSandboxId: "bx-physical",
      cwd: root,
      defaults: { model: "gpt-5.4", reasoningEffort: "high" },
    });
    f.onWait(serve);
    expect(await agent.health()).toEqual({ runtime: "armada", epoch: active.epoch });
    const request = { sandboxId: "bx-physical", harness: "codex" as const, text: "answer", model: "gpt-5.4" };
    // Lose a caller's wait before execution. Identity in the safe error allows
    // reconciliation rather than minting another prompt after uncertain admission.
    let uncertain: import("@armada/core").ProviderError | undefined;
    try {
      await agent.prompt(request, "stable-first-prompt");
    } catch (error) {
      uncertain = error as import("@armada/core").ProviderError;
    }
    expect(uncertain?.details).toEqual({ runtimeRequestId: "stable-first-prompt", runtimeOutcome: "unknown" });
    expect(inputs).toHaveLength(0);
    f.onWait(serve);
    const receipt = await agent.prompt(request, "stable-first-prompt");
    expect(inputs).toEqual([
      {
        sandboxId: f.id,
        harness: "codex",
        text: "answer",
        model: "gpt-5.4",
        reasoningEffort: "high",
        cwd: root,
      },
    ]);
    expect(await agent.prompt(request, "stable-first-prompt")).toEqual(receipt);
    expect(inputs).toHaveLength(1);
    f.onWait(serve);
    expect(await agent.getPrompt({ sandboxId: "bx-physical", promptId: receipt.promptId })).toMatchObject({
      status: "finished",
      done: true,
    });
    f.onWait(serve);
    const page = await agent.events({ sandboxId: "bx-physical", conversationId: receipt.conversationId });
    expect(page.events.some((event) => event.kind === "message" && event.text === "Armada answer")).toBe(true);
    f.onWait(serve);
    expect(await agent.events({ sandboxId: "bx-physical", cursor: page.cursor ?? "0" })).toMatchObject({
      events: [],
      cursor: page.cursor,
      hasMore: false,
    });
    f.onWait(serve);
    await expect(agent.getPrompt({ sandboxId: "bx-physical", promptId: "missing" })).rejects.toMatchObject({
      provider: "boat",
      code: "not_found",
      retryable: false,
    });
    for (const refused of [
      () => agent.prompt({ ...request, sandboxId: "another-machine" }),
      () => agent.prompt({ ...request, harness: "claude" }),
      () => agent.events({ sandboxId: "bx-physical", direction: "backward" }),
      () => agent.events({ sandboxId: "bx-physical", limit: 0 }),
    ])
      await expect(refused()).rejects.toMatchObject({ code: "invalid_request" });
    expect(inputs).toHaveLength(1);
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

// A definite admission refusal must stay definite at the public bridge. The same request ID
// replays the stored 409, and neither response may claim an unknown outcome.
test("agent bridge preserves a definite native-auth admission refusal without uncertainty metadata", async () => {
  const { createRuntimeAgent } = await import("../src/runtime-agent.ts");
  const { Journal, Runner } = await import("../../agent-runtime/src/index.ts");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), "runtime-refusal-"));
  const journal = new Journal(join(root, "journal"), (value) => value);
  const held = Promise.withResolvers<"finished">();
  let runner!: InstanceType<typeof Runner>;
  try {
    const active = await f.enrol();
    const driver: import("../../agent-runtime/src/protocol.ts").Driver = {
      start(context) {
        context.session("native-session");
        return { done: held.promise, async interrupt() {}, async steer() {} };
      },
      async close() {},
    };
    runner = new Runner(
      journal,
      {
        token: active.runtimeToken,
        sandboxId: f.id,
        generation: active.epoch,
        expiresAt: Date.now() + 60000,
      },
      { codex: driver },
      undefined,
      undefined,
      undefined,
      { exclusiveNativeAuth: true },
    );
    const serve = async () => {
      const pending = await f.bridge().next(active.runtimeToken, active.epoch);
      if (!pending.command) throw Error("missing admitted command");
      const response = await runner.handle(
        new Request("http://runtime/v1", {
          method: "POST",
          headers: { "x-armada-runner-grant": active.runtimeToken },
          body: JSON.stringify(pending.command),
        }),
      );
      expect(
        (
          await f.request("results", active.runtimeToken, active.epoch, {
            epoch: active.epoch,
            requestId: pending.command.requestId,
            status: response.status,
            body: await response.json(),
          })
        ).status,
      ).toBe(200);
    };
    const agent = createRuntimeAgent(f.bridge(), {
      harness: "codex",
      ownerId: f.people.owner,
      sandboxId: f.id,
      providerSandboxId: "bx-physical",
      cwd: root,
      defaults: { model: "gpt-5.4", reasoningEffort: "high" },
    });
    f.onWait(serve);
    await agent.prompt({ sandboxId: "bx-physical", harness: "codex", text: "first" }, "first");
    const request = { sandboxId: "bx-physical", harness: "codex" as const, text: "second" };
    for (let attempt = 0; attempt < 2; attempt++) {
      f.onWait(serve);
      let failure: import("@armada/core").ProviderError | undefined;
      try {
        await agent.prompt(request, "second");
      } catch (error) {
        failure = error as import("@armada/core").ProviderError;
      }
      expect(failure).toMatchObject({ provider: "boat", code: "conflict", retryable: false });
      expect(failure?.details).toBeUndefined();
    }
  } finally {
    held.resolve("finished");
    await runner.close();
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["wrong-id", "unknown-error", "prototype-error", "stale-health"] as const)(
  "agent bridge refuses %s replies without reflecting private diagnostics",
  async (kind) => {
    const { createRuntimeAgent } = await import("../src/runtime-agent.ts");
    const agent = createRuntimeAgent(
      {
        async call(_owner, request) {
          return {
            epoch: "2",
            requestId: request.requestId,
            status: kind.endsWith("error") ? 409 : 200,
            body: kind.endsWith("error")
              ? { error: kind === "prototype-error" ? "constructor" : "private-diagnostic-marker" }
              : {
                  version: 1,
                  requestId: kind === "wrong-id" ? "foreign" : request.requestId,
                  result: { ready: true, generation: "1" },
                },
          };
        },
      },
      {
        harness: "codex",
        ownerId: "owner",
        sandboxId: "logical",
        providerSandboxId: "physical",
        cwd: "/project",
        defaults: { model: "gpt-5.4", reasoningEffort: "high" },
      },
    );
    let failure: unknown;
    try {
      if (kind === "stale-health") await agent.health();
      else await agent.prompt({ sandboxId: "physical", harness: "codex", text: "answer" }, "known-request");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      provider: "boat",
      retryable: false,
      code: kind === "stale-health" ? "sandbox_not_ready" : kind === "wrong-id" ? "unavailable" : "unknown",
    });
    expect(String(failure)).not.toContain("private-diagnostic-marker");
    if (kind !== "stale-health")
      expect(failure).toMatchObject({ details: { runtimeRequestId: "known-request", runtimeOutcome: "unknown" } });
  },
);

test("runtime startup privately issues configuration, awaits enrolment and fences actual Runner health", async () => {
  const { createRuntimeStartup } = await import("../src/runtime-startup.ts");
  const { createRuntimeAgent } = await import("../src/runtime-agent.ts");
  const { Journal, Runner } = await import("../../agent-runtime/src/index.ts");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), "runtime-startup-"));
  const journal = new Journal(join(root, "journal"), (value) => value);
  const logger = spyOn(console, "info");
  try {
    const previous = await f.enrol();
    const agent = createRuntimeAgent(f.bridge(), {
      harness: "codex",
      ownerId: f.people.owner,
      sandboxId: f.id,
      providerSandboxId: "command-native",
      cwd: root,
      defaults: { model: "gpt-5.4", reasoningEffort: "high" },
    });
    let bootstrapStart: unknown;
    let authenticatedEpoch: string | undefined;
    let token: string | undefined;
    let now = 0;
    const configuration = { selectedHarness: "codex", privateMarker: "startup-private-configuration" };
    const start = createRuntimeStartup(
      {
        ...f.authority,
        async issue(input) {
          const ticket = await f.authority.issue(input);
          now += 10;
          return ticket;
        },
      },
      {
        async bootstrap(input) {
          bootstrapStart = logger.mock.calls
            .map(([line]) => JSON.parse(String(line)))
            .find((entry) => entry.event === "armada.runtime.startup_phase" && entry.phase === "bootstrap");
          token = input.enrolmentToken;
          now += 40;
          expect(Object.keys(input).sort()).toEqual([
            "artifact",
            "cacheDir",
            "enrolmentToken",
            "sandboxId",
            "serverUrl",
          ]);
          expect(input.sandboxId).toBe("command-native");
          await expect(f.authority.withSession(previous.runtimeToken, previous.epoch, async () => {})).rejects.toThrow(
            "runtime_enrolment_denied",
          );
          const row = (
            await f.db.query<{ configuration_enc: Uint8Array }>("select configuration_enc from runtime_enrolments")
          ).rows[0];
          expect(Buffer.from(row?.configuration_enc ?? []).includes(Buffer.from(configuration.privateMarker))).toBe(
            false,
          );
        },
        async health(signal, epoch) {
          expect(authenticatedEpoch).toBe(epoch);
          now += 30;
          return agent.health(signal);
        },
      },
      {
        now: () => now,
        async wait() {
          now += 250;
          if (!token) throw Error("bootstrap did not hand off ticket");
          const enrolled = await f.authority.enrol(token);
          expect(enrolled.configuration).toEqual(configuration);
          const unused = {
            start() {
              throw Error("startup cannot start a turn");
            },
            async close() {},
          };
          const runner = new Runner(
            journal,
            {
              token: enrolled.runtimeToken,
              sandboxId: f.id,
              generation: enrolled.epoch,
              expiresAt: Date.now() + 60000,
            },
            { codex: unused, claude: unused },
          );
          f.onWait(async () => {
            const command = (await f.bridge().next(enrolled.runtimeToken, enrolled.epoch)).command;
            expect(command?.op).toBe("health");
            const response = await runner.handle(
              new Request("http://runtime/v1", {
                method: "POST",
                headers: { "x-armada-runner-grant": enrolled.runtimeToken },
                body: JSON.stringify(command),
              }),
            );
            await f.bridge().complete(enrolled.runtimeToken, enrolled.epoch, {
              epoch: enrolled.epoch,
              requestId: command?.requestId,
              status: response.status,
              body: await response.json(),
            });
          });
        },
      },
    );
    const requestId = crypto.randomUUID();
    expect(
      await continueRequest(requestId, () =>
        start({
          ownerId: f.people.owner,
          sandboxId: f.id,
          providerSandboxId: "command-native",
          serverUrl: "https://armada.invalid",
          cacheDir: "/home/user/.armada-bootstrap",
          artifact: { sha256: "a".repeat(64), bytes: 10 },
          configuration,
          onEnrolled: (epoch) => {
            authenticatedEpoch = epoch;
          },
        }),
      ),
    ).toEqual({ runtime: "armada", epoch: "2" });
    expect(bootstrapStart).toEqual({
      event: "armada.runtime.startup_phase",
      requestId,
      sandboxId: f.id,
      epoch: "2",
      phase: "bootstrap",
      elapsedMs: 10,
    });
    const samples = logger.mock.calls.flatMap(([line]) =>
      String(line).includes('"event":"armada.runtime.startup_timing"') ? [JSON.parse(String(line))] : [],
    );
    expect(samples).toEqual([
      {
        event: "armada.runtime.startup_timing",
        sandboxId: f.id,
        epoch: "2",
        stages: [
          { stage: "issue_ticket", ms: 10 },
          { stage: "bootstrap", ms: 40 },
          { stage: "enrolment_wait", ms: 250 },
          { stage: "health", ms: 30 },
        ],
      },
    ]);
    expect(journal.prompts()).toEqual([]);
  } finally {
    logger.mockRestore();
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("startup refuses a mismatched physical sandbox before replacing the live runtime", async () => {
  const { createRuntimeStartup } = await import("../src/runtime-startup.ts");
  const f = await fixture();
  const session = await f.enrol();
  const bootstrap = mock(async () => {
    throw Error("unexpected bootstrap");
  });
  const start = createRuntimeStartup(f.authority, {
    bootstrap,
    health: async () => {
      throw Error("unexpected health");
    },
  });

  await expect(
    start({
      ownerId: f.people.owner,
      sandboxId: f.id,
      providerSandboxId: "different-machine",
      serverUrl: "https://armada.invalid",
      cacheDir: "/cache",
      artifact: { sha256: "a".repeat(64), bytes: 10 },
      configuration: { selectedHarness: "codex" },
    }),
  ).rejects.toMatchObject({ code: "sandbox_not_ready" });
  expect(bootstrap).not.toHaveBeenCalled();
  expect(await f.authority.withSession(session.runtimeToken, session.epoch, async (_tx, scope) => scope.epoch)).toBe(
    session.epoch,
  );
});

test.each(["before issuance", "during issuance"] as const)(
  "queued startup stops when the claim expires %s",
  async (expiry) => {
    const { createRuntimeStartup } = await import("../src/runtime-startup.ts");
    const f = await fixture();
    const session = await f.enrol();
    let current = expiry !== "before issuance";
    const authority = createRuntimeEnrolments(
      {
        ...f.sql,
        transaction: (work) =>
          f.sql.transaction!((tx) =>
            work({
              ...tx,
              async query<T>(statement: string, values?: unknown[]) {
                const result = await tx.query<T>(statement, values);
                if (expiry === "during issuance" && statement.includes("insert into public.runtime_enrolments"))
                  current = false;
                return result;
              },
            }),
          ),
      },
      ENCRYPTION_KEY,
    );
    const bootstrap = mock(async () => {
      throw Error("unexpected bootstrap");
    });
    const start = createRuntimeStartup(authority, {
      bootstrap,
      health: async () => {
        throw Error("unexpected health");
      },
    });

    const startup = {
      ownerId: f.people.owner,
      sandboxId: f.id,
      providerSandboxId: "command-native",
      serverUrl: "https://armada.invalid",
      cacheDir: "/cache",
      artifact: { sha256: "a".repeat(64), bytes: 10 },
      configuration: { selectedHarness: "codex" },
      async assertClaim() {
        if (!current) throw Error("queued claim expired");
      },
    };
    await expect(start(startup)).rejects.toMatchObject({ code: "sandbox_not_ready" });
    expect(bootstrap).not.toHaveBeenCalled();
    const ticket = await f.db.query<{ pending: boolean }>(
      "select enrolment_hash is not null as pending from runtime_enrolments where sandbox_id=$1",
      [f.id],
    );
    expect(ticket.rows).toEqual([{ pending: false }]);
    expect(await f.authority.withSession(session.runtimeToken, session.epoch, async (_tx, scope) => scope.epoch)).toBe(
      session.epoch,
    );
  },
);

const startupFailures = [
  "selection",
  "pre-abort",
  "timeout",
  "bootstrap",
  "replacement",
  "lifecycle",
  "stop",
  "claim loss",
] as const;

test.each([...startupFailures])(
  "startup never publishes readiness after %s and never repeats host bootstrap",
  async (scenario) => {
    const { createRuntimeStartup } = await import("../src/runtime-startup.ts");
    const f = await fixture();

    let starts = 0,
      now = 0;
    const abort = new AbortController();
    if (scenario === "pre-abort") abort.abort();
    let epoch = "";
    let current = true;
    let checkedAfterHealthInTransaction = false;
    const start = createRuntimeStartup(
      f.authority,
      {
        async bootstrap(input) {
          starts++;
          if (scenario === "bootstrap") throw Error("private-bootstrap-diagnostic");
          if (scenario !== "timeout" && scenario !== "lifecycle")
            epoch = (await f.authority.enrol(input.enrolmentToken)).epoch;
        },
        async health() {
          if (scenario === "claim loss") current = false;
          if (scenario === "replacement") await f.enrol();
          if (scenario === "stop") await f.db.query("update sandboxes set stop_requested_at=now() where id=$1", [f.id]);
          return { runtime: "armada", epoch };
        },
      },
      {
        now: () => now,
        async wait() {
          if (scenario === "lifecycle" && now === 0) {
            await f.db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [f.id]);
            epoch = (await f.enrol()).epoch;
          }
          now += 250;
        },
      },
    );
    const pending = start({
      ownerId: f.people.owner,
      sandboxId: f.id,
      providerSandboxId: "command-native",
      serverUrl: "https://armada.invalid",
      cacheDir: "/cache",
      artifact: { sha256: "a".repeat(64), bytes: 10 },
      configuration: { selectedHarness: scenario === "selection" ? "unknown" : "codex" },
      ...(scenario === "claim loss"
        ? {
            async assertClaim(tx?: Sql) {
              if (current) return;
              checkedAfterHealthInTransaction = tx !== undefined;
              throw Error("Dispatch claim expired.");
            },
          }
        : {}),
      signal: abort.signal,
      readinessTimeoutMs: 1000,
    });
    await expect(pending).rejects.toMatchObject({
      provider: "boat",
      code: scenario === "selection" ? "invalid_request" : "sandbox_not_ready",
      retryable: false,
      message:
        scenario === "selection"
          ? "Invalid runtime startup selection."
          : `Armada runtime startup failed (${["pre-abort", "bootstrap"].includes(scenario) ? "bootstrap" : ["timeout", "lifecycle"].includes(scenario) ? "enrolment" : "readiness"}).`,
    });
    if (scenario === "claim loss") expect(checkedAfterHealthInTransaction).toBe(true);
    expect(starts).toBe(scenario === "pre-abort" || scenario === "selection" ? 0 : 1);
    if (scenario === "pre-abort" || scenario === "selection")
      expect((await f.db.query("select sandbox_id from runtime_enrolments")).rows).toEqual([]);
  },
);

test("only private launch workspace commands admit the native ten-minute step budget", async () => {
  const f = await fixture(),
    active = await f.enrol(),
    bridge = f.bridge();
  await expect(bridge.call(f.people.owner, f.command("no-long-health"), { timeoutMs: 610000 })).rejects.toThrow(
    "runtime_command_conflict",
  );
  const wire: RunnerRequest = {
    ...f.command("workspace-long"),
    op: "workspaceExec",
    input: { command: "true", cwd: "/home/user", timeoutSeconds: 600, phase: "init", index: 0, attempt: 0 },
  };
  f.onWait(async () => {
    expect(
      await (await f.request("poll", active.runtimeToken, active.epoch, { epoch: active.epoch })).json(),
    ).toMatchObject({ command: wire });
    expect(
      (
        await f.request("results", active.runtimeToken, active.epoch, {
          epoch: active.epoch,
          requestId: wire.requestId,
          status: 200,
          body: {
            version: 1,
            requestId: wire.requestId,
            result: { exitCode: 0, detached: false, stdout: "", stderr: "" },
          },
        })
      ).status,
    ).toBe(200);
  });
  expect(await bridge.call(f.people.owner, wire, { timeoutMs: 610000, expectedEpoch: active.epoch })).toMatchObject({
    epoch: active.epoch,
    body: { result: { exitCode: 0 } },
  });
});

test("bound model check uses enrolled health and exact epoch, never destinations or native fallback", async () => {
  const { createRuntimeAgent } = await import("../src/runtime-agent.ts");
  const calls: RunnerRequest[] = [];
  let result: unknown = { ok: true, status: 200, error: null, code: null };
  const controller = new AbortController();
  const agent = createRuntimeAgent(
    {
      async call(owner, command, options) {
        expect(owner).toBe("owner");
        expect(options?.signal).toBe(controller.signal);
        expect(options?.expectedEpoch).toBe(command.op === "health" ? undefined : "7");
        calls.push(command);
        return {
          status: 200,
          epoch: "7",
          requestId: command.requestId,
          body: {
            version: 1,
            requestId: command.requestId,
            result: command.op === "health" ? { ready: true, generation: "7" } : result,
          },
        };
      },
    },
    {
      provider: "boat",
      harness: "codex",
      ownerId: "owner",
      sandboxId: "logical",
      providerSandboxId: "physical",
      cwd: "/home/user",
      defaults: { model: "gpt-6.1-sol", reasoningEffort: "medium" },
    },
  );
  const input = { sandboxId: "physical", harness: "codex" as const, model: "deployment", signal: controller.signal };
  await expect(agent.testModelConnection({ ...input, sandboxId: "other" })).rejects.toMatchObject({
    code: "invalid_request",
  });
  await expect(agent.testModelConnection({ ...input, harness: "claude" })).rejects.toMatchObject({
    code: "invalid_request",
  });
  expect(calls).toHaveLength(0);
  expect(await agent.testModelConnection(input)).toEqual({ ok: true, status: 200, error: null, code: null });
  expect(calls.map((command) => command.op)).toEqual(["health", "testModelConnection"]);
  expect(calls[1]).toEqual({
    version: 1,
    sandboxId: "logical",
    requestId: expect.any(String),
    op: "testModelConnection",
    harness: "codex",
    model: "deployment",
  });
  result = { ok: false, status: 401, error: "provider_rejected", code: "private_key_echo" };
  let failure: unknown;
  try {
    await agent.testModelConnection(input);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ provider: "boat", code: "unavailable" });
  expect(String(failure)).not.toContain("private_key_echo");
});

function webhookAttempts(sql: Sql, sandboxId: string) {
  const worker = createOutboundWebhooks(sql, "invalid_key", "https://armada.example", {
    now: () => Date.UTC(2030, 0, 1),
  });
  const store = createJobsStore(sql);
  const owner = crypto.randomUUID();
  return async () => {
    const { rows } = await sql.query(
      `update jobs j set run_after=now() from outbound_webhook_deliveries d
       where j.id=d.id and j.kind='webhook' and j.state='queued'
         and d.payload->>'sandboxId'=$1 and d.attempts=0 returning j.id`,
      [sandboxId],
    );
    for (const _ of rows) {
      const job = (await store.claim("webhook", owner, 30, 1))!;
      const result = await worker.run(job, {
        signal: new AbortController().signal,
        canDispatch: async () => (await store.inspect(job, owner)) === "dispatch",
      });
      expect(await store.complete(job, owner, result)).toBe(true);
    }
  };
}

test("cancelled queued runtime turns defer webhooks until the first durable command reply preserves their alias", async () => {
  const f = await fixture();
  const active = await f.enrol();
  // Invalid encryption prevents any network send after a claim, while the
  // attempts counter proves whether admission happened before alias readiness.
  const tryDeliveries = webhookAttempts(f.sql, f.id);
  await f.db.query(
    "insert into outbound_webhook_endpoints(org_id,url,secret_enc) values($1,'https://receiver.example/events',$2)",
    [f.people.org, new Uint8Array([1])],
  );
  for (const prefix of ["follow_", "docker_prompt_", "resume_"]) {
    const publicId = crypto.randomUUID();
    const nativeId = `native_${prefix}`;
    const command = {
      ...f.command(`${prefix}${publicId}`),
      op: "prompt",
      input: { sandboxId: f.id, harness: "codex", text: "queued_prompt" },
    } as const;
    await f.db.query(
      `insert into account_turn_queue(sandbox_id,request_id,account_id,owner_id,org_id,
        actor_epoch,credential_version,input_hash,input_enc,conversation_id,state,dispatch_generation)
       select s.id,$2,c.id,s.owner_id,s.org_id,1,c.version,'input_hash',$3,'conversation','dispatching',s.lifecycle_generation
       from sandboxes s join credentials c on c.owner_id=s.org_id and c.kind='openai'
       where s.id=$1 limit 1`,
      [f.id, publicId, new Uint8Array([1])],
    );
    await f.bridge().enqueue(f.people.owner, command);
    await f.db.query("select enqueue_webhook_turn($1,$2,'finished')", [f.id, nativeId]);
    await tryDeliveries();
    await f.db.query("update account_turn_queue set state='failed',failure_reason='cancelled' where request_id=$1", [
      publicId,
    ]);
    await tryDeliveries();
    expect(
      (
        await f.db.query<{ attempts: number }>(
          "select attempts from outbound_webhook_deliveries where payload->>'promptId'=$1",
          [nativeId],
        )
      ).rows,
    ).toEqual([{ attempts: 0 }]);
    const reply = {
      epoch: active.epoch,
      requestId: command.requestId,
      status: 200,
      body: { result: { promptId: nativeId } },
    };
    await f.bridge().complete(active.runtimeToken, active.epoch, reply);
    await f.bridge().complete(active.runtimeToken, active.epoch, {
      ...reply,
      body: { result: { promptId: "changed_replay" } },
    });
    expect(
      (await f.db.query("select state,native_prompt_id from account_turn_queue where request_id=$1", [publicId])).rows,
    ).toEqual([{ state: "failed", native_prompt_id: nativeId }]);
    await tryDeliveries();
    expect(
      (
        await f.db.query<{ attempts: number }>(
          "select attempts from outbound_webhook_deliveries where payload->>'promptId'=$1",
          [nativeId],
        )
      ).rows,
    ).toEqual([{ attempts: 1 }]);
  }
});

test("a superseded unfinished queued command cannot hold stop or later turn webhooks", async () => {
  const f = await fixture();
  await f.enrol();
  // Invalid encryption prevents network I/O. A recorded attempt proves dispatch.
  const tryDeliveries = webhookAttempts(f.sql, f.id);
  await f.db.query(
    "insert into outbound_webhook_endpoints(org_id,url,secret_enc) values($1,'https://receiver.example/events',$2)",
    [f.people.org, new Uint8Array([1])],
  );
  const publicId = crypto.randomUUID();
  await f.db.query(
    `insert into account_turn_queue(sandbox_id,request_id,account_id,owner_id,org_id,
      actor_epoch,credential_version,input_hash,input_enc,conversation_id,state,dispatch_generation)
     select s.id,$2,c.id,s.owner_id,s.org_id,1,c.version,'input_hash',$3,'conversation','failed',s.lifecycle_generation
     from sandboxes s join credentials c on c.owner_id=s.org_id and c.kind='openai'
     where s.id=$1 limit 1`,
    [f.id, publicId, new Uint8Array([1])],
  );
  await f.bridge().enqueue(f.people.owner, {
    ...f.command(`follow_${publicId}`),
    op: "prompt",
    input: { sandboxId: f.id, harness: "codex", text: "queued_prompt" },
  } as RunnerRequest);
  const attempts = async () =>
    (
      await f.db.query<{ type: string; attempts: number }>(
        "select payload->>'type' as type,attempts from outbound_webhook_deliveries where payload->>'sandboxId'=$1 order by type",
        [f.id],
      )
    ).rows;
  await f.db.query("select enqueue_webhook_turn($1,'native_uncertain','finished')", [f.id]);
  // While the reply can still arrive, the alias may still be published.
  await tryDeliveries();
  expect(await attempts()).toEqual([{ type: "turn.finished", attempts: 0 }]);
  await f.enrol();
  expect(await f.bridge().result(f.people.owner, f.id, `follow_${publicId}`)).toEqual({ state: "superseded" });
  await f.db.query("select enqueue_webhook_turn($1,'native_later','finished')", [f.id]);
  await f.db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [f.id]);
  await tryDeliveries();
  expect(await attempts()).toEqual([
    { type: "sandbox.stopped", attempts: 1 },
    { type: "turn.finished", attempts: 1 },
    { type: "turn.finished", attempts: 1 },
  ]);
});

test.each(["accepted", "rejected"] as const)(
  "a %s well-formed runtime reply is recorded under the request ID with the caller's own validation",
  async (kind) => {
    const { createRuntimeAgent } = await import("../src/runtime-agent.ts");
    const f = await fixture();
    const session = await f.enrol();
    const runtime = f.bridge();
    const answer = (result: unknown) =>
      f.onWait(async () => {
        const { command } = await runtime.next(session.runtimeToken, session.epoch);
        if (!command) throw Error("missing_command");
        await runtime.complete(session.runtimeToken, session.epoch, {
          epoch: session.epoch,
          requestId: command.requestId,
          status: 200,
          body: { version: 1, requestId: command.requestId, result },
        });
      });
    const agent = createRuntimeAgent(runtime, {
      provider: "boat",
      harness: "codex",
      ownerId: f.people.owner,
      sandboxId: f.id,
      providerSandboxId: "command-native",
      cwd: "/home/user",
      defaults: { model: "gpt-5.4", reasoningEffort: "high" },
    });
    const health = { ready: true, generation: session.epoch, ...(kind === "accepted" ? { workspaceVersion: 1 } : {}) };
    const exec = kind === "accepted" ? { detached: false, exitCode: 0, stdout: "", stderr: "" } : { detached: false };
    const failures: unknown[] = [];
    const lines: string[] = [];
    const response = await observeRequest(
      async () => {
        answer(health);
        await agent.workspaceHealth(session.epoch).catch((error) => failures.push(error));
        answer(exec);
        await agent
          .workspaceExec(
            { sandboxId: "command-native", command: "true" },
            { phase: "init", index: 0, attempt: 0 },
            session.epoch,
          )
          .catch((error) => failures.push(error));
        // A caller-supplied receipt check (as resume uses) also decides the recorded outcome.
        answer({ conversationId: kind === "accepted" ? "thread" : "foreign", promptId: "prompt-1" });
        await agent
          .prompt(
            { sandboxId: "command-native", harness: "codex", text: "continue" },
            undefined,
            session.epoch,
            (r) => {
              if (r.conversationId !== "thread") throw Error("caller-conflict");
            },
          )
          .catch((error) => failures.push(error));
        return new Response(null, { status: 204 });
      },
      (line) => lines.push(line),
    );
    // The public errors are unchanged; only the trace now agrees with them.
    if (kind === "rejected")
      expect(failures).toEqual([
        Error("Runtime workspace setup requires updated runtime artifacts; no native fallback."),
        expect.objectContaining({ code: "unavailable" }),
        Error("caller-conflict"),
      ]);
    else expect(failures).toEqual([]);
    const outcome = kind === "accepted" ? "ok" : "error";
    expect(lines.map((line) => JSON.parse(line)).filter((event) => event.event === "provider_call")).toEqual([
      expect.objectContaining({
        requestId: response?.headers.get("x-request-id"),
        operation: "runtime.health",
        outcome,
      }),
      expect.objectContaining({
        requestId: response?.headers.get("x-request-id"),
        operation: "runtime.workspaceExec",
        outcome,
      }),
      expect.objectContaining({
        requestId: response?.headers.get("x-request-id"),
        operation: "runtime.prompt",
        outcome,
      }),
    ]);
  },
);

test("a retried runtime command answered by its stored reply records no second provider call", async () => {
  const f = await fixture();
  const active = await f.enrol();
  const command = f.command("retried-reply");
  f.onWait(async () => {
    await f.bridge().complete(active.runtimeToken, active.epoch, {
      epoch: active.epoch,
      requestId: command.requestId,
      status: 200,
      body: { version: 1, requestId: command.requestId, result: {} },
    });
  });
  const calls = async () => {
    const lines: Record<string, unknown>[] = [];
    let reply: unknown;
    await observeRequest(
      async () => {
        reply = await f.bridge().call(f.people.owner, command);
        return new Response(null, { status: 204 });
      },
      (line) => lines.push(JSON.parse(line)),
    );
    return { reply, records: lines.filter((line) => line.event === "provider_call") };
  };
  const first = await calls();
  expect(first.records).toEqual([expect.objectContaining({ operation: `runtime.${command.op}`, outcome: "ok" })]);
  const retried = await calls();
  expect(retried.reply).toEqual(first.reply);
  expect(retried.records).toEqual([]);
});

test("a command answered before its first result read still records the fenced admission, unlike a later replay", async () => {
  const f = await fixture();
  const active = await f.enrol();
  const command = f.command("fast-reply");
  const runtime = f.bridge();
  const observed = async (work: () => Promise<unknown>) => {
    const lines: Record<string, unknown>[] = [];
    let reply: unknown;
    const response = await observeRequest(
      async () => {
        reply = await work();
        return new Response(null, { status: 204 });
      },
      (line) => lines.push(JSON.parse(line)),
    );
    return {
      reply,
      requestId: response?.headers.get("x-request-id"),
      records: lines.filter((line) => line.event === "provider_call"),
    };
  };
  // Callers admit under their own fenced transaction, then wait outside it. The runner answers in between.
  const first = await observed(() =>
    runtime.callPrepared(f.people.owner, command.op, async () => {
      await runtime.enqueue(f.people.owner, command);
      const { command: delivered } = await runtime.next(active.runtimeToken, active.epoch);
      expect(delivered?.requestId).toBe(command.requestId);
      await runtime.complete(active.runtimeToken, active.epoch, {
        epoch: active.epoch,
        requestId: command.requestId,
        status: 200,
        body: { version: 1, requestId: command.requestId, result: {} },
      });
      return { request: command, options: {} };
    }),
  );
  expect(first.records).toEqual([
    expect.objectContaining({ requestId: first.requestId, operation: `runtime.${command.op}`, outcome: "ok" }),
  ]);
  // A later request with the same identity is answered from the database: no provider record.
  const replay = await observed(() =>
    runtime.callPrepared(f.people.owner, command.op, async () => {
      const { fresh } = await runtime.enqueue(f.people.owner, command);
      expect(fresh).toBe(false);
      return { request: command, options: {} };
    }),
  );
  expect(replay.reply).toEqual(first.reply);
  expect(replay.records).toEqual([]);
});

function bootstrapFailureRequest(token: string) {
  return new Request("https://armada.test/api/runtime/progress", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ stage: "bootstrap_failed" }),
  });
}

test("bootstrap failure journals one transition and refuses progress authenticated against a stale generation", async () => {
  const f = await fixture();
  const { enrolmentToken } = await f.authority.issue({ ownerId: f.people.owner, sandboxId: f.id, configuration: {} });
  const request = () => bootstrapFailureRequest(enrolmentToken);
  const stale = createRuntimeProgress({
    ...f.authority,
    withBootstrap: (token, work) =>
      f.authority.withBootstrap(token, (tx, scope, generation) => work(tx, scope, String(BigInt(generation) + 1n))),
  });
  const journal = () =>
    f.db.query("select from_status,to_status,code from sandbox_transitions where sandbox_id=$1", [f.id]);
  expect((await stale(request()))?.status).toBe(401);
  expect((await journal()).rows).toEqual([]);
  expect((await f.db.query("select status from sandboxes where id=$1", [f.id])).rows).toEqual([{ status: "ready" }]);

  const report = createRuntimeProgress(f.authority);
  expect((await report(request()))?.status).toBe(200);
  expect((await report(request()))?.status).toBe(401);
  expect((await journal()).rows).toEqual([{ from_status: "ready", to_status: "failed", code: "bootstrap_failed" }]);
});

test("a failed reason write rolls back the bootstrap status change and journal", async () => {
  const f = await fixture();
  const { enrolmentToken } = await f.authority.issue({ ownerId: f.people.owner, sandboxId: f.id, configuration: {} });
  const report = createRuntimeProgress(f.authority);
  await f.db.exec(
    `alter table sandboxes add constraint fixture_reject_bootstrap_reason
     check (status_reason is distinct from 'Armada runtime bootstrap failed.') not valid`,
  );
  try {
    expect((await report(bootstrapFailureRequest(enrolmentToken)))?.status).toBe(400);
    expect((await f.db.query("select status,status_reason from sandboxes where id=$1", [f.id])).rows).toEqual([
      { status: "ready", status_reason: null },
    ]);
    expect((await f.db.query("select id from sandbox_transitions where sandbox_id=$1", [f.id])).rows).toEqual([]);
  } finally {
    await f.db.exec("alter table sandboxes drop constraint fixture_reject_bootstrap_reason");
  }
  expect((await report(bootstrapFailureRequest(enrolmentToken)))?.status).toBe(200);
});

test("authenticated boot and turn diagnostics retain their initiating request IDs and sanitized stack", async () => {
  const f = await fixture();
  const records: Record<string, unknown>[] = [];
  const log = (line: string) => records.push(JSON.parse(line));
  let grant: Awaited<ReturnType<typeof f.enrol>> | undefined;
  const launch = await observeRequest(async () => {
    grant = await f.enrol();
    return new Response(null, { status: 204 });
  }, log);
  if (!grant) throw Error("Missing runtime grant");
  const { runtimeToken, epoch } = grant;
  const commandId = "follow_progress_fixture";
  const command = {
    version: 1 as const,
    sandboxId: f.id,
    requestId: commandId,
    op: "prompt" as const,
    input: { sandboxId: f.id, harness: "codex" as const, text: "fixture prompt" },
  };
  const accept = () =>
    observeRequest(async () => {
      await f.bridge().enqueue(f.people.owner, command);
      return new Response(null, { status: 204 });
    }, log);
  const send = await accept();
  const replay = await accept();
  expect(replay?.headers.get("x-request-id")).not.toBe(send?.headers.get("x-request-id"));
  const route = createRuntimeProgress(f.authority);
  const report = (body: unknown) =>
    observeRequest(
      async () =>
        (await route(
          new Request("https://armada.test/api/runtime/progress", {
            method: "POST",
            headers: { authorization: `Bearer ${runtimeToken}`, "x-armada-runtime-epoch": epoch },
            body: JSON.stringify(body),
          }),
        )) ?? undefined,
      log,
    );
  const error = new Error("private_config_canary");
  error.stack +=
    "\n    at main (/private_config_canary/runtime/main.js:701:12)\n    at /$bunfs/root/armada-runtime:801:19";
  const diagnostic = runtimeOperatorDiagnostic(error, "session_start_failed");
  const unrelated = await report({ stage: "harness_turn_failed", commandId: "foreign_command", diagnostic });
  expect(unrelated?.status).toBe(400);
  const harness = await report({ stage: "harness_turn_failed", commandId, diagnostic });
  expect(harness?.status).toBe(200);
  const boot = await report({ stage: "runtime_failed", reason: "artifact_preparation" });
  expect(boot?.status).toBe(200);
  expect(records.filter((record) => record.event === "operator_failure")).toMatchObject([
    {
      phase: "runtime.harness_turn_failed",
      errorClass: "HarnessError",
      message: "session_start_failed",
      stack: ["main.js:701:12", "armada-runtime:801:19"],
      requestId: send?.headers.get("x-request-id"),
      sandboxId: f.id,
    },
    {
      phase: "runtime.boot",
      message: "artifact_preparation",
      requestId: launch?.headers.get("x-request-id"),
      sandboxId: f.id,
    },
  ]);
  expect(
    (await f.db.query("select from_status,to_status,code from sandbox_transitions where sandbox_id=$1", [f.id])).rows,
  ).toEqual([{ from_status: "ready", to_status: "failed", code: "artifact_preparation" }]);
  expect(JSON.stringify(records)).not.toContain("private_config_canary");
  expect((await f.db.query("select status,status_reason from sandboxes where id=$1", [f.id])).rows).toEqual([
    {
      status: "failed",
      status_reason:
        "Runtime artifact preparation failed. Ask the server operator to check published harness artifacts and container filesystem access before launching again.",
    },
  ]);
});

test("workspace health diagnostics distinguish delivery, acknowledgement, and replay", async () => {
  const f = await fixture(54_000);
  const active = await f.enrol();
  const bridge = f.bridge();
  const requestId = `workspace_health_${crypto.randomUUID()}_${active.epoch}`;
  const info = spyOn(console, "info");
  try {
    f.onWait(async () => {
      const poll = await f.request("poll", active.runtimeToken, active.epoch, { epoch: active.epoch }, bridge);
      expect(await poll.json()).toMatchObject({ command: { requestId } });
      const reply = await f.request(
        "results",
        active.runtimeToken,
        active.epoch,
        {
          epoch: active.epoch,
          requestId,
          status: 200,
          body: { version: 1, requestId, result: { privateValue: "not-for-logs" } },
        },
        bridge,
      );
      expect(reply.status).toBe(200);
    });
    await bridge.call(f.people.owner, f.command(requestId), { expectedEpoch: active.epoch });
    const lines = info.mock.calls
      .map(([line]) => JSON.parse(line))
      .filter((entry) => entry.event === "runtime_workspace_command" && entry.commandId === requestId);
    expect(lines.map(({ stage }) => stage)).toEqual(["admitted", "sent_poll", "result_acknowledged", "observed"]);
    expect(lines.at(-1)).toMatchObject({ sandboxId: f.id, epoch: active.epoch, observedAtMs: 54_000, resultReads: 1 });
    expect(JSON.stringify(lines)).not.toContain("not-for-logs");
    info.mockClear();
    await bridge.call(f.people.owner, f.command(requestId), { expectedEpoch: active.epoch });
    expect(info.mock.calls.map(([line]) => JSON.parse(line).stage)).toEqual(["admission_replayed", "observed"]);
  } finally {
    info.mockRestore();
  }
});

test("callCommand watches before enqueue, polls non-lockingly, and startup wakes on enrolment", async () => {
  const f = await fixture(250);
  const active = await f.enrol();
  let ownerLocks = 0;
  let waitCalls = 0;
  const origWithOwner = f.authority.withOwner;
  const authority = {
    ...f.authority,
    withOwner: ((...args: Parameters<typeof origWithOwner>) => {
      ownerLocks++;
      return origWithOwner(...args);
    }) as typeof origWithOwner,
  };
  let now = 0;
  const bridge = createRuntimeCommands(authority, ENCRYPTION_KEY, {
    now: () => now,
    async wait() {
      waitCalls++;
      now += 250;
      if (waitCalls !== 2) return;
      const { command } = await bridge.next(active.runtimeToken, active.epoch);
      await bridge.complete(active.runtimeToken, active.epoch, {
        epoch: active.epoch,
        requestId: command!.requestId,
        status: 200,
        body: { version: 1, requestId: command!.requestId, result: { ok: true } },
      });
    },
  });
  expect((await bridge.call(f.people.owner, f.command("wake-first"), { expectedEpoch: active.epoch })).status).toBe(
    200,
  );
  expect([waitCalls, ownerLocks]).toEqual([2, 2]);
  ownerLocks = 0;
  const { runtimeWakes } = await import("../src/wake-bus.ts");
  const unsub = runtimeWakes.subscribe(`socket:${f.id}`, () => {
    void bridge.complete(active.runtimeToken, active.epoch, {
      epoch: active.epoch,
      requestId: "instant-reply",
      status: 200,
      body: { version: 1, requestId: "instant-reply", result: { ok: true } },
    });
  });
  try {
    const fast = createRuntimeCommands(authority, ENCRYPTION_KEY, {
      now: () => now,
      wait: () => new Promise<void>(() => {}),
    });
    expect((await fast.call(f.people.owner, f.command("instant-reply"), { expectedEpoch: active.epoch })).status).toBe(
      200,
    );
    expect(ownerLocks).toBe(2);
  } finally {
    unsub();
  }
  const { createRuntimeStartup } = await import("../src/runtime-startup.ts");
  let token: string | undefined;
  const enteredWait = Promise.withResolvers<void>();
  const start = createRuntimeStartup(
    f.authority,
    {
      async bootstrap(input) {
        token = input.enrolmentToken;
      },
      health: async (_signal, epoch) => ({ runtime: "armada", epoch }),
    },
    {
      now: () => 0,
      wait() {
        enteredWait.resolve();
        return new Promise<void>(() => {});
      },
    },
  );
  const pending = start({
    ownerId: f.people.owner,
    sandboxId: f.id,
    providerSandboxId: "command-native",
    serverUrl: "https://armada.invalid",
    cacheDir: "/cache",
    artifact: { sha256: "a".repeat(64), bytes: 10 },
    configuration: { selectedHarness: "codex" },
  });
  await enteredWait.promise;
  const enrolled = await f.authority.enrol(token!);
  expect(await pending).toEqual({ runtime: "armada", epoch: enrolled.epoch });
});

test("call fails fast with RuntimeEnrolmentDenied when org membership is revoked mid-wait", async () => {
  const f = await fixture(250);
  const active = await f.enrol();
  const orgId = (await f.db.query<{ org_id: string }>("select org_id from public.sandboxes where id=$1", [f.id]))
    .rows[0]!.org_id;
  let now = 0;
  let waits = 0;
  const bridge = createRuntimeCommands(f.authority, ENCRYPTION_KEY, {
    now: () => now,
    async wait() {
      waits++;
      now += 250;
      if (waits === 1) {
        await f.db.query("delete from public.members where org_id=$1 and user_id=$2", [orgId, f.people.owner]);
      }
    },
  });
  try {
    await expect(
      bridge.call(f.people.owner, f.command("revoked-mid-wait"), { expectedEpoch: active.epoch, timeoutMs: 30_000 }),
    ).rejects.toBeInstanceOf(RuntimeEnrolmentDenied);
    expect(waits).toBe(1);
  } finally {
    await f.db.query(
      "insert into public.members(org_id,user_id,role) values($1,$2,'member') on conflict (org_id,user_id) do nothing",
      [orgId, f.people.owner],
    );
  }
});
