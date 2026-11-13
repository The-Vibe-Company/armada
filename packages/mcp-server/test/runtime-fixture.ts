import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Driver, HarnessState, Journal, Runner, type RunnerRequest } from "@armada/agent-runtime";
import { createSqlSandboxStore, type Sql } from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { createRuntimeAgent } from "../src/runtime-agent.ts";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { createRuntimeFollowup } from "../src/runtime-followup.ts";
import type { ToolContext } from "../src/tools.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

/** Caller-supplied seeded rows stay caller-owned; journal/outbox/root cleanup always stays here. */
export async function runtimeFixture(
  fixture?: Awaited<ReturnType<typeof database>>,
  provider: "boat" | "modal" = "boat",
  harness: "codex" | "claude" = "codex",
) {
  const { db, people } = fixture ?? (await database());
  const root = await mkdtemp(join(tmpdir(), "runtime-followup-"));
  let journal = new Journal(join(root, "journal"), (value) => value);
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const caller = {
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" as const }],
    via: "service" as const,
  };
  const account = (
    await db.query<{ id: string; version: number }>(
      "select id,version from credentials where kind=$2::public.credential_kind and owner_id=$1",
      [people.org, harness === "claude" ? "claude_oauth" : "openai"],
    )
  ).rows[0]!;
  let golden = (
    await db.query<{ id: string }>("select id from goldens where org_id=$1 and visibility='org'", [people.org])
  ).rows[0]!;
  if (provider === "modal")
    golden = (
      await db.query<{ id: string }>(
        `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
    values($1,$2,'modal-checkpoint','org','modal','master','image','workspace','main','app','{"repos":[],"init":[]}') returning id`,
        [people.org, people.owner],
      )
    ).rows[0]!;
  const row = await createSqlSandboxStore(sql).insert({
    id: crypto.randomUUID(),
    provider,
    providerSandboxId: "physical",
    goldenId: golden.id,
    orgId: people.org,
    ownerId: people.owner,
    harness,
    status: "ready",
    visibility: "org",
    model: "gpt-5.4",
    reasoningEffort: "high",
    ...(provider === "boat" ? { boatRuntime: true as const } : { runtimeTransport: "dialout" as const }),
    credentialId: account.id,
    credentialVersion: account.version,
  });
  const authority = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
  let active = await authority.enrol(
    (await authority.issue({ sandboxId: row.id, ownerId: people.owner, configuration: {} })).enrolmentToken,
  );
  const starts: (string | undefined)[] = [];
  const mcpSnapshots: (import("@armada/agent-runtime").McpConfiguration | undefined)[] = [];
  let lost = false,
    now = 0;
  let nextDone: Promise<"finished" | "interrupted"> | undefined;
  let checkpointFault: "generation" | "prefix" | "ack" | undefined;
  let afterProbe: (() => Promise<void>) | undefined;
  let githubConfiguration:
    | ((value: import("@armada/core").GitHubRuntimeConfiguration | null) => Promise<void>)
    | undefined;
  let nextInterrupt: (() => void) | undefined;
  const driver: Driver = {
    start(context) {
      starts.push(context.sessionId);
      mcpSnapshots.push(context.mcp);
      context.session("native-thread");
      const done = nextDone ?? Promise.resolve("finished" as const);
      nextDone = undefined;
      const interrupt = nextInterrupt;
      nextInterrupt = undefined;
      return {
        done,
        async steer() {},
        async interrupt() {
          interrupt?.();
        },
      };
    },
    async resumeSession(context) {
      return { sessionId: context.sessionId };
    },
    async close() {},
  };
  const grant = {
    sandboxId: row.id,
    generation: active.epoch,
    token: active.runtimeToken,
    expiresAt: Date.now() + 60000,
  };
  let state = new HarnessState(root, (value) => value);
  await state.restore(grant, journal.assertRestoreSource(grant));
  let runner = new Runner(
    journal,
    grant,
    { codex: driver, claude: driver },
    {
      async append(batch) {
        const reply = await createRuntimeEvents(authority, ENCRYPTION_KEY).append(
          active.runtimeToken,
          active.epoch,
          batch,
        );
        if (!("acknowledgedSequence" in reply)) throw Error("wrong ACK");
        return reply;
      },
    },
    undefined,
    async () => {
      await state.checkpoint(grant);
      journal.sanitize();
    },
    {
      configureGitHub: (value) =>
        githubConfiguration
          ? githubConfiguration(value)
          : value
            ? Promise.reject(Error("GitHub not configured in fixture"))
            : Promise.resolve(),
    },
  );
  const bridge = createRuntimeCommands(authority, ENCRYPTION_KEY, {
    now: () => now,
    async wait() {
      now++;
      const command = (await bridge.next(active.runtimeToken, active.epoch)).command;
      if (!command) throw Error("Expected a durable command, not a timer wait");
      // Fake guest mount maps /home/user to the fixture home; all request identity,
      // Runner/session/journal/SQL/epoch behavior remains real. No host/provider I/O.
      const wire: RunnerRequest =
        command.op === "prompt" ? { ...command, input: { ...command.input, cwd: root } } : command;
      const reply = await runner.handle(
        new Request("http://runtime/v1", {
          method: "POST",
          headers: { "x-armada-runner-grant": active.runtimeToken },
          body: JSON.stringify(wire),
        }),
      );
      const responseBody = (await reply.json()) as {
        result?: { watermark: number; acknowledgedSequence: number; generation: string };
      };
      if (command.op === "checkpoint" && checkpointFault && responseBody.result) {
        if (checkpointFault === "generation") responseBody.result.generation = "999";
        if (checkpointFault === "prefix") {
          responseBody.result.watermark++;
          responseBody.result.acknowledgedSequence++;
        }
        if (checkpointFault === "ack") responseBody.result.acknowledgedSequence--;
      }
      await bridge.complete(active.runtimeToken, active.epoch, {
        epoch: active.epoch,
        requestId: command.requestId,
        status: reply.status,
        body: responseBody,
      });
      if (afterProbe && command.op === "getPrompt") {
        const competing = afterProbe;
        afterProbe = undefined;
        await competing();
      }
      if (
        lost &&
        command.op === "prompt" &&
        (command.requestId.startsWith("follow_") || command.requestId.startsWith("resume_"))
      ) {
        lost = false;
        throw Error("lost_wait_after_commit");
      }
    },
  });
  const agent = createRuntimeAgent(bridge, {
    harness,
    ownerId: people.owner,
    sandboxId: row.id,
    providerSandboxId: "physical",
    cwd: root,
    defaults: { model: "gpt-5.4", reasoningEffort: "high" },
  });
  const first = await agent.prompt({ sandboxId: "physical", harness, text: "initial" });
  await createSqlData(sql)(caller).sandboxes.update(row.id, {
    status: "running",
    taskPromptId: first.promptId,
    conversationIds: [first.conversationId],
  });
  await runner.flushOutbox();
  const send = createRuntimeFollowup(sql, ENCRYPTION_KEY, bridge);
  const context: ToolContext = {
    caller,
    data: createSqlData(sql)(caller),
    runtimeSend: send,
    async provider() {
      throw Error("No host/native provider resolution");
    },
    launchCredentials: {
      async resolve() {
        throw Error("No native credential hooks");
      },
    },
    async exposedSecrets() {
      throw Error("No native secret reads");
    },
    now: () => new Date(),
    async sleep() {
      throw Error("No wall-clock sleeps");
    },
  };
  const input = (prompt = "follow-up") => ({
    id: row.id,
    prompt,
    request_id: crypto.randomUUID(),
    conversation_id: first.conversationId,
  });
  return {
    root,
    mcpSnapshots,
    db,
    people,
    sql,
    caller,
    row,
    account,
    get active() {
      return active;
    },
    starts,
    first,
    get runner() {
      return runner;
    },
    get journal() {
      return journal;
    },
    authority,
    bridge,
    send,
    context,
    input,
    async reboot(restore: { epoch: string; watermark: number; conversationId: string }, attest = true) {
      await runner.flushOutbox().catch(() => {});
      journal.close();
      active = await authority.enrol(
        (await authority.issue({ sandboxId: row.id, ownerId: people.owner, configuration: {} })).enrolmentToken,
      );
      journal = new Journal(join(root, "journal"), (value) => value);
      const next = {
        sandboxId: row.id,
        generation: active.epoch,
        token: active.runtimeToken,
        expiresAt: Date.now() + 60000,
      };
      const source = { sandboxId: row.id, generation: restore.epoch };
      journal.requireCheckpoint(source, restore.watermark, restore.conversationId);
      state = new HarnessState(root, (value) => value);
      await state.restore(next, journal.assertRestoreSource(next), source);
      runner = new Runner(
        journal,
        next,
        { codex: driver, claude: driver },
        {
          async append(batch) {
            const result = await createRuntimeEvents(authority, ENCRYPTION_KEY).append(
              active.runtimeToken,
              active.epoch,
              batch,
            );
            if (!("acknowledgedSequence" in result)) throw Error("missing ACK");
            return result;
          },
        },
        undefined,
        async () => {
          await state.checkpoint(next);
          journal.sanitize();
        },
        {
          ...(attest ? { restoredFrom: restore } : {}),
          configureGitHub: (value) =>
            githubConfiguration
              ? githubConfiguration(value)
              : value
                ? Promise.reject(Error("GitHub not configured in fixture"))
                : Promise.resolve(),
        },
      );
      if (attest) {
        const response = await runner.handle(
          new Request("http://runtime/v1", {
            method: "POST",
            headers: { "x-armada-runner-grant": next.token },
            body: JSON.stringify({
              version: 1,
              sandboxId: row.id,
              requestId: `restore_${active.epoch}`,
              op: "resumeNativeSession",
              conversationId: restore.conversationId,
              expectedSessionId: journal.session(restore.conversationId),
              input: { sandboxId: row.id, harness, model: "gpt-5.4", reasoningEffort: "high", cwd: root },
            }),
          }),
        );
        if (response.status !== 200) throw Error("native restore preflight failed");
      }
      return { epoch: active.epoch };
    },
    github(handler: (value: import("@armada/core").GitHubRuntimeConfiguration | null) => Promise<void>) {
      githubConfiguration = handler;
    },
    tamper(mode: "generation" | "prefix" | "ack") {
      checkpointFault = mode;
    },
    hold(done: Promise<"finished" | "interrupted">, interrupt?: () => void) {
      nextDone = done;
      nextInterrupt = interrupt;
    },
    race(work: () => Promise<void>) {
      afterProbe = work;
    },
    lose() {
      lost = true;
    },
    async close() {
      await runner.flushOutbox().catch(() => {});
      journal.close();
      if (!fixture) await db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
