import { createHmac, timingSafeEqual } from "node:crypto";
import { readBoundedText } from "@armada/auth";
import type { Sql } from "@armada/core/server";
import type { Route } from "../http.ts";
import { observeQueue, observeWork } from "./work-evidence.ts";

export interface OttoScope {
  orgId: string;
  repository: string;
}
interface Item {
  number: number;
  title: string;
  state: string;
  head?: { ref: string; sha: string; repo: string };
  updatedAt?: string;
}
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
function item(value: unknown, pull: boolean): Item {
  const v = object(value),
    head = object(v.head),
    repo = object(head.repo);
  if (
    !Number.isSafeInteger(v.number) ||
    Number(v.number) < 1 ||
    typeof v.title !== "string" ||
    !["open", "closed"].includes(String(v.state))
  )
    throw Error("invalid_github_item");
  if (pull && (typeof head.ref !== "string" || typeof head.sha !== "string" || typeof repo.full_name !== "string"))
    throw Error("invalid_github_head");
  return {
    number: Number(v.number),
    title: v.title.slice(0, 256),
    state: String(v.state),
    ...(typeof v.updated_at === "string" && Number.isFinite(Date.parse(v.updated_at))
      ? { updatedAt: v.updated_at }
      : {}),
    ...(pull ? { head: { ref: String(head.ref), sha: String(head.sha), repo: String(repo.full_name) } } : {}),
  };
}
export function createOttoObserver(sql: Sql, scope: OttoScope) {
  async function fact(
    subject: string,
    kind: string,
    value: string,
    source: string,
    sourceId: string,
    completeness: string,
    evidence: unknown,
    observedAt?: Date,
  ) {
    await sql.query(
      `insert into public.otto_facts(org_id,repository,subject,kind,value,source,source_id,completeness,evidence,observed_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,coalesce($10::timestamptz,clock_timestamp())) on conflict do nothing`,
      [
        scope.orgId,
        scope.repository,
        subject,
        kind,
        value,
        source,
        sourceId,
        completeness,
        JSON.stringify(evidence),
        observedAt ?? null,
      ],
    );
  }
  const webhook =
    (secret: string | undefined, mainBranch = "main"): Route =>
    async (request) => {
      if (new URL(request.url).pathname !== "/api/v1/otto/github/webhook") return null;
      if (request.method !== "POST") return new Response(null, { status: 405 });
      if (!secret) return Response.json({ error: "webhook_not_configured" }, { status: 503 });
      let raw: string;
      try {
        raw = await readBoundedText(request, 1024 * 1024);
      } catch {
        return new Response(null, { status: 413 });
      }
      const signature = request.headers.get("x-hub-signature-256") ?? "";
      const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
      if (!/^sha256=[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
        return new Response(null, { status: 401 });
      const event = request.headers.get("x-github-event") ?? "";
      const delivery = request.headers.get("x-github-delivery") ?? "";
      if (!/^[a-zA-Z0-9-]{1,128}$/.test(delivery)) return new Response(null, { status: 400 });
      let body: Record<string, unknown>;
      try {
        body = object(JSON.parse(raw));
      } catch {
        return new Response(null, { status: 400 });
      }
      if (object(body.repository).full_name !== scope.repository) return new Response(null, { status: 403 });
      try {
        if (event === "pull_request" || event === "issues") {
          const observed = item(body[event === "issues" ? "issue" : "pull_request"], event === "pull_request");
          if (event === "pull_request" && (!observed.updatedAt || Date.parse(observed.updatedAt) > Date.now()))
            return new Response(null, { status: 400 });
          const sourceAt = event === "pull_request" && observed.updatedAt ? new Date(observed.updatedAt) : undefined;
          await fact(
            `${event === "issues" ? "issue" : "pr"}:${observed.number}`,
            event === "issues" ? "issue" : "pr.open",
            observed.state === "open" ? "true" : "false",
            "github.webhook",
            delivery,
            "partial",
            observed,
            sourceAt,
          );
          if (event === "pull_request" && observed.head) {
            const pull = object(body.pull_request);
            await fact(
              `pr:${observed.number}`,
              "pr.work.conflict",
              pull.mergeable === false ? "true" : pull.mergeable === true ? "false" : "unknown",
              "github.webhook",
              delivery,
              typeof pull.mergeable === "boolean" ? "complete" : "partial",
              { headSha: observed.head.sha },
              sourceAt,
            );
            await observeQueue(sql, scope, observed.number, observed.head.sha, body.action, delivery, fact, sourceAt);
          }
        } else if (["check_run", "check_suite", "merge_group"].includes(event)) {
          const v = object(body[event]);
          if (typeof v.head_sha !== "string") return new Response(null, { status: 400 });
          await fact(`sha:${v.head_sha}`, event, "unknown", "github.webhook", delivery, "partial", {
            headSha: v.head_sha,
            status: v.status ?? null,
            conclusion: v.conclusion ?? null,
            action: body.action ?? null,
          });
        } else if (event === "push" && body.ref === `refs/heads/${mainBranch}`) {
          if (typeof body.after !== "string") return new Response(null, { status: 400 });
          await fact(`branch:${mainBranch}`, "main.push", "true", "github.webhook", delivery, "partial", {
            sha: body.after,
          });
        }
      } catch {
        return Response.json({ error: "observation_unavailable" }, { status: 503 });
      }
      return new Response(null, { status: 202 });
    };
  async function reconcile(token: string, signal: AbortSignal, fetcher: typeof fetch = fetch) {
    const run = crypto.randomUUID();
    for (const type of ["pulls", "issues"] as const) {
      const prefix = `/repos/${scope.repository}/${type}?state=open&per_page=100`;
      let path: string | null = prefix;
      const seen = new Set<string>();
      const observed: (Item & { observedAt: Date })[] = [];
      let complete = false;
      try {
        while (path && seen.size < 100) {
          if (seen.has(path)) throw Error("pagination_cycle");
          seen.add(path);
          const cached: { etag: string | null; items: Item[]; next_path: string | null } | undefined = (
            await sql.query<{ etag: string | null; items: Item[]; next_path: string | null }>(
              `select etag,items,next_path from public.otto_github_pages where org_id=$1 and repository=$2 and path=$3`,
              [scope.orgId, scope.repository, path],
            )
          ).rows[0];
          const response: Response = await fetcher(`https://api.github.com${path}`, {
            signal,
            redirect: "error",
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/vnd.github+json",
              "x-github-api-version": "2022-11-28",
              ...(cached?.etag ? { "if-none-match": cached.etag } : {}),
            },
          });
          let items: Item[], next: string | null;
          if (response.status === 304) {
            if (!cached) throw Error("uncached_304");
            items = cached.items;
            next = cached.next_path;
          } else {
            if (!response.ok) throw Error("github_unavailable");
            const body: unknown = await response.json();
            if (!Array.isArray(body)) throw Error("invalid_listing");
            items = body
              .filter((v) => type !== "issues" || !object(v).pull_request)
              .map((v) => item(v, type === "pulls"));
            const link: string = response.headers.get("link") ?? "";
            const match: RegExpMatchArray | null | undefined = link
              .split(",")
              .find((v) => /;\s*rel="next"/.test(v))
              ?.match(/<([^>]+)>/);
            if (/rel="next"/.test(link) && !match?.[1]) throw Error("invalid_pagination");
            next = null;
            if (match?.[1]) {
              const url: URL = new URL(match[1]);
              if (url.origin !== "https://api.github.com" || url.pathname !== `/repos/${scope.repository}/${type}`)
                throw Error("unsafe_pagination");
              next = url.pathname + url.search;
            }
            await sql.query(
              `insert into public.otto_github_pages(org_id,repository,path,etag,items,next_path) values($1,$2,$3,$4,$5::jsonb,$6)
              on conflict(org_id,repository,path) do update set etag=excluded.etag,items=excluded.items,next_path=excluded.next_path`,
              [scope.orgId, scope.repository, path, response.headers.get("etag"), JSON.stringify(items), next],
            );
          }
          const observedAt = new Date();
          observed.push(...items.map((value) => ({ ...value, observedAt })));
          path = next;
        }
        complete = path === null;
      } catch {
        /* An incomplete list can add evidence, never infer absence. */
      }
      for (const v of observed)
        await fact(
          `${type === "pulls" ? "pr" : "issue"}:${v.number}`,
          type === "pulls" ? "pr.open" : "issue",
          "true",
          "github.reconcile",
          run,
          "partial",
          v,
          v.observedAt,
        );
      await fact(
        "repository",
        type === "pulls" ? "repository.open_prs" : "repository.open_issues",
        complete ? "true" : "unknown",
        "github.reconcile",
        run,
        complete ? "complete" : "partial",
        { numbers: observed.map((v) => v.number) },
      );
      if (type === "pulls") await observeWork(sql, scope, observed, token, run, fact, signal, fetcher);
    }
  }
  return { fact, webhook, reconcile };
}
