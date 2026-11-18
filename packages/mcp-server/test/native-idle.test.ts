import { expect, test } from "bun:test";
import type { Provider, SandboxInfo, Sql } from "@armada/core";
import { createSqlVaultStore, encryptSecret } from "@armada/core/server";
import { createAccountTurnQueue } from "../src/account-turn-queue.ts";
import { createSqlData } from "../src/data.ts";
import { nativeQuiescent } from "../src/native-idle.ts";
import { createSandboxLifecycle } from "../src/sandbox-lifecycle.ts";
import { createSandboxPullRequests } from "../src/sandbox-pull-requests.ts";
import { callSharedTool } from "../src/tool-api.ts";
import {
  lostConfirmation,
  recreatedAtFetchedCommit,
  rejectedRecreation,
  unrecordedUrlPush,
} from "./push-ledger-git.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { bunLikeSql, ENCRYPTION_KEY } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();
async function fixture(mode = "quiet") {
  const { db, people } = await sharedDatabase();
  const sql = bunLikeSql(db);
  const caller = {
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" as const }],
    via: "service" as const,
  };
  const data = createSqlData(sql)(caller);
  const placement = mode === "modal-retry" || mode === "owner-modal" ? "modal" : "boat";
  const golden =
    placement === "boat"
      ? (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0]!
      : { id: crypto.randomUUID() };
  if (placement === "modal")
    await db.query(
      `insert into goldens(id,org_id,owner_id,name,visibility,provider,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
    values($1,$2,$3,'native-modal-idle','org','modal','image','workspace','main','app','{}'::jsonb)`,
      [golden.id, people.org, people.owner],
    );
  const id = crypto.randomUUID(),
    physical = placement === "boat" ? "bx_23456789" : "native-modal",
    task = "turn";
  const at = Date.now();
  let phase = "active",
    nonactiveObservations = 0;
  let clock = at + 599_999,
    stopped = false,
    stops = 0,
    promptCalls = 0,
    observations = 0;
  const credential = (
    await db.query<{ id: string }>(
      "select id from credentials where scope='user' and owner_id=$1 and kind='claude_oauth'",
      [people.owner],
    )
  ).rows[0]!;
  await data.sandboxes.insert({
    id,
    goldenId: golden.id,
    orgId: people.org,
    ownerId: people.owner,
    credentialId: credential.id,
    credentialVersion: 1,
    provider: placement,
    providerSandboxId: physical,
    harness: "claude",
    status: "running",
    model: "claude-sonnet-5",
    reasoningEffort: "high",
    expiresAt: new Date(at + 3_600_000).toISOString(),
    effectiveTtlSeconds: 3600,
  });
  await data.sandboxes.update(id, { taskPromptId: task, conversationIds: ["conversation"] });
  const provider = {
    id: placement,
    observeOrchestrator: async () => {
      if (phase !== "active") {
        nonactiveObservations++;
        throw Error("Native observation requires active phase");
      }
      return {
        physicalGeneration: "1",
        state: "quiescent",
        eventWatermark: 1,
        acknowledgedSequence: 1,
        evidence: "f".repeat(64),
        nativeSessionId: "native",
      };
    },
    get: async (): Promise<SandboxInfo> => ({
      id: physical,
      state: stopped ? "stopped" : phase === "active" ? "running" : "stopping",
      createdAt: new Date(at),
      name: "native",
      providerState: phase,
      ...(placement === "modal" ? { physicalGeneration: "1" } : {}),
      ...(stopped && mode === "lost-retention" ? { stopNote: "checkpoint_failed_disk_not_retained" as const } : {}),
      labels: {},
    }),
    getPrompt: async () => ({
      promptId: task,
      status: mode === "running-turn" ? "running" : "finished",
      done: mode !== "running-turn",
    }),
    conversations:
      mode === "missing-port"
        ? undefined
        : async () => {
            observations++;
            return [
              { id: "conversation", running: mode === "active" || (mode === "becomes-active" && observations > 2) },
            ];
          },
    events: async () => {
      if (mode === "raced")
        await db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [id]);
      return {
        events:
          mode === "missing-event"
            ? []
            : [
                {
                  id: "event",
                  promptId: task,
                  conversationId: "conversation",
                  kind: "prompt",
                  text: "done",
                  status: "finished",
                  at,
                },
              ],
        hasMore: false,
      };
    },
    quiesce: async () => {
      if (mode.startsWith("owner-")) return;
      throw Error("Idle policy must never interrupt/quiesce native work");
    },
    interrupt: async () => {
      throw Error("Idle policy must never interrupt native work");
    },
    exec: async () => ({
      detached: false,
      exitCode: 0,
      timedOut: false,
      truncated: false,
      stdout: '{"status":"clean"}',
      stderr: "",
    }),
    stop: async (request: { requireRetention?: boolean }) => {
      if (!mode.startsWith("owner-")) expect(request.requireRetention).toBe(true);
      stops++;
      if (mode === "modal-retry" && stops === 1) {
        phase = "checkpoint";
        throw Error("checkpoint reply lost");
      }
      stopped = true;
      phase = "stopped";
    },
    prompt: async () => {
      promptCalls++;
      stopped = false;
      return { promptId: "next", conversationId: "conversation", status: "queued", resumed: true };
    },
  } as unknown as Provider;
  const worker = createSandboxLifecycle(sql, async () => provider, { now: () => clock, delayMs: 600_000 });
  const tick = async () => {
    await db.query("update sandboxes set reconcile_after=now()-interval '1 minute' where id=$1", [id]);
    await worker.reconcileOne();
  };
  return {
    db,
    sql,
    data,
    caller,
    id,
    at,
    provider,
    tick,
    worker,
    stops: () => stops,
    promptCalls: () => promptCalls,
    nonactiveObservations: () => nonactiveObservations,
    setClock: (value: number) => {
      clock = value;
    },
  };
}

