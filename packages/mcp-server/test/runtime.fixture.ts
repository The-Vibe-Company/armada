import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Driver, HarnessState, Journal, Runner, type RunnerRequest } from "@armada/agent-runtime";
import { encryptSecret, type Harness, type Sql } from "@armada/core/server";
import { insertSandboxFixture } from "../../core/test/sandbox.fixture.ts";
import { createSqlData } from "../src/data.ts";
import { createRuntimeAgent } from "../src/runtime-agent.ts";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { createRuntimeFollowup } from "../src/runtime-followup.ts";
import type { ToolContext } from "../src/tools.ts";
import { closeableFixture } from "./closeable.fixture.ts";
import { database, ENCRYPTION_KEY, type People } from "./support.ts";

export function scopedRuntimeFixture<T extends { close(): Promise<void> }>(
  setup: () => Promise<T>,
  { timeout, perTest }: { timeout?: number; perTest?: boolean } = {},
) {
  const fixture = closeableFixture(setup);
  const before = perTest ? beforeEach : beforeAll;
  const after = perTest ? afterEach : afterAll;
  before(fixture.setup, timeout);
  after(fixture.close);
  return async () => fixture.get();
}

export async function configureRuntimeFixture<T>(
  fixture: Awaited<ReturnType<typeof runtimeFixture>>,
  configure: () => Promise<T>,
) {
  try {
    return await configure();
  } catch (error) {
    try {
      await fixture.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Runtime fixture configuration and cleanup failed");
    }
    throw error;
  }
}

export async function runtimeFixtureGolden(
  db: Awaited<ReturnType<typeof database>>["db"],
  people: People,
  provider: "boat" | "modal",
) {
  if (provider === "boat") {
    const { rows } = await db.query<{ id: string }>(
      "select id from goldens where org_id=$1 and visibility='org' and provider='boat'",
      [people.org],
    );
    return rows[0]!.id;
  }
  const { rows } = await db.query<{ id: string }>(
    `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
    values($1,$2,'modal-checkpoint','org','modal','master','image','workspace','main','app','{"repos":[],"init":[]}') returning id`,
    [people.org, people.owner],
  );
  return rows[0]!.id;
}

