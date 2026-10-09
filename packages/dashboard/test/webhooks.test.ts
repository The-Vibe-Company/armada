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
import { handleGithubWebhook, handleLinearWebhook, refreshMarkedReadings, type WebhookDeps } from "../lib/webhooks.ts";
import { addOrganizations, tempDatabase } from "./support.ts";

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
  const whole: string[] = [];
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
    readConfig: async (p) => ({ config: parseConfig(configTemplate({ ...WIDGETS, ...p })), warning: null }),
    readSnapshot: async (config) => {
      whole.push(config.project.slug);
      const sources = full();
      if (config.project.slug !== WIDGETS.slug)
        sources.program = {
          ...sources.program,
          rootId: config.tracker.programRoot,
          issues: [issue(config.tracker.programRoot)],
        };
      if (sources.forge) sources.forge.repo = config.github.repository;
      return sources;
    },
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
    whole,
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

  test("marked deliveries pulse the project's organization after its refreshed snapshot is stored", async () => {
    const w = await project();
    await addOrganizations(w.db, "org-widgets", "org-other");
    await w.db.query("UPDATE projects SET organization_id = $1 WHERE slug = $2", ["org-widgets", "widgets"]);
    const other = { slug: "gadgets", name: "Gadgets", repository: "acme/gadgets", programRoot: "GAD-1" };
    await upsertProject(w.db, other);
    await w.db.query("UPDATE projects SET organization_id = $1 WHERE slug = $2", ["org-other", "gadgets"]);
    await refreshProject(other, w.store, w.opts);
    const pulses: [string, string][] = [];
    const scopes: (string | null)[] = [];
    w.advance(11_000);
    for (const provider of ["linear", "github"] as const) {
      const delivery =
        provider === "linear"
          ? await handleLinearWebhook(w.linear({ type: "Issue", action: "update", data: { id: "lin-wid-2" } }), w.deps)
          : await handleGithubWebhook(w.github("push", { repository: { full_name: "acme/widgets" } }), w.deps);
      expect(delivery.status).toBe(202);
      const marked = await w.store.entries(["widgets"]);
      expect(marked.get("widgets")?.dirty).toBe(true);
      await refreshMarkedReadings(["widgets", "missing"], {
        db: w.db,
        signedIn: true,
        home: "org-other",
        fleet: (scope) => {
          scopes.push(scope?.organization ?? null);
          return w.opts;
        },
        pulse: async (project, organization) => {
          const stored = (await w.store.entries([project])).get(project);
          expect(stored?.dirty).toBe(false);
          expect(stored?.version).toBeGreaterThan(marked.get(project)?.version ?? 0);
          pulses.push([project, organization]);
        },
      });
      w.advance(11_000);
    }
    expect(scopes).toEqual(["org-widgets", "org-widgets"]);
    expect(pulses).toEqual([
      ["widgets", "org-widgets"],
      ["widgets", "org-widgets"],
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
    const gadgets = { slug: "gadgets", name: "Gadgets", repository: "acme/gadgets", programRoot: "GAD-1" };
    await upsertProject(w.db, gadgets);
    await refreshProject(gadgets, w.store, w.opts);
    const before = await w.store.entries(["widgets", "gadgets"]);
    w.whole.length = 0;
    const res = await handleLinearWebhook(
      w.linear({ type: "IssueLabel", action: "update", data: { id: "l1" } }),
      w.deps,
    );
    expect(await res.json()).toEqual({ marked: "every project" });
    expect(w.refreshed).toEqual([]);
    // The next view more than 10 s after the last read: one whole read per project.
    w.advance(10_000);
    const background: Promise<unknown>[] = [];
    await loadOverview({ ...w.opts, background: (work) => background.push(work) }, null);
    expect(background).toHaveLength(2);
    await Promise.all(background);
    // Both marked projects execute full reads and persist a new generation.
    expect(w.whole.sort()).toEqual(["gadgets", "widgets"]);
    expect(w.asks).toEqual([]);
    const after = await w.store.entries(["widgets", "gadgets"]);
    for (const p of [WIDGETS, gadgets]) {
      const snapshot = after.get(p.slug)?.snapshot;
      expect(snapshot?.config).toMatchObject({
        project: { slug: p.slug },
        tracker: { programRoot: p.programRoot },
        github: { repository: p.repository },
      });
      expect(snapshot?.sources.program.rootId).toBe(p.programRoot);
      expect(snapshot?.sources.program.issues.map((ticket) => ticket.id)).toContain(p.programRoot);
      expect(snapshot?.sources.forge?.repo).toBe(p.repository);
      expect(snapshot?.sources.program.fetchedAt).toBe(new Date(T0 + 10_000).toISOString());
      expect(snapshot?.sources.program.fetchedAt).not.toBe(before.get(p.slug)?.snapshot?.sources.program.fetchedAt);
      expect(after.get(p.slug)?.dirty).toBe(false);
    }
  });

  test("a failed refresh keeps the marks, so the next one still reads what the webhook named", async () => {
    const w = await project();
    await handleLinearWebhook(
      w.linear({ type: "Attachment", action: "create", data: { issueId: "lin-wid-2" } }),
      w.deps,
    );
    w.fail(true);
    await refreshProject(WIDGETS, w.store, w.opts);
    const [entry] = (await w.store.entries(["widgets"])).values();
    expect(entry).toMatchObject({ dirty: true, error: "Linear: HTTP 503" });
    // During the outage, more deliveries do not read again before the period ends.
    w.advance(20_000);
    await refreshProject(WIDGETS, w.store, w.opts, { gapMs: 10_000, retryMs: 600_000 });
    expect(w.asks).toHaveLength(1);
    w.fail(false);
    await refreshProject(WIDGETS, w.store, w.opts);
    expect(w.asks.map((a) => a.touched)).toEqual([["lin-wid-2"], ["lin-wid-2"]]);
    const [after] = (await w.store.entries(["widgets"])).values();
    expect(after).toMatchObject({ dirty: false, error: null });
  });
});

