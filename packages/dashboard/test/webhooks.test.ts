import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  configTemplate,
  type ProjectInput,
  parseConfig,
  type SourcesRefresh,
  type StatusSources,
} from "@armada/core/read";
import { issue } from "../../core/test/support.ts";
import type { Database } from "../lib/db.ts";
import { type LoadOptions, loadOverview, newCache, refreshProject, type Sources } from "../lib/fleet-data.ts";
import { liveStore, upsertProject } from "../lib/fleet-store.ts";
import { dbSnapshots } from "../lib/snapshots.ts";
import { handleGithubWebhook, handleLinearWebhook, type WebhookDeps } from "../lib/webhooks.ts";
import { tempDatabase } from "./support.ts";

const open: Database[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.end().catch(() => {})));
});

const WIDGETS: ProjectInput = { slug: "widgets", name: "Widgets", repository: "Acme/Widgets", programRoot: "WID-1" };
const T0 = Date.parse("2026-03-04T10:00:00Z");
const LINEAR_SECRET = "linear-test-secret";
const GITHUB_SECRET = "github-test-secret";
const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

/** One project, read once into the database; every later read of Linear and GitHub is recorded. */
async function project() {
  const db = await tempDatabase();
  open.push(db);
  await upsertProject(db, WIDGETS);
  let clock = T0;
  const asks: SourcesRefresh[] = [];
  let failing = false;
  const worker = issue("WID-2", { uuid: "lin-wid-2", statusType: "started", agentPhase: "implementing" });
  const full = (): StatusSources => ({
    program: {
      rootId: "WID-1",
      fetchedAt: new Date(clock).toISOString(),
      issues: [issue("WID-1", { uuid: "lin-wid-1" }), { ...worker, parentId: "WID-1" }],
      comments: [],
      warnings: [],
    },
    forge: { repo: WIDGETS.repository, fetchedAt: new Date(clock).toISOString(), prs: [], warnings: [] },
    forgeError: null,
  });
  const sources: Sources = {
    live: async () => liveStore(db),
    database: async () => db,
    fallbackProjects: () => [],
    readConfig: async () => ({ config: parseConfig(configTemplate(WIDGETS)), warning: null }),
    readSnapshot: async () => full(),
    readChanges: async (_config, previous, ask) => {
      asks.push(ask);
      if (failing) throw new Error("Linear: HTTP 503");
      return previous;
    },
  };
  const opts: LoadOptions = { sources, cache: newCache(), now: () => new Date(clock), snapshotMs: 600_000 };
  const store = dbSnapshots(db, opts.cache.snapshots);
  await refreshProject(WIDGETS, store, opts);
  const refreshed: string[][] = [];
  const deps: WebhookDeps = {
    secrets: { linear: LINEAR_SECRET, github: GITHUB_SECRET },
    database: async () => db,
    refresh: (keys) => refreshed.push(keys),
    now: () => new Date(clock),
  };
  return {
    db,
    opts,
    store,
    deps,
    asks,
    refreshed,
    fail: (v: boolean) => {
      failing = v;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    /** A Linear delivery, signed and timed as Linear sends it. */
    linear: (payload: object, o: { secret?: string; sentAt?: number } = {}) => {
      const body = JSON.stringify({ ...payload, webhookTimestamp: o.sentAt ?? clock });
      return new Request("https://armada.example.test/api/webhooks/linear", {
        method: "POST",
        headers: { "content-type": "application/json", "linear-signature": sign(o.secret ?? LINEAR_SECRET, body) },
        body,
      });
    },
    github: (event: string, payload: object, secret = GITHUB_SECRET) => {
      const body = JSON.stringify(payload);
      return new Request("https://armada.example.test/api/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": event,
          "x-hub-signature-256": `sha256=${sign(secret, body)}`,
        },
        body,
      });
    },
  };
}