test("native idle uses the quiet deadline, preserves work without interrupt and wakes with unchanged expiry", async () => {
  const f = await fixture();
  await f.tick();
  expect(f.stops()).toBe(0);
  f.setClock(f.at + 600_000);
  await f.tick();
  expect(f.stops()).toBe(1);
  const paused = (await f.data.sandboxes.get(f.id))!;
  expect(paused.status).toBe("stopped");
  expect(paused.statusReason).toBe("idle_paused");
  const receipt = await callSharedTool(
    {
      caller: f.caller,
      data: f.data,
      provider: async () => f.provider,
      launchCredentials: {
        resolve: async () => ({ env: {}, secrets: [], codexAuthJson: false }),
      },
      exposedSecrets: async () => [],
      now: () => new Date(f.at + 600_000),
      sleep: async () => {},
    },
    "send",
    { id: f.id, prompt: "continue", request_id: crypto.randomUUID() },
  );
  expect(receipt).toMatchObject({ promptId: "next", conversationId: "conversation" });
  const woke = (await f.data.sandboxes.get(f.id))!;
  expect(woke.status).toBe("running");
  expect(woke.expiresAt).toBe(paused.expiresAt);
  await f.worker.drain();
});

test.each([
  "active",
  "raced",
  "becomes-active",
  "unknown-exec",
  "running-turn",
  "missing-event",
  "missing-port",
  "tainted",
  "unbound",
] as const)("unproven native work is not interrupted or stopped (%s)", async (mode) => {
  const f = await fixture(mode);
  f.setClock(f.at + 700_000);
  if (mode === "tainted") await f.db.query("update sandboxes set application_secret_tainted=true where id=$1", [f.id]);
  if (mode === "unbound")
    await f.db.query("update sandboxes set credential_id=null,credential_version=null where id=$1", [f.id]);
  if (mode === "unknown-exec")
    await f.db.query("update sandboxes set activity_lease_id=$2,activity_until=now()-interval '1 minute' where id=$1", [
      f.id,
      crypto.randomUUID(),
    ]);
  await f.tick();
  expect(f.stops()).toBe(0);
  if (mode === "unknown-exec") {
    expect(
      (await f.db.query<{ activity_lease_id: string }>("select activity_lease_id from sandboxes where id=$1", [f.id]))
        .rows[0]?.activity_lease_id,
    ).not.toBeNull();
    await f.tick();
    expect(f.stops()).toBe(0);
  }
  if (mode === "becomes-active") {
    const stopping = (await f.data.sandboxes.get(f.id))!;
    if (stopping.lifecycleGeneration === undefined) throw Error("Missing lifecycle generation");
    expect(stopping.status).toBe("stopping");
    await expect(
      f.data.sandboxes.update(f.id, {
        status: "starting",
        stopRequested: false,
        activityToken: crypto.randomUUID(),
        advanceGeneration: true,
        expectedGeneration: stopping.lifecycleGeneration,
      }),
    ).rejects.toThrow();
    await f.tick();
    expect(f.stops()).toBe(0);
  }
  await f.worker.drain();
});