describe("refreshes and their lease", () => {
  test("marks stay until a reading that saw them is written: a refresh cut short loses none, a mark during one is read next", async () => {
    const w = await project();
    await handleLinearWebhook(w.linear({ type: "Issue", action: "update", data: { id: "lin-wid-2" } }), w.deps);
    // A refresh claims, then its function is stopped before it writes anything.
    expect(await w.store.claim("widgets", new Date(T0), 120_000)).not.toBeNull();
    w.advance(121_000);
    await refreshProject(WIDGETS, w.store, w.opts);
    expect(w.asks.map((a) => a.touched)).toEqual([["lin-wid-2"]]);

    // A delivery while a refresh reads: the refresh writes, and the reading stays marked for the next one.
    w.advance(60_000);
    const claim = await w.store.claim("widgets", new Date(T0 + 181_000), 120_000);
    if (!claim) throw new Error("not claimed");
    await handleLinearWebhook(w.linear({ type: "Comment", action: "create", data: { issueId: "lin-wid-1" } }), w.deps);
    const entry = claim.entry;
    if (!entry.snapshot) throw new Error("no reading");
    expect(await w.store.save("widgets", entry.snapshot, claim, { full: false, now: new Date(T0 + 182_000) })).toEqual({
      saved: true,
      dirty: true,
    });
  });

  test("a refresh that outlived its lease does not overwrite the newer reading of the one that took over", async () => {
    const w = await project();
    const slow = await w.store.claim("widgets", new Date(T0 + 1_000), 120_000);
    if (!slow?.entry.snapshot) throw new Error("not claimed");
    const fast = await w.store.claim("widgets", new Date(T0 + 122_000), 120_000);
    if (!fast?.entry.snapshot) throw new Error("not claimed");
    const newer = { ...fast.entry.snapshot, configWarning: "newer" };
    expect((await w.store.save("widgets", newer, fast, { full: false, now: new Date(T0 + 123_000) })).saved).toBe(true);
    const late = { ...slow.entry.snapshot, configWarning: "late" };
    expect((await w.store.save("widgets", late, slow, { full: false, now: new Date(T0 + 150_000) })).saved).toBe(false);
    await w.store.fail("widgets", "late failure", slow);
    const [kept] = (await w.store.entries(["widgets"])).values();
    expect(kept).toMatchObject({ version: 2, error: null, refreshingUntil: null });
    expect(kept?.snapshot?.configWarning).toBe("newer");
  });

  test("a burst of deliveries makes one read; a reading both webhooks keep fresh is refreshed on view every 10 minutes, not every minute", async () => {
    const w = await project();
    const deliver = () =>
      handleGithubWebhook(w.github("check_run", { repository: { full_name: "acme/widgets" } }), w.deps);
    w.advance(10_000);
    await deliver();
    await refreshProject(WIDGETS, w.store, w.opts, { gapMs: 10_000 });
    w.advance(3_000);
    await deliver();
    await refreshProject(WIDGETS, w.store, w.opts, { gapMs: 10_000 });
    expect(w.asks).toHaveLength(1);
    // The second delivery's mark waits for the next view (or delivery) after the gap.
    const [marked] = (await w.store.entries(["widgets"])).values();
    expect(marked?.dirty).toBe(true);

    // Both webhooks reached it today: a view two minutes later finds it fresh.
    await handleLinearWebhook(w.linear({ type: "Issue", action: "update", data: { id: "lin-wid-2" } }), w.deps);
    const view = async () => {
      const background: Promise<unknown>[] = [];
      await loadOverview({ ...w.opts, snapshotMs: 60_000, background: (work) => background.push(work) }, null);
      await Promise.all(background);
      return background.length;
    };
    w.advance(10_000);
    expect(await view()).toBe(1);
    w.advance(120_000);
    expect(await view()).toBe(0);
    w.advance(10 * 60_000);
    expect(await view()).toBe(1);
  });
});

describe("the GitHub App's webhook", () => {
  test("a pull request, check or push event marks the repository's project; the refresh reads GitHub only", async () => {
    const w = await project();
    for (const event of ["pull_request", "check_suite", "check_run", "status", "push"]) {
      const res = await handleGithubWebhook(w.github(event, { repository: { full_name: "acme/widgets" } }), w.deps);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ marked: 1 });
    }
    expect(w.refreshed).toHaveLength(5);
    await refreshProject(WIDGETS, w.store, w.opts);
    // One refresh for the five deliveries: they only marked it.
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