export async function runtimeFixture(
  fixture?: Awaited<ReturnType<typeof database>>,
  provider: "boat" | "modal" = "boat",
  harness: Harness = "codex",
  idle = false,
  commandGrantExpiresAt?: number,
  placement?: { goldenId: string; providerSandboxId: string },
) {
  await using setup = new AsyncDisposableStack();
  const { db, people } = fixture ?? (await database());
  if (!fixture) setup.defer(() => db.close());
  const root = await mkdtemp(join(tmpdir(), "runtime-followup-"));
  setup.defer(() => rm(root, { recursive: true, force: true }));
  let journal = new Journal(join(root, "journal"), (value) => value);
  setup.defer(() => journal.close());
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const caller = {
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" as const }],
    via: "service" as const,
  };
  if (harness === "opencode")
    await db.query("insert into credentials(scope,owner_id,kind,value_enc) values('org',$1,'opencode',$2)", [
      people.org,
      await encryptSecret("offline-opencode-key", ENCRYPTION_KEY),
    ]);
  if (harness === "antigravity")
    await db.query("insert into credentials(scope,owner_id,kind,value_enc) values('org',$1,'antigravity',$2)", [
      people.org,
      await encryptSecret('{"method":"gemini-api-key","apiKey":"fixture-gemini"}', ENCRYPTION_KEY),
    ]);
  const defaults =
    harness === "opencode"
      ? { model: "opencode/fixture", reasoningEffort: "default" }
      : harness === "antigravity"
        ? { model: "default", reasoningEffort: "default" }
        : { model: "gpt-5.4", reasoningEffort: "high" };
  const account = (
    await db.query<{ id: string; version: number }>(
      "select id,version from credentials where kind=$2::public.credential_kind and owner_id=$1",
      [people.org, harness === "claude" ? "claude_oauth" : harness === "codex" ? "openai" : harness],
    )
  ).rows[0]!;
  const goldenId = placement?.goldenId ?? (await runtimeFixtureGolden(db, people, provider));
  const providerSandboxId = placement?.providerSandboxId ?? "physical";
  const row = await insertSandboxFixture(sql, {
    id: crypto.randomUUID(),
    provider,
    providerSandboxId,
    goldenId,
    orgId: people.org,
    ownerId: people.owner,
    harness,
    status: "ready",
    visibility: "org",
    ...defaults,
    ...(provider === "boat" ? { boatRuntime: true as const } : { modalTransport: "dialout" as const }),
    credentialId: account.id,
    credentialVersion: account.version,
  });
  const authority = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
  let active = await authority.enrol(
    (
      await authority.issue({
        sandboxId: row.id,
        ownerId: people.owner,
        configuration: {},
        ...(commandGrantExpiresAt === undefined ? {} : { commandGrantExpiresAt }),
      })
    ).enrolmentToken,
  );
  const starts: (string | undefined)[] = [];
  const mcpSnapshots: (import("@armada/agent-runtime").McpConfiguration | undefined)[] = [];
  let dropReplyFor: RunnerRequest["op"] | undefined;
  let eventsBeforePromptReply = false;
  let lost = false,
    now = 0;
  let nextDone: Promise<"finished" | "interrupted"> | undefined;
  let checkpointFault: "generation" | "prefix" | "ack" | undefined;
  let afterProbe: (() => Promise<void>) | undefined;
  const refused = new Set<RunnerRequest["op"]>();
  let githubConfiguration:
    | ((value: import("@armada/core").GitHubRuntimeConfiguration | null) => Promise<void>)
    | undefined;
  const driver: Driver = {
    start(context) {
      starts.push(context.sessionId);
      mcpSnapshots.push(context.mcp);
      context.session("native-thread");
      const done = nextDone ?? Promise.resolve("finished" as const);
      nextDone = undefined;
      return {
        done,
        async steer() {},
        async interrupt() {},
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
    expiresAt: commandGrantExpiresAt ?? Date.now() + 60_000,
  };
  let state = new HarnessState(root, (value) => value);
  await state.restore(grant, journal.assertRestoreSource(grant));
  let runner = new Runner(
    journal,
    grant,
    { codex: driver, claude: driver, opencode: driver },
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
      const wire: RunnerRequest =
        command.op === "prompt" ? { ...command, input: { ...command.input, cwd: root } } : command;
      const reply = await runner.handle(
        new Request("http://runtime/v1", {
          method: "POST",
          headers: { "x-armada-runner-grant": active.runtimeToken },
          body: JSON.stringify(wire),
        }),
      );
      if (eventsBeforePromptReply && command.op === "prompt") await runner.flushOutbox();
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
      if (dropReplyFor === command.op) {
        dropReplyFor = undefined;
        throw Error("Guest reply lost before completion");
      }
      const replyAuthority: typeof authority = {
        ...authority,
        async withSession(token, epoch, work, source) {
          const receipt = await authority.withSession(token, epoch, work, source);
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
          return receipt;
        },
      };
      await createRuntimeCommands(replyAuthority, ENCRYPTION_KEY).complete(active.runtimeToken, active.epoch, {
        epoch: active.epoch,
        requestId: command.requestId,
        status: refused.has(command.op) ? 503 : reply.status,
        body: responseBody,
      });
    },
  });
  const agent = createRuntimeAgent(bridge, {
    harness,
    ownerId: people.owner,
    sandboxId: row.id,
    providerSandboxId,
    cwd: root,
    defaults,
  });
  const first = idle ? undefined : await agent.prompt({ sandboxId: providerSandboxId, harness, text: "initial" });
  if (first)
    await db.query(
      "update sandboxes set status='running',task_prompt_id=$2,conversation_ids=array[$3]::text[] where id=$1",
      [row.id, first.promptId, first.conversationId],
    );
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
  });
  const resources = setup.move();
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
    get first() {
      if (!first) throw Error("Idle fixture has no initial prompt receipt");
      return first;
    },
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
    async reboot(
      restore: { epoch: string; watermark: number; conversationId: string | null },
      attest = true,
      enrolmentToken?: string,
    ) {
      await runner.flushOutbox().catch(() => {});
      journal.close();
      active = await authority.enrol(
        enrolmentToken ??
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
        { codex: driver, claude: driver, opencode: driver },
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
      if (attest && restore.conversationId !== null) {
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
              input: { sandboxId: row.id, harness, ...defaults, cwd: root },
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
    hold(done: Promise<"finished" | "interrupted">) {
      nextDone = done;
    },
    race(work: () => Promise<void>) {
      afterProbe = work;
    },
    refuse(op: RunnerRequest["op"]) {
      refused.add(op);
    },
    deliverPromptEventsBeforeReply() {
      eventsBeforePromptReply = true;
    },
    dropReplyOnce(op: RunnerRequest["op"]) {
      dropReplyFor = op;
    },
    lose() {
      lost = true;
    },
    async close() {
      await runner.flushOutbox().catch(() => {});
      await resources.disposeAsync();
    },
  };
}
