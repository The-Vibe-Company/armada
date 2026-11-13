import { afterAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { Sql } from "@armada/core/server";
import { createOttoObserver } from "../src/otto/observation.ts";
import { database } from "./support.ts";

const shared = database();
afterAll(async () => (await shared).db.close());
const SHA = "c".repeat(40);
async function setup(repository: string) {
  const { db, people } = await shared;
  const sql: Sql = { query: (q, p) => db.query(q, p) };
  const observer = createOttoObserver(sql, { orgId: people.org, repository });
  const facts = async () =>
    (
      await db.query<{ kind: string; value: string; evidence: { headSha?: string } }>(
        "select * from otto_facts where org_id=$1 and repository=$2 order by observed_at,id",
        [people.org, repository],
      )
    ).rows;
  return { db, observer, facts };
}
test.each([
  "failure",
  "in_progress",
  "other_app",
  "partial",
  "denied",
  "changed_head",
  "wrong_sha",
  "legacy_failure",
  "timed_out",
  "malformed",
])("work evidence: %s is exact-head, required-producer scoped and survives conditional 304", async (mode) => {
  const repo = `example/${mode}`,
    f = await setup(repo);
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    if (new Headers(init?.headers).get("if-none-match")) return new Response(null, { status: 304 });
    const path = new URL(String(url)).pathname;
    if (mode === "denied" && path.endsWith("/required_status_checks")) return new Response(null, { status: 403 });
    let body: unknown;
    if (path.endsWith("/pulls"))
      body = [
        {
          number: 17,
          title: "Work",
          state: "open",
          head: { ref: "codex/17-work", sha: SHA, repo: { full_name: repo } },
        },
      ];
    else if (path.endsWith("/issues")) body = [];
    else if (path.endsWith("/pulls/17"))
      body = {
        head: { sha: mode === "changed_head" ? "e".repeat(40) : SHA },
        base: { ref: "main" },
        mergeable: true,
        body: "private_transcript_marker",
      };
    else if (path.endsWith("/required_status_checks"))
      body =
        mode === "legacy_failure"
          ? { contexts: ["required"] }
          : { checks: [{ context: "required", app_id: 7 }], contexts: ["required"] };
    else if (path.endsWith("/check-runs"))
      body = {
        total_count: mode === "partial" ? 200 : 1,
        check_runs: [
          {
            name: "required",
            head_sha: mode === "wrong_sha" ? "e".repeat(40) : SHA,
            app: { id: mode === "other_app" ? 8 : 7 },
            status: mode === "in_progress" || mode === "partial" ? "in_progress" : "completed",
            conclusion: mode === "in_progress" || mode === "partial" ? null : "failure",
            output: { text: "private_transcript_marker" },
          },
        ],
      };
    else if (path.endsWith("/status")) body = { sha: SHA, total_count: 0, statuses: [] };
    else throw Error(`unexpected_url:${path}`);
    if (mode === "legacy_failure" && path.endsWith("/check-runs")) body = { total_count: 0, check_runs: [] };
    if (mode === "timed_out" && path.endsWith("/check-runs"))
      body = {
        total_count: 1,
        check_runs: [{ name: "required", head_sha: SHA, app: { id: 7 }, status: "completed", conclusion: "timed_out" }],
      };
    if (mode === "malformed" && path.endsWith("/check-runs"))
      body = { total_count: 1, check_runs: [{ head_sha: SHA }] };
    if (mode === "legacy_failure" && path.endsWith("/status"))
      body = { sha: SHA, total_count: 1, statuses: [{ context: "required", state: "failure" }] };
    return Response.json(body, { headers: { etag: '"observed"' } });
  }) as typeof fetch;
  await f.observer.reconcile("fixture", new AbortController().signal, fetcher);
  await f.observer.reconcile("fixture", new AbortController().signal, fetcher);
  const values = (await f.facts()).filter((v) => v.kind === "pr.work.required_check");
  expect(values.map((v) => v.value)).toEqual([
    ["failure", "legacy_failure"].includes(mode) ? "true" : mode === "in_progress" ? "false" : "unknown",
    ["failure", "legacy_failure"].includes(mode) ? "true" : mode === "in_progress" ? "false" : "unknown",
  ]);
  expect(values.every((v) => v.evidence.headSha === SHA)).toBe(true);
  const cache = await f.db.query<{ items: unknown }>("select items from otto_github_pages where repository=$1", [repo]);
  expect(JSON.stringify(cache.rows)).not.toContain("private_transcript_marker");
});

test("signed queue removal needs an observed same-head entry; conflict evidence does not need CI failure", async () => {
  const f = await setup("example/queue");
  let tick = 0;
  const anchor = Date.now() - 60_000;
  const send = async (action: string, sha = SHA) => {
    const body = JSON.stringify({
      action,
      repository: { full_name: "example/queue" },
      pull_request: {
        number: 17,
        title: "Queue",
        updated_at: new Date(anchor + ++tick * 1000).toISOString(),
        state: "open",
        mergeable: false,
        head: { sha, ref: "codex/17-work", repo: { full_name: "example/queue" } },
      },
    });
    const response = await f.observer.webhook("queue-test")(
      new Request("https://armada.example/api/v1/otto/github/webhook", {
        method: "POST",
        body,
        headers: {
          "x-github-event": "pull_request",
          "x-github-delivery": crypto.randomUUID(),
          "x-hub-signature-256": `sha256=${createHmac("sha256", "queue-test").update(body).digest("hex")}`,
        },
      }),
    );
    expect(response?.status).toBe(202);
  };
  await send("dequeued");
  await send("enqueued");
  await send("dequeued");
  await send("dequeued", "d".repeat(40));
  tick = 0;
  await send("enqueued");
  await send("dequeued");
  const facts = await f.facts();
  expect(facts.filter((v) => v.kind === "pr.work.queue").map((v) => v.value)).toEqual([
    "unknown",
    "false",
    "true",
    "unknown",
    "unknown",
    "unknown",
  ]);
  expect(facts.filter((v) => v.kind === "pr.work.conflict").every((v) => v.value === "true")).toBe(true);
});

test("a delayed signed PR event keeps its provider timestamp and cannot replace a newer observed head", async () => {
  const f = await setup("example/delayed");
  await f.observer.fact("pr:17", "pr.open", "true", "test.current", "current", "partial", {
    number: 17,
    head: { sha: SHA, ref: "codex/17-work", repo: "example/delayed" },
  });
  const body = JSON.stringify({
    repository: { full_name: "example/delayed" },
    pull_request: {
      number: 17,
      title: "Older",
      state: "open",
      updated_at: new Date(Date.now() - 60_000).toISOString(),
      mergeable: false,
      head: { sha: "e".repeat(40), ref: "codex/17-work", repo: { full_name: "example/delayed" } },
    },
  });
  const response = await f.observer.webhook("delayed-test")(
    new Request("https://armada.example/api/v1/otto/github/webhook", {
      method: "POST",
      body,
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": crypto.randomUUID(),
        "x-hub-signature-256": `sha256=${createHmac("sha256", "delayed-test").update(body).digest("hex")}`,
      },
    }),
  );
  expect(response?.status).toBe(202);
  expect((await f.facts()).filter((f) => f.kind === "pr.open").at(-1)?.evidence).toMatchObject({ head: { sha: SHA } });
});
