import { expect, test } from "bun:test";
import type { RunnerRequest } from "@armada/agent-runtime";
import type { Sql } from "@armada/core/server";
import { createOutboundWebhooks } from "../src/outbound-webhooks.ts";
import { createRuntimeCommands, RuntimeCommandRefused } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

async function fixture() {
  const { db, people } = await sharedDatabase();
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status)
    select $1,id,org_id,owner_id,'command-native','codex','ready' from goldens where owner_id=$2 and visibility='private' limit 1`,
    [id, people.owner],
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
    async wait() {
      const callback = waiting;
      waiting = undefined;
      await callback?.();
      now += 20000;
    },
  };
  const bridge = () => createRuntimeCommands(authority, ENCRYPTION_KEY, clock);
  const enrol = async () =>
    authority.enrol(
      (await authority.issue({ ownerId: people.owner, sandboxId: id, configuration: {} })).enrolmentToken,
    );
  const command = (requestId: string): RunnerRequest => ({ version: 1, sandboxId: id, requestId, op: "health" });
  const request = async (path: string, token: string, epoch: string, body: unknown) => {
    const response = await bridge().route(
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
  const reply = {
    epoch: active.epoch,
    requestId: first.requestId,
    status: 200,
    body: { requestId: first.requestId, result: { marker: "private-result-marker" } },
  };
  expect(await (await f.request("results", active.runtimeToken, active.epoch, reply)).json()).toEqual({
    epoch: active.epoch,
    requestId: first.requestId,
  });
  expect(
    (
      await f.request("results", active.runtimeToken, active.epoch, {
        ...reply,
        body: { error: "late replay must not overwrite" },
      })
    ).status,
  ).toBe(200);
  expect(await f.bridge().result(f.people.owner, f.id, first.requestId)).toEqual({ state: "finished", reply });
  const sealed = (
    await f.db.query<{ result_enc: Uint8Array }>("select result_enc from runtime_commands where request_id='z-first'")
  ).rows[0];
  expect(Buffer.from(sealed?.result_enc ?? []).includes(Buffer.from("private-result-marker"))).toBe(false);
  expect(await (await poll()).json()).toEqual({ epoch: active.epoch, command: last });
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

test("empty polls release the transaction while waiting and private routes/grants reject malformed authority", async () => {
  const f = await fixture();

  const active = await f.enrol();
  const response = await f.request("poll", active.runtimeToken, active.epoch, { epoch: active.epoch });
  expect(await response.json()).toEqual({ epoch: active.epoch, command: null });
  f.onWait(async () => {
    await f.bridge().enqueue(f.people.owner, f.command("arrived-during-idle"));
  });
  const awakened = await f.request("poll", active.runtimeToken, active.epoch, { epoch: active.epoch });
  expect(await awakened.json()).toEqual({ epoch: active.epoch, command: f.command("arrived-during-idle") });
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

test.each(["health", "maximum-frame"] as const)(
  "dialout client wire contract round-trips a real Runner response (%s)",
  async (kind) => {
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
      if (kind === "maximum-frame") {
        await f.authority.issue({ ownerId: f.people.owner, sandboxId: f.id, configuration: {} });
        await f.db.query("update runtime_enrolments set epoch=9223372036854775805");
      }
      const active = await f.enrol();
      let command = f.command("client-wire");
      if (kind === "maximum-frame") {
        const empty = { ...command, op: "prompt", input: { sandboxId: f.id, harness: "codex", text: "" } } as const;
        const rawBudget = 1048576 - Buffer.byteLength(JSON.stringify(empty));
        await expect(
          f.bridge().enqueue(f.people.owner, { ...empty, input: { ...empty.input, text: "x".repeat(rawBudget) } }),
        ).rejects.toThrow("runtime_command_conflict");
        const budget =
          1048576 - Buffer.byteLength(JSON.stringify({ type: "command", epoch: active.epoch, request: empty }));
        command = { ...empty, input: { ...empty.input, text: "x".repeat(budget) } };
      }
      const driver = {
        start() {
          if (kind === "health") throw Error("health must not start a harness");
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
      if (kind === "maximum-frame") {
        expect(result).toMatchObject({
          epoch: active.epoch,
          requestId: command.requestId,
          status: 200,
          body: { result: { promptId: expect.any(String) } },
        });
        return;
      }
      expect(result).toMatchObject({
        epoch: active.epoch,
        requestId: command.requestId,
        status: 200,
        body: { result: { generation: active.epoch, ready: true } },
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
        await f.bridge().complete(active.runtimeToken, active.epoch, {
          epoch: active.epoch,
          requestId: command.requestId,
          status: 200,
          body: {},
        });
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
  try {
    const previous = await f.enrol();
    const agent = createRuntimeAgent(f.bridge(), {
      harness: "codex",
      ownerId: f.people.owner,
      sandboxId: f.id,
      providerSandboxId: "physical",
      cwd: root,
      defaults: { model: "gpt-5.4", reasoningEffort: "high" },
    });
    let token: string | undefined;
    let now = 0;
    const configuration = { selectedHarness: "codex", privateMarker: "startup-private-configuration" };
    const start = createRuntimeStartup(
      f.authority,
      {
        async bootstrap(input) {
          token = input.enrolmentToken;
          expect(Object.keys(input).sort()).toEqual([
            "artifact",
            "cacheDir",
            "enrolmentToken",
            "sandboxId",
            "serverUrl",
          ]);
          expect(input.sandboxId).toBe("physical");
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
        health: (signal) => agent.health(signal),
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
    expect(
      await start({
        ownerId: f.people.owner,
        sandboxId: f.id,
        providerSandboxId: "physical",
        serverUrl: "https://armada.invalid",
        cacheDir: "/home/user/.armada-bootstrap",
        artifact: { sha256: "a".repeat(64), bytes: 10 },
        configuration,
      }),
    ).toEqual({ runtime: "armada", epoch: "2" });
    expect(journal.prompts()).toEqual([]);
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["selection", "pre-abort", "timeout", "bootstrap", "replacement", "lifecycle", "stop"] as const)(
  "startup never publishes readiness after %s and never repeats host bootstrap",
  async (scenario) => {
    const { createRuntimeStartup } = await import("../src/runtime-startup.ts");
    const f = await fixture();

    let starts = 0,
      now = 0;
    const abort = new AbortController();
    if (scenario === "pre-abort") abort.abort();
    let epoch = "";
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
      providerSandboxId: "physical",
      serverUrl: "https://armada.invalid",
      cacheDir: "/cache",
      artifact: { sha256: "a".repeat(64), bytes: 10 },
      configuration: { selectedHarness: scenario === "selection" ? "unknown" : "codex" },
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

test("cancelled queued runtime turns defer webhooks until the first durable command reply preserves their alias", async () => {
  const f = await fixture();
  const active = await f.enrol();
  const sql: Sql = { query: (q, p) => f.db.query(q, p) };
  // Invalid encryption prevents any network send after a claim, while the
  // attempts counter proves whether admission happened before alias readiness.
  const worker = createOutboundWebhooks(sql, "invalid_key", "https://armada.example");
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
    expect(await worker.reconcileOne(new AbortController().signal)).toBe(false);
    await f.db.query("update account_turn_queue set state='failed',failure_reason='cancelled' where request_id=$1", [
      publicId,
    ]);
    expect(await worker.reconcileOne(new AbortController().signal)).toBe(false);
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
    expect(await worker.reconcileOne(new AbortController().signal)).toBe(true);
    expect(
      (
        await f.db.query<{ attempts: number }>(
          "select attempts from outbound_webhook_deliveries where payload->>'promptId'=$1",
          [nativeId],
        )
      ).rows,
    ).toEqual([{ attempts: 1 }]);
    // Isolate each prefix from already-failed delivery retries.
    await f.db.query("delete from outbound_webhook_deliveries");
  }
});

test("a superseded unfinished queued command cannot hold stop or later turn webhooks", async () => {
  const f = await fixture();
  await f.enrol();
  const sql: Sql = { query: (q, p) => f.db.query(q, p) };
  // Invalid encryption prevents any network send; a claim (true) proves admission.
  const worker = createOutboundWebhooks(sql, "invalid_key", "https://armada.example");
  await f.db.query("delete from outbound_webhook_deliveries");
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
  expect(await worker.reconcileOne(new AbortController().signal)).toBe(false);
  await f.enrol();
  expect(await f.bridge().result(f.people.owner, f.id, `follow_${publicId}`)).toEqual({ state: "superseded" });
  await f.db.query("select enqueue_webhook_turn($1,'native_later','finished')", [f.id]);
  await f.db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [f.id]);
  while (await worker.reconcileOne(new AbortController().signal));
  expect(await attempts()).toEqual([
    { type: "sandbox.stopped", attempts: 1 },
    { type: "turn.finished", attempts: 1 },
    { type: "turn.finished", attempts: 1 },
  ]);
  await f.db.query("delete from outbound_webhook_deliveries");
});

test.each(["accepted", "rejected"] as const)(
  "a %s well-formed runtime reply is recorded under the request ID with the caller's own validation",
  async (kind) => {
    const { createRuntimeAgent } = await import("../src/runtime-agent.ts");
    const { observeRequest } = await import("../src/request-observability.ts");
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
  const { observeRequest } = await import("../src/request-observability.ts");
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
  const { observeRequest } = await import("../src/request-observability.ts");
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
  const first = await observed(async () => {
    const { fresh } = await runtime.enqueue(f.people.owner, command);
    const { command: delivered } = await runtime.next(active.runtimeToken, active.epoch);
    expect(delivered?.requestId).toBe(command.requestId);
    await runtime.complete(active.runtimeToken, active.epoch, {
      epoch: active.epoch,
      requestId: command.requestId,
      status: 200,
      body: { version: 1, requestId: command.requestId, result: {} },
    });
    return runtime.call(f.people.owner, command, { admitted: fresh });
  });
  expect(first.records).toEqual([
    expect.objectContaining({ requestId: first.requestId, operation: `runtime.${command.op}`, outcome: "ok" }),
  ]);
  // A later request with the same identity is answered from the database: no provider record.
  const replay = await observed(async () => {
    const { fresh } = await runtime.enqueue(f.people.owner, command);
    expect(fresh).toBe(false);
    return runtime.call(f.people.owner, command, { admitted: fresh });
  });
  expect(replay.reply).toEqual(first.reply);
  expect(replay.records).toEqual([]);
});
