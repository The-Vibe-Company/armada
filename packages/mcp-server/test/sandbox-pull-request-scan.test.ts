import { expect, test } from "bun:test";
import type { Provider, SandboxInfo } from "@armada/core";
import { createSqlVaultStore, encryptSecret } from "@armada/core/server";
import { insertSandboxFixture } from "../../core/test/sandbox.fixture.ts";
import { createSqlData } from "../src/data.ts";
import { createJobsRunner } from "../src/jobs/runner.ts";
import { createJobsStore } from "../src/jobs/store.ts";
import { createLangfuse } from "../src/langfuse.ts";
import { langfusePrLinkedScore } from "../src/langfuse-spans.ts";
import { createSandboxLifecycle } from "../src/sandbox-lifecycle.ts";
import { createPullRequestScanJob } from "../src/sandbox-pull-requests.ts";
import { sqlOver } from "../src/sql.ts";
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
  const golden = (await db.query<{ id: string }>("select id from goldens where name='shared'")).rows[0]!;
  const id = crypto.randomUUID();
  const physical = "bx_23456789";
  const task = "turn";
  const at = Date.now();
  let stopped = false,
    stops = 0,
    eventReads = 0;
  const credential = (
    await db.query<{ id: string }>(
      "select id from credentials where scope='user' and owner_id=$1 and kind='claude_oauth'",
      [people.owner],
    )
  ).rows[0]!;
  await insertSandboxFixture(sql, {
    id,
    goldenId: golden.id,
    orgId: people.org,
    ownerId: people.owner,
    credentialId: credential.id,
    credentialVersion: 1,
    provider: "boat",
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
    id: "boat",
    get: async () =>
      ({
        id: physical,
        state: stopped ? "stopped" : "running",
        createdAt: new Date(at),
        name: "scan-fixture",
        providerState: stopped ? "stopped" : "active",
        ...(stopped ? { retainedSnapshot: "usable" as const } : {}),
        labels: {},
      }) satisfies SandboxInfo,
    getPrompt: async () => ({
      promptId: task,
      status: mode === "running-turn" ? "running" : "finished",
      done: mode !== "running-turn",
    }),
    events: async () => {
      eventReads++;
      return {
        events: [{ id: "terminal", kind: "prompt", promptId: task, status: "finished", text: "", at }],
        hasMore: false,
      };
    },
    stop: async () => {
      stops++;
      stopped = true;
    },
  } as unknown as Provider;
  const worker = createSandboxLifecycle(sql, async () => provider, { now: () => at });
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
    tick,
    worker,
    stops: () => stops,
    eventReads: () => eventReads,
  };
}