describe("Linear's webhook", () => {
  test("a signed delivery about a ticket of the program marks its project; the refresh reads that ticket's changes only", async () => {
    const w = await project();
    const res = await handleLinearWebhook(
      w.linear({ type: "Issue", action: "update", data: { id: "lin-wid-2", parentId: "lin-wid-1" } }),
      w.deps,
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ marked: 1 });
    expect(w.refreshed).toEqual([["widgets"]]);

    w.advance(5_000);
    await refreshProject(WIDGETS, w.store, w.opts);
    expect(w.asks).toEqual([
      {
        linearSince: new Date(T0 - 120_000).toISOString(),
        touched: ["lin-wid-1", "lin-wid-2"],
        forge: false,
      },
    ]);
  });

  test("a comment names its ticket; a delivery about another program marks nothing", async () => {
    const w = await project();
    const comment = await handleLinearWebhook(
      w.linear({ type: "Comment", action: "create", data: { id: "c1", issueId: "lin-wid-2" } }),
      w.deps,
    );
    expect(await comment.json()).toEqual({ marked: 1 });
    const elsewhere = await handleLinearWebhook(
      w.linear({ type: "Issue", action: "create", data: { id: "lin-other", parentId: "lin-nobody" } }),
      w.deps,
    );
    expect(await elsewhere.json()).toEqual({ marked: 0 });
    expect(w.refreshed).toEqual([["widgets"]]);
  });

  test("refuses a wrong signature, a replayed delivery, and answers 503 while its secret is not set", async () => {
    const w = await project();
    const payload = { type: "Issue", action: "update", data: { id: "lin-wid-2" } };
    expect((await handleLinearWebhook(w.linear(payload, { secret: "wrong" }), w.deps)).status).toBe(401);
    expect((await handleLinearWebhook(w.linear(payload, { sentAt: T0 - 120_000 }), w.deps)).status).toBe(401);
    const unset = { ...w.deps, secrets: { linear: null, github: GITHUB_SECRET } };
    const res = await handleLinearWebhook(w.linear(payload), unset);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "ARMADA_LINEAR_WEBHOOK_SECRET is not set on this dashboard" });
    expect(w.refreshed).toEqual([]);
  });

  test("a label renamed asks every project for a whole read on its next view, without reading now", async () => {
    const w = await project();
    const res = await handleLinearWebhook(
      w.linear({ type: "IssueLabel", action: "update", data: { id: "l1" } }),
      w.deps,
    );
    expect(await res.json()).toEqual({ marked: "every project" });
    expect(w.refreshed).toEqual([]);
    const background: Promise<unknown>[] = [];
    await loadOverview({ ...w.opts, background: (work) => background.push(work) }, null);
    expect(background).toHaveLength(1);
    await Promise.all(background);
    // Read whole: no incremental read was asked.
    expect(w.asks).toEqual([]);
  });

  test("a failed refresh gives the marks back, so the next one still reads what the webhook named", async () => {
    const w = await project();
    await handleLinearWebhook(
      w.linear({ type: "Attachment", action: "create", data: { issueId: "lin-wid-2" } }),
      w.deps,
    );
    w.fail(true);
    await refreshProject(WIDGETS, w.store, w.opts);
    const [entry] = (await w.store.entries(["widgets"])).values();
    expect(entry).toMatchObject({ dirty: true, error: "Linear: HTTP 503" });
    w.fail(false);
    await refreshProject(WIDGETS, w.store, w.opts);
    expect(w.asks.map((a) => a.touched)).toEqual([["lin-wid-2"], ["lin-wid-2"]]);
    const [after] = (await w.store.entries(["widgets"])).values();
    expect(after).toMatchObject({ dirty: false, error: null });
  });
});

describe("the GitHub App's webhook", () => {
  test("a pull request or check event marks the repository's project; the refresh reads GitHub only", async () => {
    const w = await project();
    for (const event of ["pull_request", "check_run", "status"]) {
      const res = await handleGithubWebhook(w.github(event, { repository: { full_name: "acme/widgets" } }), w.deps);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ marked: 1 });
    }
    expect(w.refreshed).toHaveLength(3);
    await refreshProject(WIDGETS, w.store, w.opts);
    // One refresh for the three deliveries: they only marked it.
    expect(w.asks).toEqual([{ linearSince: null, touched: [], forge: true }]);
  });

  test("refuses a wrong signature; ignores the events that do not change the view", async () => {
    const w = await project();
    const payload = { repository: { full_name: "acme/widgets" } };
    expect((await handleGithubWebhook(w.github("pull_request", payload, "wrong"), w.deps)).status).toBe(401);
    const ping = await handleGithubWebhook(w.github("ping", payload), w.deps);
    expect(await ping.json()).toEqual({ ignored: "ping" });
    const other = await handleGithubWebhook(
      w.github("pull_request", { repository: { full_name: "acme/other" } }),
      w.deps,
    );
    expect(await other.json()).toEqual({ marked: 0 });
    expect(w.refreshed).toEqual([]);
  });
});