test("Modal native idle needs current physical quiescence and a synchronized watermark", async () => {
  const info = { id: "modal-logical", state: "running", createdAt: new Date(), physicalGeneration: "7" } as SandboxInfo;
  for (const [state, generation, watermark, acknowledged, expected] of [
    ["quiescent", "7", 5, 5, true],
    ["unknown", "7", 5, 5, false],
    ["active", "7", 5, 5, false],
    ["quiescent", "6", 5, 5, false],
    ["quiescent", "7", 5, 4, false],
  ] as const) {
    const provider = {
      id: "modal",
      observeOrchestrator: async () => ({
        state,
        physicalGeneration: generation,
        eventWatermark: watermark,
        acknowledgedSequence: acknowledged,
        evidence: "f".repeat(64),
        nativeSessionId: "native",
      }),
    } as unknown as Provider;
    expect(await nativeQuiescent(provider, info)).toBe(expected);
  }
  expect(await nativeQuiescent({ id: "modal" } as Provider, info)).toBe(false);
});

test("an expired native idle pause refuses wake before provider work", async () => {
  const f = await fixture();
  await f.data.sandboxes.update(f.id, {
    status: "stopped",
    statusReason: "idle_paused",
    stoppedAt: new Date(f.at).toISOString(),
    expiresAt: new Date(f.at + 600_000).toISOString(),
  });
  await expect(
    callSharedTool(
      {
        caller: f.caller,
        data: f.data,
        provider: async () => {
          throw Error("Provider must not be resolved for expired idle pause");
        },
        launchCredentials: {
          resolve: async () => {
            throw Error("No credentials after expiry");
          },
        },
        exposedSecrets: async () => [],
        now: () => new Date(f.at + 600_000),
        sleep: async () => {},
      },
      "send",
      { id: f.id, prompt: "too late" },
    ),
  ).rejects.toMatchObject({ code: "sandbox_terminal", status: 409 });
});

test("native Modal retries its already-fenced stop phase without active-only observation", async () => {
  const f = await fixture("modal-retry");
  f.setClock(f.at + 600_000);
  await f.tick();
  expect(f.stops()).toBe(1);
  expect((await f.data.sandboxes.get(f.id))?.status).toBe("stopping");
  await f.tick();
  expect(f.stops()).toBe(2);
  expect(f.nonactiveObservations()).toBe(0);
  expect((await f.data.sandboxes.get(f.id))?.status).toBe("stopped");
  await f.worker.drain();
});

test("a provider-reported lost workspace is failed, never advertised as a resumable idle pause", async () => {
  const f = await fixture("lost-retention");
  f.setClock(f.at + 600_000);
  await f.tick();
  const failed = (await f.data.sandboxes.get(f.id))!;
  expect(failed.status).toBe("failed");
  expect(failed.statusReason).not.toBe("idle_paused");
  expect(failed.stoppedAt).not.toBeNull();
  await f.worker.drain();
});