test.each([
  "merged",
  "merged with scratch push",
  "merged with later push",
  "merged with scratch PR closed before launch",
  "merged after closed",
  "merged after many pushes",
  "merged after closed at moved head",
  "merged after closed before launch",
  "merged before launch at pushed commit",
  "reported PR merged before launch",
  "ledger gap",
  "ledger hook missing",
  "ledger hook restored",
  "generation changed during exec",
  "tainted after enqueue",
  "generation changed after refresh claim",
  "completion interrupted",
  "activity started after enqueue",
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
] as const)("GitHub scan publishes metadata and merge proof for %s work", async (state) => {
  const f = await fixture(state === "running-turn" ? state : "quiet");
  const owner = f.caller.userId;
  const repository = "example/repo";
  const sha = "a".repeat(40);
  const later = "2".repeat(40);
  const ledger: Partial<Record<typeof state, string>> = {
    "rejected recreation": `^\t${sha}\n?\ttopic\t${sha}\n`,
    "recreated at fetched commit": `topic\t${later}\ntopic\t${sha}\n`,
    "lost confirmation": `^\t${later}\ntopic\t${sha}\n?\ttopic\t${later}\n`,
    "unrecorded URL push": `^\t${later}\ntopic\t${sha}\n`,
  };
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
  if (state === "generation changed after refresh claim")
    await f.db.query("update github_connections set access_expires_at=now() where user_id=$1", [owner]);
  if (state === "corrected report") {
    await f.db.query("update sandboxes set status='ready' where id=$1", [f.id]);
    await f.data.sandboxes.reportTaskOutcome!(f.id, "turn", { state: "ready", prNumber: 4 });
    await f.data.sandboxes.reportTaskOutcome!(f.id, "turn", { state: "ready", prNumber: 12 });
  }
  if (state === "reported PR merged before launch") {
    await f.db.query("update sandboxes set status='ready' where id=$1", [f.id]);
    await f.data.sandboxes.reportTaskOutcome!(f.id, "turn", { state: "ready", prNumber: 12 });
  }
  if (state === "out-of-grant report") {
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
    head: {
      ref: "topic",
      sha: state === "other commit" || state.includes("after head advanced") ? "b".repeat(40) : sha,
      repo: { full_name: repository },
    },
    ...(state === "merged before launch at pushed commit" || state === "reported PR merged before launch"
      ? { merged_at: new Date(f.at - 86_400_000).toISOString(), closed_at: new Date(f.at - 86_400_000).toISOString() }
      : {}),
    base: { repo: { full_name: repository } },
  };
  const laterPull = { ...pull, number: 13, head: { ...pull.head, ref: "scratch", sha: "d".repeat(40) } };
  const stalePull = {
    ...laterPull,
    number: 10,
    merged_at: null,
    closed_at: new Date(f.at - 86_400_000).toISOString(),
    head: { ...laterPull.head, sha: "7".repeat(40) },
  };
  const movedHead = state === "merged after closed at moved head" || state === "merged after closed before launch";
  const closedPull = {
    ...pull,
    number: 11,
    state: "closed",
    merged_at: null,
    closed_at: new Date(f.at + (state === "merged after closed before launch" ? -86_400_000 : 300_000)).toISOString(),
    head: { ...pull.head, sha: (movedHead ? "8" : "e").repeat(40) },
  };
  const attemptPull = { ...closedPull, number: 14, head: { ...closedPull.head, ref: "other", sha: "f".repeat(40) } };
  const fetchGitHub = Object.assign(
    async (url: Parameters<typeof fetch>[0]) => {
      if (String(url) === "https://github.com/login/oauth/access_token") {
        expect(state).toBe("generation changed after refresh claim");
        return Response.json({ access_token: "next_access", refresh_token: "next_refresh", expires_in: 3600 });
      }
      if (String(url) === "https://api.github.com/user")
        return Response.json({ id: 123, login: "owner", name: "Owner" });
      if (String(url) === `https://api.github.com/repos/${repository}/pulls/12`) return Response.json(pull);
      expect(state).not.toBe("corrected report");
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
      if (String(url).includes(`/repos/${repository}/commits/`))
        return String(url).endsWith("9".repeat(40)) ? new Response("", { status: 404 }) : Response.json({});
      expect(String(url)).toContain(`/repos/${repository}/pulls?`);
      const head = new URL(String(url)).searchParams.get("head");
      if (head === "example:scratch")
        return Response.json(
          state === "merged with later push"
            ? [laterPull]
            : state === "merged with scratch PR closed before launch"
              ? [stalePull]
              : [],
        );
      if (head === "example:main") return Response.json([]);
      if (head === "example:other") return Response.json(state === "unmerged PR at attempt" ? [attemptPull] : []);
      return Response.json(state.startsWith("merged after closed") ? [pull, closedPull] : [pull]);
    },
    { preconnect: fetch.preconnect },
  );
  let interruptCompletion = state === "completion interrupted";
  const observe = async (stdout: string, activityStarted = false) => {
    const willInterrupt = interruptCompletion;
    const sql = sqlOver({
      unsafe: async (query, params) => (await f.db.query(query, params)).rows,
      begin: (work) =>
        f.db.transaction((tx) =>
          work({
            async unsafe(query, params) {
              if (interruptCompletion && query.startsWith("update public.jobs set attempts=0")) {
                interruptCompletion = false;
                throw Error("Interrupted after publishing observation in the transaction.");
              }
              return (await tx.query(query, params)).rows;
            },
          }),
        ),
    });
    const jobs = createJobsStore(sql);
    const at = Date.now();
    const vault = createSqlVaultStore(f.sql);
    const handler = createPullRequestScanJob(
      sql,
      jobs,
      {
        store: {
          ...vault,
          withGitHubConnectionRefresh: (userId, work) =>
            vault.withGitHubConnectionRefresh(userId, (store, connection) =>
              work(
                {
                  ...store,
                  async consumeGitHubRefresh(userId, expected) {
                    const consumed = await store.consumeGitHubRefresh(userId, expected);
                    if (consumed && state === "generation changed after refresh claim")
                      await f.db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [
                        f.id,
                      ]);
                    return consumed;
                  },
                },
                connection,
              ),
            ),
        },
        encryptionKey: ENCRYPTION_KEY,
        app: { clientId: "fixture_app", clientSecret: "fixture_client" },
        fetch: fetchGitHub,
      },
      async (_target, request) => {
        if (state === "generation changed during exec")
          await f.db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [f.id]);
        return {
          detached: false,
          exitCode: 0,
          stdout:
            state === "generation changed during exec"
              ? "!untracked\n"
              : state.startsWith("later push in")
                ? request.cwd === (state === "later push in second checkout" ? "/home/user/copy" : "/home/user/repo")
                  ? `topic\t${"b".repeat(40)}\n`
                  : stdout
                : stdout,
          stderr: "",
          timedOut: false,
          truncated: false,
        };
      },
      () => at,
    );
    if (state === "tainted after enqueue") {
      await handler.prepare();
      await f.db.query("update sandboxes set application_secret_tainted=true where id=$1", [f.id]);
    }
    if (activityStarted) {
      await handler.prepare();
      await f.db.query(
        "update sandboxes set activity_lease_id=$2,activity_until=now()+interval '1 minute' where id=$1",
        [f.id, crypto.randomUUID()],
      );
    }
    const runner = createJobsRunner(jobs, { pr_scan: handler }, undefined, () => () => {});
    expect(await runner.reconcileOne(new AbortController().signal)).toBe(true);
    await runner.drain();
    expect((await f.db.query("select state,attempts from jobs where sandbox_id=$1", [f.id])).rows).toEqual([
      willInterrupt
        ? { state: "leased", attempts: 1 }
        : state.startsWith("generation changed")
          ? { state: "failed", attempts: 1 }
          : state === "tainted after enqueue"
            ? { state: "done", attempts: 1 }
            : { state: "queued", attempts: 0 },
    ]);
    if (activityStarted) {
      const { rows } = await f.db.query<{ run_after: Date }>("select run_after from jobs where sandbox_id=$1", [f.id]);
      expect(rows[0]?.run_after).toEqual(new Date(at + 15_000));
    }
  };
  if (state !== "scan during turn") await f.tick();
  expect(f.stops()).toBe(0);
  if (state === "ledger hook restored") {
    await observe(`!unproven\ntopic\tnot-a-sha\n`);
    expect(
      (await f.db.query("select pull_request_scan->'untracked' as u from sandboxes where id=$1", [f.id])).rows[0],
    ).toEqual({ u: true });
    await f.db.query("update jobs set run_after=now() where sandbox_id=$1", [f.id]);
  }
  if (state === "later push in dropped checkout") {
    await observe(`topic\t${sha}\n`);
    await f.db.query(
      `update sandboxes set pull_request_source=jsonb_set(pull_request_source,'{repositories}',$2::jsonb) where id=$1`,
      [f.id, JSON.stringify([{ url: `https://github.com/${repository}.git`, dir: "copy" }])],
    );
    await f.db.query("update jobs set run_after=now() where sandbox_id=$1", [f.id]);
  }
  await observe(
    ledger[state] ??
      (state === "no push" || state === "corrected report"
        ? ""
        : `${state === "ledger gap" ? "!untracked\n" : state === "ledger hook missing" ? "!unproven\n" : state === "pending attempt" ? "!pending\n" : ""}topic\t${sha}\n${state.startsWith("merged after closed") ? `topic\t${"e".repeat(40)}\n` : ""}${
            state === "merged after many pushes"
              ? Array.from({ length: 16 }, (_, i) => `topic\t${i.toString(16).padStart(40, "1")}\n`).join("")
              : ""
          }${state.startsWith("merged with") ? `scratch\t${"c".repeat(40)}\n` : ""}${state === "unmerged PR at attempt" ? `~\tother\t${"f".repeat(40)}\n` : ""}${state === "rejected attempt" ? `?\tmain\t${"9".repeat(40)}\n` : ""}`),
    state === "activity started after enqueue",
  );
  if (state === "activity started after enqueue") {
    expect((await f.data.sandboxes.get(f.id))?.pullRequests).toEqual([]);
    await f.db.query("update sandboxes set activity_lease_id=null,activity_until=null where id=$1", [f.id]);
    await f.db.query("update jobs set run_after=now() where sandbox_id=$1", [f.id]);
    await observe(`topic\t${sha}\n`);
  }
  if (state === "completion interrupted") {
    expect((await f.data.sandboxes.get(f.id))?.pullRequests).toEqual([]);
    const [leased] = (await f.db.query<{ id: string }>("select id from jobs where sandbox_id=$1", [f.id])).rows;
    await f.db.query("update jobs set lease_until=now() where id=$1", [leased!.id]);
    await observe(`topic\t${sha}\n`);
    expect((await f.db.query("select id from jobs where sandbox_id=$1", [f.id])).rows).toEqual([leased]);
  }
  if (state === "generation changed during exec")
    expect((await f.db.query("select pull_request_scan as scan from sandboxes where id=$1", [f.id])).rows).toEqual([
      { scan: null },
    ]);
  if (state === "generation changed after refresh claim")
    expect(
      (await f.db.query("select access_expires_at>now() as valid from github_connections where user_id=$1", [owner]))
        .rows,
    ).toEqual([{ valid: true }]);
  if (state === "revoked") await f.db.query("update github_connections set revoked_at=now() where user_id=$1", [owner]);
  if (state === "opted out") await f.db.query("update sandboxes set stop_when_work_merged=false where id=$1", [f.id]);
  if (state === "unsettled turn after scan")
    await f.db.query("insert into runtime_idle_turns(sandbox_id,prompt_id,settled) values($1,'later',false)", [f.id]);
  await f.tick();
  if (state === "scan during turn") await f.tick();
  const sandbox = await f.data.sandboxes.get(f.id);
  const shouldProveMerge =
    state === "merged" ||
    state === "completion interrupted" ||
    state === "activity started after enqueue" ||
    state === "merged with scratch push" ||
    state === "merged with scratch PR closed before launch" ||
    state === "merged after head advanced" ||
    state === "merged after closed before launch" ||
    state === "corrected report" ||
    state === "rejected attempt";
  expect(f.stops()).toBe(0);
  if (shouldProveMerge) {
    expect(f.eventReads()).toBe(0);
    const proof = await f.db.query<{ proved: boolean }>(
      "select pull_request_merge_proof is not null as proved from sandboxes where id=$1",
      [f.id],
    );
    expect(proof.rows[0]?.proved).toBe(true);
  }
  expect(sandbox?.pullRequests?.map((pr) => pr.state)).toEqual(
    state === "no push" ||
      state.startsWith("generation changed") ||
      state === "tainted after enqueue" ||
      state === "other commit" ||
      state === "merged before launch at pushed commit" ||
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

test("pr_scan unblocks after turn export expedite and upserts pr_linked=1 only on newly discovered PRs", async () => {
  const f = await fixture("quiet");
  const repository = "example/repo";
  const sha = "a".repeat(40);
  const tok = await encryptSecret("tok", ENCRYPTION_KEY);
  await f.db.query(
    `insert into github_connections(user_id,github_id,login,name,refresh_token_enc,access_token_enc,access_expires_at)
       values($1,123,'owner','Owner',$2,$2,now()+interval '1 hour')`,
    [f.caller.userId, tok],
  );
  await f.db.query(
    `update sandboxes s set pull_request_source=jsonb_build_object('connectionEpoch',c.connection_epoch,'repositories',$3::jsonb)
       from github_connections c where s.id=$1 and c.user_id=$2`,
    [f.id, f.caller.userId, JSON.stringify([{ url: `https://github.com/${repository}.git`, dir: "repo" }])],
  );
  await f.db.query("insert into org_langfuse(org_id,enabled,content_mode,config_enc) values($1,true,'metadata',$2)", [
    f.caller.orgs[0]!.orgId,
    await encryptSecret(
      JSON.stringify({ host: "https://langfuse.test", publicKey: "pub_x", secretKey: "sec_placeholder" }),
      ENCRYPTION_KEY,
    ),
  ]);
  await f.tick();

  let hasPush = false;
  let scoreStatus = 200;
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const lfFetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = String(url);
    posts.push({ url: href, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(null, { status: href.endsWith("/scores") ? scoreStatus : 200 });
  }) as typeof fetch;
  const pull = {
    number: 12,
    state: "open",
    merged_at: null,
    head: { ref: "topic", sha, repo: { full_name: repository } },
    base: { repo: { full_name: repository } },
  };
  const ghFetch = Object.assign(
    async (url: Parameters<typeof fetch>[0]) =>
      String(url) === "https://api.github.com/user"
        ? Response.json({ id: 123, login: "owner", name: "Owner" })
        : Response.json(String(url).includes(`/repos/${repository}/pulls?`) ? [pull] : pull),
    { preconnect: fetch.preconnect },
  );
  const jobs = createJobsStore(f.sql);
  const at = Date.now();
  const makeScan = (clock: number) =>
    createPullRequestScanJob(
      f.sql,
      jobs,
      {
        store: createSqlVaultStore(f.sql),
        encryptionKey: ENCRYPTION_KEY,
        app: { clientId: "a", clientSecret: "b" },
        fetch: ghFetch,
      },
      async () => ({
        detached: false,
        exitCode: 0,
        stdout: hasPush ? `topic\t${sha}\n` : "",
        stderr: "",
        timedOut: false,
        truncated: false,
      }),
      () => clock,
      { langfuseFetch: lfFetch, logError: (l) => logs.push(l) },
    );
  const step = async (r: ReturnType<typeof createJobsRunner>) => {
    expect(await r.reconcileOne(new AbortController().signal)).toBe(true);
    await r.drain();
  };
  const prScan = makeScan(at);
  const lf = createLangfuse(f.sql, ENCRYPTION_KEY, lfFetch, { logError: (l) => logs.push(l) });
  const runner = createJobsRunner(jobs, { pr_scan: prScan, langfuse_export: lf.exportJob }, undefined, () => () => {});

  await step(runner);
  expect([await prScan.prepare(), (await f.data.sandboxes.get(f.id))?.pullRequests]).toEqual([false, []]);

  hasPush = true;
  await f.db.query("select public.enqueue_webhook_turn($1,'turn','finished')", [f.id]);
  await step(runner);
  expect(posts.filter((p) => p.url.endsWith("/scores") && p.body.name === "pr_linked").map((p) => p.body)).toEqual([
    langfusePrLinkedScore(f.id, "turn", false),
  ]);

  posts.length = 0;
  await step(runner);
  expect([(await f.data.sandboxes.get(f.id))?.pullRequests?.length, posts]).toEqual([
    1,
    [{ url: "https://langfuse.test/api/public/scores", body: langfusePrLinkedScore(f.id, "turn", true) }],
  ]);

  posts.length = 0;
  await f.db.query("update jobs set run_after=now()-interval '1 second' where kind='pr_scan' and sandbox_id=$1", [
    f.id,
  ]);
  await step(createJobsRunner(jobs, { pr_scan: makeScan(at + 20_000) }, undefined, () => () => {}));
  expect(posts).toEqual([]);

  await f.db.query("update sandboxes set pull_requests='[]'::jsonb where id=$1", [f.id]);
  await f.db.query("update jobs set run_after=now()-interval '1 second' where kind='pr_scan' and sandbox_id=$1", [
    f.id,
  ]);
  scoreStatus = 500;
  await step(createJobsRunner(jobs, { pr_scan: makeScan(at + 40_000) }, undefined, () => () => {}));
  expect((await f.data.sandboxes.get(f.id))?.pullRequests).toHaveLength(1);
  expect(logs.some((l) => l.includes("status=500") && !l.includes("sec_placeholder"))).toBe(true);
  await f.worker.drain();
});
