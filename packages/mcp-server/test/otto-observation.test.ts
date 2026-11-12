import { afterAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { Sql } from "@armada/core/server";
import { createOttoObserver } from "../src/otto/observation.ts";
import { database } from "./support.ts";

const fixture = database();
afterAll(async () => (await fixture).db.close());
const pr = {
  number: 17,
  title: "Observed",
  state: "open",
  head: { ref: "codex/17-work", sha: "a".repeat(40), repo: { full_name: "example/web" } },
};
async function setup(repository: string) {
  const { db, people } = await fixture;
  const sql: Sql = { query: (q, p) => db.query(q, p) };
  const observer = createOttoObserver(sql, { orgId: people.org, repository });
  const facts = () =>
    db.query<{ kind: string; value: string; completeness: string; evidence: { numbers: number[] } }>(
      "select * from otto_facts where repository=$1 order by observed_at,id",
      [repository],
    );
  return { observer, facts, sql };
}
// Signature/replay correctness belongs at the receiver boundary, not a crypto helper.
test("signed deliveries are scoped, immutable and replay-idempotent", async () => {
  const { observer, facts, sql } = await setup("example/web");
  const body = JSON.stringify({ repository: { full_name: "example/web" }, pull_request: pr });
  const route = observer.webhook("test-webhook-fixture");
  const send = (signature: string) =>
    route(
      new Request("https://armada.example/api/v1/otto/github/webhook", {
        method: "POST",
        headers: {
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-1",
          "x-hub-signature-256": signature,
        },
        body,
      }),
    );
  expect((await send("sha256=" + "0".repeat(64)))?.status).toBe(401);
  expect((await facts()).rows).toHaveLength(0);
  const signature = `sha256=${createHmac("sha256", "test-webhook-fixture").update(body).digest("hex")}`;
  expect((await send(signature))?.status).toBe(202);
  expect((await send(signature))?.status).toBe(202);
  expect((await facts()).rows).toHaveLength(1);
  await expect(sql.query("delete from otto_facts where repository='example/web'")).rejects.toThrow("append-only");
});
// The historical incident was partial pagination retiring missing PRs.
test("failed pagination is unknown and cached 304 pages still follow next links", async () => {
  const { observer, facts } = await setup("example/paged");
  let second = false;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/issues?")) return Response.json([]);
    if (u.includes("page=2"))
      return second ? Response.json([{ ...pr, number: 18 }]) : new Response(null, { status: 429 });
    if (second) {
      expect(new Headers(init?.headers).get("if-none-match")).toBe('"page1"');
      return new Response(null, { status: 304 });
    }
    return Response.json([pr], {
      headers: {
        etag: '"page1"',
        link: '<https://api.github.com/repos/example/paged/pulls?state=open&per_page=100&page=2>; rel="next"',
      },
    });
  }) as typeof fetch;
  await observer.reconcile("fixture", new AbortController().signal, fetcher);
  expect((await facts()).rows.find((v) => v.kind === "repository.open_prs")?.value).toBe("unknown");
  second = true;
  await observer.reconcile("fixture", new AbortController().signal, fetcher);
  const complete = (await facts()).rows.filter(
    (v) => v.kind === "repository.open_prs" && v.completeness === "complete",
  );
  expect(complete[0]?.evidence.numbers).toEqual([17, 18]);
});