test.each(["boat", "modal"])("%s owner stop refuses old receipts but a fresh owner send resumes", async (provider) => {
  const f = await fixture(`owner-${provider}`);
  const key = btoa("x".repeat(32));
  const sql: Sql = {
    ...f.sql,
    transaction: (work) => f.db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const queue = createAccountTurnQueue(sql, key);
  const context = {
    caller: f.caller,
    data: f.data,
    provider: async () => f.provider,
    launchCredentials: { resolve: async () => ({ env: {}, secrets: [], codexAuthJson: false }) },
    exposedSecrets: async () => [],
    now: () => new Date(f.at),
    sleep: async () => {},
  };
  const oldRequest = crypto.randomUUID();
  await f.db.query("update sandboxes set status='ready',task_prompt_id=null where id=$1", [f.id]);
  await queue.accept(f.caller, { id: f.id, request_id: oldRequest, prompt: "old work" });
  const picked = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const dispatched: string[] = [];
  queue.setDispatch(async (_caller, input) => {
    if (input.request_id === oldRequest) {
      picked.resolve();
      await proceed.promise;
    }
    const receipt = await callSharedTool(context, "send", { ...input });
    dispatched.push(input.prompt);
    return receipt;
  });
  expect(await queue.reconcileOne(new AbortController().signal)).toBe(true);
  await picked.promise;
  expect(await callSharedTool({ ...context, accountTurns: queue }, "stop", { id: f.id })).toMatchObject({
    status: "stopped",
  });
  proceed.resolve();
  await queue.drain();
  expect(await queue.status(f.caller, f.id, oldRequest)).toMatchObject({ failed: true });
  expect(dispatched).toEqual([]);
  expect(f.promptCalls()).toBe(0);
  expect(await queue.reconcileOne(new AbortController().signal)).toBe(false);
  const freshRequest = crypto.randomUUID();
  expect(
    await callSharedTool({ ...context, accountTurns: queue }, "send", {
      id: f.id,
      request_id: freshRequest,
      prompt: "new owner work",
    }),
  ).toMatchObject({ status: "queued" });
  expect(await queue.reconcileOne(new AbortController().signal)).toBe(true);
  await queue.drain();
  expect(dispatched).toEqual(["new owner work"]);
  expect(await queue.status(f.caller, f.id, freshRequest)).toMatchObject({ nativePromptId: "next" });
  expect((await f.data.sandboxes.get(f.id))?.status).toBe("running");
  expect(f.stops()).toBe(1);
  expect(f.promptCalls()).toBe(1);
  await f.worker.drain();
});

test.each([
  "merged",
  "merged with scratch push",
  "merged with later push",
  "merged after closed",
  "merged after closed at moved head",
  "merged after closed before launch",
  "ledger gap",
  "ledger hook missing",
  "ledger hook restored",
  "open",
  "closed",
  "no push",
  "other commit",
  "merged after head advanced",
  "merged after head advanced past an unknown push",
  "closed after head advanced",
  "revoked",
  "opted out",
  "running-turn",
  "scan during turn",
  "unsettled turn after scan",
  "corrected report",
  "out-of-grant report",
  "rejected recreation",
  "recreated at fetched commit",
  "pending attempt",
  "unmerged PR at attempt",
  "lost confirmation",
  "rejected attempt",
  "unrecorded URL push",
  "later push in first checkout",
  "later push in second checkout",
  "later push in dropped checkout",
] as const)("GitHub observation and idle admission agree for %s work", async (state) => {
  const f = await fixture(state === "running-turn" ? state : "quiet");
  const owner = f.caller.userId;
  const repository = "example/repo";
  // Real Git evidence: the reader output that reaches admission.
  const git =
    state === "rejected recreation"
      ? rejectedRecreation()
      : state === "recreated at fetched commit"
        ? (({ stdout, first }) => ({ stdout, sha: first }))(recreatedAtFetchedCommit())
        : state === "lost confirmation"
          ? (({ stdout, first }) => ({ stdout, sha: first }))(lostConfirmation())
          : state === "unrecorded URL push"
            ? // Discovery sees only the merged PR; the open one left by URL with --no-verify.
              (({ stdout, first }) => ({ stdout, sha: first }))(unrecordedUrlPush())
            : undefined;
  const sha = git?.sha ?? "a".repeat(40);
  await f.db.query(
    `insert into github_connections(user_id,github_id,login,name,refresh_token_enc,access_token_enc,access_expires_at)
       values($1,123,'owner','Owner',$2,$3,now()+interval '1 hour')`,
    [
      owner,
      await encryptSecret("fixture_refresh", ENCRYPTION_KEY),
      await encryptSecret("fixture_access", ENCRYPTION_KEY),
    ],
  );
  await f.db.query(
    `update sandboxes s set pull_request_source=jsonb_build_object(
         'connectionEpoch',c.connection_epoch,'repositories',$3::jsonb)
       from github_connections c where s.id=$1 and c.user_id=$2`,
    [
      f.id,
      owner,
      JSON.stringify(
        state.startsWith("later push in")
          ? [
              { url: `https://github.com/${repository}.git`, dir: "repo" },
              { url: `https://github.com/${repository}.git`, dir: "copy" },
            ]
          : [{ url: `https://github.com/${repository}.git`, dir: "repo" }],
      ),
    ],
  );
  if (state === "corrected report") {
    await f.db.query("update sandboxes set status='ready' where id=$1", [f.id]);
    await f.data.sandboxes.reportTaskOutcome!(f.id, "turn", { state: "ready", prNumber: 4 });
    await f.data.sandboxes.reportTaskOutcome!(f.id, "turn", { state: "ready", prNumber: 12 });
  }
  if (state === "out-of-grant report") {
    // A report outside the launch grant vetoes the stop but must not hide the
    // pushed, verified and merged pull request in the grant.
    await f.db.query("update sandboxes set status='ready' where id=$1", [f.id]);
    await f.data.sandboxes.reportTaskOutcome!(f.id, "turn", {
      state: "ready",
      prUrl: "https://github.com/example/another/pull/99",
    });
  }
  const pull = {
    number: 12,
    state: state === "open" ? "open" : "closed",
    merged_at:
      state === "open" || state === "closed" || state === "closed after head advanced"
        ? null
        : new Date(f.at).toISOString(),
    // A moved head: another commit, or a reviewer's commit on top of the push.
    head: {
      ref: "topic",
      sha: state === "other commit" || state.includes("after head advanced") ? "b".repeat(40) : sha,
      repo: { full_name: repository },
    },
    base: { repo: { full_name: repository } },
  };
  // A merged PR at an older head: the later push to its branch has no PR yet.
  const laterPull = { ...pull, number: 13, head: { ...pull.head, ref: "scratch", sha: "d".repeat(40) } };
  // An earlier push to the same branch whose PR closed without merging. In the
  // moved-head cases another checkout advanced the branch before the close, so
  // its head is none of this sandbox's pushes.
  const movedHead = state === "merged after closed at moved head" || state === "merged after closed before launch";
  const closedPull = {
    ...pull,
    number: 11,
    state: "closed",
    merged_at: null,
    closed_at: new Date(f.at + (state === "merged after closed before launch" ? -86_400_000 : 300_000)).toISOString(),
    head: { ...pull.head, sha: (movedHead ? "8" : "e").repeat(40) },
  };
  // A closed-unmerged PR at an unconfirmed attempt.
  const attemptPull = { ...closedPull, number: 14, head: { ...closedPull.head, ref: "other", sha: "f".repeat(40) } };
  const fetchGitHub = Object.assign(
    async (url: Parameters<typeof fetch>[0]) => {
      if (String(url) === "https://api.github.com/user")
        return Response.json({ id: 123, login: "owner", name: "Owner" });
      // A pull request already known from an earlier scan is read by number.
      if (String(url) === `https://api.github.com/repos/${repository}/pulls/12`) return Response.json(pull);
      // A corrected report needs no branch lookup.
      expect(state).not.toBe("corrected report");
      // The pushed commit is in the advanced head's history; an unrelated head diverged.
      if (String(url).includes(`/repos/${repository}/compare/`)) {
        const advanced = String(url).endsWith(`/compare/${sha}...${"b".repeat(40)}?per_page=1`);
        if (advanced && state === "merged after head advanced past an unknown push")
          return new Response("", { status: 404 });
        return Response.json({
          status:
            advanced && (state === "merged after head advanced" || state === "closed after head advanced")
              ? "ahead"
              : "diverged",
        });
      }
      // Only the rejected attempt's commit is unknown to GitHub.
      if (String(url).includes(`/repos/${repository}/commits/`))
        return String(url).endsWith("9".repeat(40)) ? new Response("", { status: 404 }) : Response.json({});
      expect(String(url)).toContain(`/repos/${repository}/pulls?`);
      const head = new URL(String(url)).searchParams.get("head");
      if (head === "example:scratch") return Response.json(state === "merged with later push" ? [laterPull] : []);
      if (head === "example:main") return Response.json([]);
      if (head === "example:other") return Response.json(state === "unmerged PR at attempt" ? [attemptPull] : []);
      return Response.json(state.startsWith("merged after closed") ? [pull, closedPull] : [pull]);
    },
    { preconnect: fetch.preconnect },
  );
  const observe = async (stdout: string) => {
    const observer = createSandboxPullRequests(
      f.sql,
      {
        store: createSqlVaultStore(f.sql),
        encryptionKey: ENCRYPTION_KEY,
        app: { clientId: "fixture_app", clientSecret: "fixture_client" },
        fetch: fetchGitHub,
      },
      async (_target, request) => ({
        detached: false,
        exitCode: 0,
        // Two checkouts of one repository pushed `topic`: one at the merged PR's
        // head, the other later at a commit with no PR yet. Their ledgers carry
        // no order between them, whichever checkout is configured first.
        stdout: state.startsWith("later push in")
          ? request.cwd === (state === "later push in second checkout" ? "/home/user/copy" : "/home/user/repo")
            ? `topic\t${"b".repeat(40)}\n`
            : stdout
          : stdout,
        stderr: "",
        timedOut: false,
        truncated: false,
      }),
    );
    await observer.reconcileOne(new AbortController().signal);
    await observer.drain();
  };
  // The lifecycle worker settles the finished turn before a scan may prove a
  // stop; its timer is not due yet, so this tick stops nothing.
  if (state !== "scan during turn") await f.tick();
  expect(f.stops()).toBe(0);
  if (state === "ledger hook restored") {
    // The reader reported the missing hook and reinstalled it, then the scan
    // was abandoned. The next read is clean, but a push made while the hook
    // was missing may have been pruned: coverage stays unprovable.
    await observe(`!unproven\ntopic\tnot-a-sha\n`);
    expect(
      (await f.db.query("select pull_request_scan->'untracked' as u from sandboxes where id=$1", [f.id])).rows[0],
    ).toEqual({ u: true });
    await f.db.query("update sandboxes set pull_request_check_after=now() where id=$1", [f.id]);
  }
  if (state === "later push in dropped checkout") {
    // A revised grant drops the checkout whose later push has no PR yet. Its
    // latest push, read before, still has to be at a pull request head.
    await observe(`topic\t${sha}\n`);
    await f.db.query(
      `update sandboxes set pull_request_check_after=now(),
         pull_request_source=jsonb_set(pull_request_source,'{repositories}',$2::jsonb) where id=$1`,
      [f.id, JSON.stringify([{ url: `https://github.com/${repository}.git`, dir: "copy" }])],
    );
  }
  await observe(
    git
      ? git.stdout
      : state === "no push" || state === "corrected report"
        ? ""
        : `${state === "ledger gap" ? "!untracked\n" : state === "ledger hook missing" ? "!unproven\n" : state === "pending attempt" ? "!pending\n" : ""}topic\t${sha}\n${state.startsWith("merged after closed") ? `topic\t${"e".repeat(40)}\n` : ""}${state.startsWith("merged with") ? `scratch\t${"c".repeat(40)}\n` : ""}${state === "unmerged PR at attempt" ? `~\tother\t${"f".repeat(40)}\n` : ""}${state === "rejected attempt" ? `?\tmain\t${"9".repeat(40)}\n` : ""}`,
  );
  if (state === "revoked") await f.db.query("update github_connections set revoked_at=now() where user_id=$1", [owner]);
  if (state === "opted out") await f.db.query("update sandboxes set stop_when_work_merged=false where id=$1", [f.id]);
  // A turn the proof did not see is in flight: stop admission rechecks settlement.
  if (state === "unsettled turn after scan")
    await f.db.query("insert into runtime_idle_turns(sandbox_id,prompt_id,settled) values($1,'later',false)", [f.id]);
  await f.tick();
  // The read above preceded the turn's settlement (the tick that just settled
  // it), so the turn could still have pushed after it: no stop on a later tick.
  if (state === "scan during turn") await f.tick();
  const sandbox = await f.data.sandboxes.get(f.id);
  const shouldStop =
    state === "merged" ||
    state === "merged with scratch push" ||
    state === "merged after head advanced" ||
    state === "merged after closed before launch" ||
    state === "corrected report" ||
    state === "rejected attempt";
  expect(f.stops()).toBe(shouldStop ? 1 : 0);
  if (shouldStop) expect(sandbox?.statusReason).toBe("work_merged");
  expect(sandbox?.pullRequests?.map((pr) => pr.state)).toEqual(
    state === "no push" ||
      state === "other commit" ||
      state === "merged after head advanced past an unknown push" ||
      state === "rejected recreation"
      ? []
      : state === "merged after closed"
        ? ["merged", "closed"]
        : [
            state === "open" || state === "closed"
              ? state
              : state === "closed after head advanced"
                ? "closed"
                : "merged",
          ],
  );
  await f.worker.drain();
});
