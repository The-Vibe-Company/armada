import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type ArmadaConfig,
  type ArmadaSignIn,
  armadaApi,
  configTemplate,
  type Fleet,
  fleetClient,
  type Issue,
  type ProjectInput,
  parseConfig,
} from "@armada/core/read";
import { issue } from "../../core/test/support.ts";
import { type Auth, createAuth, type EmailMessage, recordApiKeyCreator } from "../lib/accounts.ts";
import { accountsModeOf } from "../lib/accounts-settings.ts";
import { type CliAccounts, type CliApiDeps, handleCli } from "../lib/cli-api.ts";
import type { Database } from "../lib/db.ts";
import type { Scope } from "../lib/fleet-data.ts";
import { fleetStore, liveStore } from "../lib/fleet-store.ts";
import { saveOwnerChannel } from "../lib/owner-push.ts";
import { addSnapshotIssue, dbSnapshots, memorySnapshots } from "../lib/snapshots.ts";
import { deleteSecret, listEvents, setSecret, vaultModeOf } from "../lib/vault.ts";
import { listWorkers } from "../lib/workers.ts";
import { tempDatabase } from "./support.ts";

// The fleet's live data through the Armada API (THE-850): core's CLI client
// against the real routes, on PGlite. Synthetic people, projects and tickets.
const BASE = "http://localhost:4850";
const OWNER = "owner@example.test";
const PASSWORD = "a synthetic password";
const ENV = {
  ARMADA_DATABASE_URL: "pglite:memory",
  ARMADA_AUTH_SECRET: "a synthetic secret for tests, long enough",
  ARMADA_AUTH_URL: BASE,
  ARMADA_AUTH_OWNER_EMAILS: OWNER,
  NODE_ENV: "test",
};
const WIDGETS: ProjectInput = { slug: "widgets", name: "Widgets", repository: "acme/widgets", programRoot: "WID-1" };
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const start = new Date("2026-10-01T09:00:00Z");
let clock = start.getTime();
const now = () => new Date(clock);

let client: Database;
let auth: Auth;
let accounts: CliAccounts;
const outbox: EmailMessage[] = [];
let ownerToken = "";
let apiKey = "";
let otherKey = "";
const logged: string[] = [];
const original = { info: console.info, warn: console.warn };

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
const as = (cookie: string) => new Headers({ cookie });

beforeAll(async () => {
  console.info = (...a: unknown[]) => void logged.push(a.join(" "));
  console.warn = (...a: unknown[]) => void logged.push(a.join(" "));
  client = await tempDatabase();
  const mode = accountsModeOf(ENV);
  if (mode.kind !== "accounts") throw new Error("test settings incomplete");
  auth = createAuth(mode.settings, { client, sender: { send: async (m) => void outbox.push(m) } });
  accounts = { auth, client, settings: mode.settings };
  await auth.api.signUpEmail({ body: { email: OWNER, name: "Olive Owner", password: PASSWORD } });
  const link = outbox.findLast((m) => m.kind === "verification" && m.to === OWNER);
  const owner = cookiesOf(await auth.handler(new Request(link?.url ?? "")));
  const acme = await auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: as(owner) });
  const globex = await auth.api.createOrganization({ body: { name: "Globex", slug: "globex" }, headers: as(owner) });
  const primaryKey = await auth.api.createApiKey({
    body: { name: "coordinator", organizationId: acme?.id ?? "" },
    headers: as(owner),
  });
  const alternateKey = await auth.api.createApiKey({
    body: { name: "other coordinator", organizationId: globex?.id ?? "" },
    headers: as(owner),
  });
  apiKey = primaryKey.key;
  otherKey = alternateKey.key;
  const ownerSession = await auth.api.getSession({ headers: as(owner) });
  for (const [key, organization] of [
    [primaryKey, acme],
    [alternateKey, globex],
  ])
    await recordApiKeyCreator(client, {
      id: key?.id ?? "",
      organization: organization?.id ?? "",
      user: ownerSession?.user.id ?? "",
      now: now(),
    });
  ownerToken = (await auth.api.signInEmail({ body: { email: OWNER, password: PASSWORD } })).token ?? "";
});

afterAll(async () => {
  Object.assign(console, original);
  await client.end();
});

const deps: Omit<CliApiDeps, "accounts"> = {
  vault: () => vaultModeOf({ ARMADA_SECRETS_KEY: Buffer.alloc(32, 9).toString("base64") }),
  now,
};

/** The terminal's fetch, answered by the routes in this process. */
const fetch = async (url: string, init: RequestInit) =>
  handleCli(new Request(url, init), new URL(url).pathname.replace(/^\/api\/cli\//, "").split("/"), {
    accounts: async () => accounts,
    ...deps,
    readAttachmentTicket: async () => null,
  });
const CLI = "9.9.9";
const api = armadaApi({ url: BASE, fetch, version: CLI });
const fleetOf = (signIn: ArmadaSignIn, project: ProjectInput = WIDGETS): Fleet => fleetClient({ api, signIn, project });

describe("private attachments through the authenticated CLI API", () => {
  test("a coordinator and scoped worker attach to cached tickets; cross-project and cross-ticket calls fail", async () => {
    const coordinator: ArmadaSignIn = { kind: "api-key", key: apiKey };
    await fleetOf(coordinator).register();
    const config = parseConfig(configTemplate(WIDGETS));
    const store = dbSnapshots(client, memorySnapshots());
    const lease = await store.claim(WIDGETS.slug, now(), 60_000);
    if (!lease) throw new Error("snapshot lease missing");
    await store.save(
      WIDGETS.slug,
      {
        startedAt: now(),
        config,
        configWarning: null,
        sources: {
          program: {
            rootId: "WID-1",
            fetchedAt: now().toISOString(),
            issues: [issue("WID-1"), issue("WID-71", { parentId: "WID-1" }), issue("WID-72", { parentId: "WID-1" })],
            comments: [],
            warnings: [],
          },
          forge: null,
          forgeError: null,
        },
      },
      lease,
      { full: true, now: now() },
    );
    const target = {
      project: WIDGETS,
      ticket: "WID-71",
      caption: "Design",
      reference: "owner-item",
      input: { kind: "image" as const, contentType: "image/png", data: "iVBORw0KGgo=" },
    };
    const image = await api.attach(coordinator, target);
    expect(image.url).toContain("/agents/WID-71?tab=attachments&attachment=");
    const session = await worker("WID-71");
    const duplicate = await api.attach(session, target);
    expect(duplicate.attachment.id).toBe(image.attachment.id);
    const link = await api.attach(session, { ...target, input: { kind: "link", url: "https://example.test/design" } });
    expect(link.attachment.kind).toBe("link");
    expect((await refusal(api.attach(session, { ...target, ticket: "WID-72" })))[0]).toBe(403);
    expect((await refusal(api.attach(session, { ...target, project: { ...WIDGETS, slug: "gadgets" } })))[0]).toBe(403);
    expect((await refusal(api.attach(coordinator, { ...target, ticket: "OTHER-1" })))[0]).toBe(403);
    expect((await refusal(api.attach({ kind: "api-key", key: otherKey }, target)))[0]).toBe(403);
    expect(
      await refusal(api.attach(session, { ...target, input: { ...target.input, contentType: "image/jpeg" } })),
    ).toEqual([400, expect.stringContaining("type limit")]);
    expect(
      await refusal(
        api.attach(session, {
          ...target,
          input: { ...target.input, data: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64") },
        }),
      ),
    ).toEqual([413, expect.stringContaining("2 MB")]);
  });

  const freshTarget = (ticket: string) => ({
    project: WIDGETS,
    ticket,
    caption: "Fresh ticket evidence",
    reference: null,
    input: { kind: "image" as const, contentType: "image/png", data: "iVBORw0KGgo=" },
  });
  const withLookup = (lookup: (config: ArmadaConfig, scope: Scope, ticket: string) => Promise<Issue | null>) =>
    armadaApi({
      url: BASE,
      version: CLI,
      fetch: async (url, init) =>
        handleCli(new Request(url, init), ["attachments"], {
          accounts: async () => accounts,
          ...deps,
          readAttachmentTicket: lookup,
        }),
    });

  test("a scoped worker attaches a fresh ticket once checked in Linear, and subsequent uploads use the snapshot", async () => {
    const ticket = "WID-73";
    const session = await worker(ticket);
    const completedAt = now().toISOString();
    const fresh = issue(ticket, { parentId: "WID-1", statusType: "completed", completedAt });
    const calls: string[] = [];
    const attaching = withLookup(async (config, scope, id) => {
      expect(config.tracker.programRoot).toBe(WIDGETS.programRoot);
      expect(scope.organization).toBe(
        String(
          (await client.query("SELECT organization_id FROM projects WHERE slug = $1", [WIDGETS.slug])).rows[0]
            ?.organization_id,
        ),
      );
      calls.push(id);
      return fresh;
    });
    const result = await attaching.attach(session, freshTarget(ticket));
    expect(result.attachment.ticket).toBe(ticket);
    const snapshot = (await dbSnapshots(client, memorySnapshots()).entries([WIDGETS.slug])).get(WIDGETS.slug);
    expect(snapshot?.snapshot?.sources.program.issues).toContainEqual(fresh);
    expect(snapshot?.dirty).toBe(true);
    const done = await client.query("SELECT done_at FROM attachments WHERE id = $1", [result.attachment.id]);
    expect(new Date(String(done.rows[0]?.done_at)).toISOString()).toBe(completedAt);
    await attaching.attach(session, {
      ...freshTarget(ticket),
      input: { kind: "link", url: "https://example.test/fresh" },
    });
    expect(calls).toEqual([ticket]);
  });

  test("concurrent fresh-ticket uploads preserve both cache additions and existing snapshot metadata", async () => {
    const tickets = ["WID-76", "WID-77"];
    const sessions = await Promise.all(tickets.map(worker));
    const store = dbSnapshots(client, memorySnapshots());
    const before = (await store.entries([WIDGETS.slug])).get(WIDGETS.slug);
    const attaching = withLookup(async (_, __, id) => issue(id, { parentId: "WID-1" }));
    await Promise.all(sessions.map((session, n) => attaching.attach(session, freshTarget(tickets[n] ?? ""))));
    const after = (await store.entries([WIDGETS.slug])).get(WIDGETS.slug);
    for (const ticket of tickets)
      expect(after?.snapshot?.sources.program.issues.some((i) => i.id === ticket)).toBe(true);
    expect(after?.snapshot?.config).toEqual(before?.snapshot?.config);
    expect(after?.snapshot?.sources.forge).toEqual(before?.snapshot?.sources.forge);
    expect(after?.snapshot?.startedAt).toEqual(before?.snapshot?.startedAt);
    expect(after?.readAt).toEqual(before?.readAt);
    expect(after?.fullAt).toEqual(before?.fullAt);
    expect(after?.version).toBe((before?.version ?? 0) + 2);
    expect(after?.dirty).toBe(true);
  });

  test("a foreign ticket keeps the existing refusal and is neither cached nor stored", async () => {
    const ticket = "WID-74";
    let calls = 0;
    const attaching = withLookup(async () => {
      calls++;
      return null;
    });
    expect(await refusal(attaching.attach(await worker(ticket), freshTarget(ticket)))).toEqual([
      403,
      `Armada did not attach this item: attachment ticket limit: ${ticket} is not in the cached project reading; refresh the dashboard first`,
    ]);
    expect(calls).toBe(1);
    expect((await client.query("SELECT id FROM attachments WHERE ticket = $1", [ticket])).rows).toEqual([]);
    expect(
      (await dbSnapshots(client, memorySnapshots()).entries([WIDGETS.slug]))
        .get(WIDGETS.slug)
        ?.snapshot?.sources.program.issues.some((i) => i.id === ticket),
    ).toBe(false);
  });

  test("a Linear error is retryable, reveals no upstream details and stores nothing", async () => {
    const ticket = "WID-75";
    let calls = 0;
    const attaching = withLookup(async () => {
      calls++;
      throw new Error("synthetic upstream details");
    });
    expect(await refusal(attaching.attach(await worker(ticket), freshTarget(ticket)))).toEqual([
      503,
      "Armada did not attach this item: Armada cannot check this attachment's ticket in Linear right now",
    ]);
    expect(calls).toBe(1);
    expect((await client.query("SELECT id FROM attachments WHERE ticket = $1", [ticket])).rows).toEqual([]);
  });

  test("cached tickets and scope refusals do not call Linear", async () => {
    let calls = 0;
    const attaching = withLookup(async () => {
      calls++;
      throw new Error("must not read Linear");
    });
    const session = await worker("WID-71");
    await attaching.attach(session, freshTarget("WID-71"));
    expect((await refusal(attaching.attach(session, freshTarget("WID-99"))))[0]).toBe(403);
    expect((await refusal(attaching.attach({ kind: "api-key", key: otherKey }, freshTarget("WID-99"))))[0]).toBe(403);
    expect(
      (
        await refusal(
          attaching.attach(
            { kind: "api-key", key: apiKey },
            { ...freshTarget("WID-99"), project: { ...WIDGETS, programRoot: "WID-999" } },
          ),
        )
      )[0],
    ).toBe(403);
    expect(calls).toBe(0);
  });
});

async function worker(ticket: string): Promise<ArmadaSignIn> {
  const made = await api.launchToken({ kind: "session", token: ownerToken }, { project: WIDGETS.slug, ticket });
  const session = await api.exchangeLaunchToken(made.token);
  return { kind: "worker", token: session.token, ticket, project: WIDGETS.slug };
}

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (err: { status?: number; message?: string }) => [err.status, err.message],
  );

const claim = (ticket: string, handle: string) => ({
  ticket,
  runtime: "Conductor",
  handle,
  branch: `feature/${ticket.toLowerCase()}`,
  phase: "planning" as const,
  resuming: false,
  profile: {
    name: "opus",
    agent: "claude",
    model: "opus-5-5",
    effort: "high",
    fastMode: false,
    routed: null,
    reason: null,
    why: "default_profile",
  },
});

const read = { coordinator: "ws-c/s-c", silentAfterMinutes: 15, etag: null };

/** A first read of the inbox: never "not modified". */
async function inboxOf(f: Fleet) {
  const r = await f.inbox(read);
  if (!r) throw new Error("a first read came back empty");
  return r;
}

describe("the fleet through the Armada API", () => {
  test("a worker with a launch token and a signed-in coordinator run a ticket from claim to merge; no database key anywhere", async () => {
    const coordinator = fleetOf({ kind: "api-key", key: apiKey });
    const w = fleetOf(await worker("WID-7"));

    expect(await w.claim(claim("WID-7", "ws-7/s-1"))).toEqual([]);
    await w.report({
      ticket: "WID-7",
      phase: "awaiting-approval",
      previous: "planning",
      summary: "plan",
      message: "plan\n\n1. Build.\n2. Test.",
      prUrl: null,
      headSha: null,
    });
    const plan = (await inboxOf(coordinator)).items;
    expect(plan.map((e) => [e.kind, e.ticket, e.author, e.body])).toEqual([
      ["plan", "WID-7", "ws-7/s-1", "plan\n\n1. Build.\n2. Test."],
    ]);
    expect(await coordinator.answer({ text: "approved", note: false, ticket: "WID-7", item: plan[0]?.id ?? 0 })).toBe(
      `Inbox item #${plan[0]?.id} resolved.`,
    );

    clock += 60_000;
    const question = await w.ask({ ticket: "WID-7", body: "Which store?" });
    expect((await coordinator.inboxItem(question))?.kind).toBe("question");
    expect((await coordinator.ticketItems("WID-7")).map((i) => i.id)).toEqual([question]);
    await coordinator.answer({ text: "SQLite", note: false, ticket: "WID-7", item: null });
    // The worker shows the owner its work (THE-885): the approval link is the dashboard's.
    const shown = await w.validate({
      ticket: "WID-7",
      kind: "validation",
      what: "The new card, two directions",
      reason: null,
      choices: null,
      pr: null,
      attachments: [],
    });
    expect(shown.url).toBe(`${BASE}/approve/${shown.validation.id}`);
    expect((await coordinator.validations({ ticket: "WID-7" })).map((v) => [v.id, v.author])).toEqual([
      [shown.validation.id, "ws-7/s-1"],
    ]);
    await w.report({
      ticket: "WID-7",
      phase: "ready-to-merge",
      previous: "shipping",
      summary: `PR #9, head ${HEAD}, CI green`,
      message: "",
      prUrl: "https://github.com/acme/widgets/pull/9",
      headSha: HEAD,
    });
    expect((await inboxOf(coordinator)).items.map((e) => e.kind)).toEqual(["hand-back"]);

    // The merge lock, then the merge's record: the session is released and the hand-back resolved.
    expect(await coordinator.acquireLease({ name: "merge", holder: "c-1", ttlMs: 60_000 })).toEqual({ acquired: true });
    const merged = await coordinator.merge({
      ticket: "WID-7",
      number: 9,
      url: "https://github.com/acme/widgets/pull/9",
      mergeCommit: "5555555555555555555555555555555555555555",
      headSha: HEAD,
    });
    expect([merged.handle?.handle, merged.resolved, merged.open]).toEqual(["ws-7/s-1", 1, []]);
    await coordinator.releaseLease({ name: "merge", holder: "c-1" });

    // What the dashboard reads: the same rows, the server's times.
    const live = liveStore(client);
    expect((await live.listProjects()).map((p) => [p.slug, p.organization !== null])).toEqual([["widgets", true]]);
    expect(await live.latestEvents("widgets", { since: start })).toMatchObject({
      "WID-7": { kind: "merge", phase: "merged", at: new Date(clock).toISOString() },
    });
    // The coordinator's presence, with the CLI version its inbox reads sent.
    expect(await live.coordinatorPresence("widgets")).toEqual({
      seenAt: new Date(clock).toISOString(),
      cliVersion: CLI,
    });
    expect(await fleetStore(client).getWorkerProfile("widgets", "WID-7")).toBeNull();
    expect(await coordinator.lastEventTimes()).toEqual({ "WID-7": new Date(clock).toISOString() });
  });

  test("a worker session acts on its own ticket and project only", async () => {
    const signIn = await worker("WID-8");
    const w = fleetOf(signIn);
    expect(await refusal(w.claim(claim("WID-9", "ws-9")))).toEqual([
      403,
      "Armada refused: a worker session only claims, reports, asks, validates and releases its own ticket (WID-8), not WID-9",
    ]);
    expect((await refusal(w.inbox(read)))[0]).toBe(403);
    expect((await refusal(w.acquireLease({ name: "merge", holder: "w", ttlMs: 60_000 })))[0]).toBe(403);
    const elsewhere = fleetOf(signIn, { ...WIDGETS, slug: "gadgets", repository: "acme/gadgets" });
    expect(await refusal(elsewhere.claim(claim("WID-8", "ws-8")))).toEqual([
      403,
      "Armada refused: this worker session is for the project widgets, not gadgets",
    ]);
    expect((await refusal(api.projects(signIn)))[0]).toBe(403);
    // Released, the session ends: its next command is refused.
    await w.release({ ticket: "WID-8", reason: "done" });
    await api.signOut(signIn);
    expect((await refusal(w.claim(claim("WID-8", "ws-8"))))[0]).toBe(401);
  });

  test("signed out, or for another organization's project, nothing is read or written", async () => {
    expect(await refusal(fleetOf({ kind: "api-key", key: "armada_not_a_key" }).claim(claim("WID-1", "ws-1")))).toEqual([
      401,
      "this Armada API key is not valid: it was revoked, or never existed",
    ]);
    // widgets belongs to Acme: Globex's coordinator is refused, and registers its own projects.
    const other = fleetOf({ kind: "api-key", key: otherKey });
    expect(await refusal(other.inbox(read))).toEqual([
      403,
      "Armada refused: the project widgets belongs to another organization",
    ]);
    await fleetOf({ kind: "api-key", key: otherKey }, { ...WIDGETS, slug: "rockets", name: "Rockets" }).register();
    expect((await api.projects({ kind: "api-key", key: otherKey })).map((p) => p.slug)).toEqual(["rockets"]);
    expect((await api.projects({ kind: "api-key", key: apiKey })).map((p) => p.slug)).toEqual(["widgets"]);
    // A project registered without an organization (`bun run db register`) is the first organization's only.
    const legacy = { ...WIDGETS, slug: "legacy", repository: "acme/legacy" };
    await fleetStore(client).upsertProject(legacy, now());
    expect(await refusal(fleetOf({ kind: "api-key", key: otherKey }, legacy).register())).toEqual([
      403,
      "Armada refused: the project legacy belongs to another organization",
    ]);
    await fleetOf({ kind: "api-key", key: apiKey }, legacy).register();
    expect((await api.projects({ kind: "api-key", key: apiKey })).map((p) => p.slug)).toEqual(["legacy", "widgets"]);
    // A malformed project is refused before anything is written.
    const bad = await fetch(`${BASE}/api/cli/fleet/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ project: { slug: "Not A Slug" }, input: {} }),
    });
    expect(bad.status).toBe(400);
  });

  test("an unchanged inbox is answered 304 Not Modified, with no body; a change is answered in full", async () => {
    const coordinator = fleetOf({ kind: "api-key", key: apiKey });
    const w = fleetOf(await worker("WID-10"));
    await w.claim(claim("WID-10", "ws-10"));
    const first = await inboxOf(coordinator);
    const raw = await fetch(`${BASE}/api/cli/fleet/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ project: WIDGETS, input: { ...read, etag: first.etag } }),
    });
    expect([raw.status, await raw.text(), raw.headers.get("cache-control")]).toEqual([304, "", "no-store"]);
    // A worker turning silent is a new entry; then its minutes change, its entry does not: not modified.
    clock += 35 * 60_000;
    const silent = await coordinator.inbox({ ...read, etag: first.etag });
    expect(silent?.items.map((e) => [e.kind, e.ticket])).toContainEqual(["silent", "WID-10"]);
    clock += 5 * 60_000;
    expect(await coordinator.inbox({ ...read, etag: silent?.etag ?? null })).toBeNull();
    await w.ask({ ticket: "WID-10", body: "Now?" });
    const changed = await coordinator.inbox({ ...read, etag: silent?.etag ?? null });
    expect(changed?.items.map((e) => e.body)).toContain("Now?");
    // The workers in flight are part of the read: the last one leaving is a change `armada watch` sees.
    expect(changed?.inFlight).toContain("WID-10");
    await w.release({ ticket: "WID-10", reason: "done" });
    const left = await coordinator.inbox({ ...read, etag: changed?.etag ?? null });
    expect(left?.inFlight).not.toContain("WID-10");
  });

  test("a coordinator binds one launch session, keeps it through sign-in and refuses a different or ended binding", async () => {
    const signIn = { kind: "session" as const, token: ownerToken };
    const coordinator = fleetOf(signIn);
    await coordinator.register();
    const made = await api.launchToken(signIn, { project: WIDGETS.slug, ticket: "WID-95" });
    const binding = { ...made.worker, runtime: "conductor" as const, handle: "ws-95/session-1" };
    await api.bindLaunch(signIn, binding);
    await api.bindLaunch({ kind: "api-key", key: apiKey }, binding);
    expect(await refusal(api.bindLaunch(signIn, { ...binding, handle: "ws-95/session-2" }))).toEqual([
      409,
      expect.stringContaining("different session"),
    ]);
    expect(await refusal(api.bindLaunch(signIn, { ...binding, runtime: "herdr" }))).toEqual([
      409,
      expect.stringContaining("different session"),
    ]);
    expect(await refusal(api.bindLaunch({ kind: "api-key", key: otherKey }, binding))).toEqual([
      403,
      expect.stringContaining("organization"),
    ]);
    expect(await refusal(api.bindLaunch(signIn, { ...binding, ticket: "WID-96" }))).toEqual([
      409,
      expect.stringContaining("ended or unknown"),
    ]);
    expect(await refusal(api.bindLaunch(signIn, { ...binding, handle: "" }))).toEqual([
      400,
      expect.stringContaining("runtime and session"),
    ]);
    expect(await coordinator.pendingLaunches()).toContainEqual(
      expect.objectContaining({
        id: made.worker.id,
        ticket: "WID-95",
        runtime: "conductor",
        handle: binding.handle,
        tokenUsedAt: null,
      }),
    );
    const session = await api.exchangeLaunchToken(made.token, "ws-95/session-2");
    const workerSignIn = { kind: "worker" as const, token: session.token, ticket: "WID-95", project: WIDGETS.slug };
    expect(await refusal(api.bindLaunch(workerSignIn, binding))).toEqual([403, expect.stringContaining("worker")]);
    const organization = session.organization.id;
    const worker = (await listWorkers(client, organization)).find((w) => w.id === made.worker.id);
    expect(worker).toMatchObject({ runtime: "conductor", handle: binding.handle });
    expect(worker?.runtimeMismatch).toContain("ws-95/session-2");
    expect(
      (await listEvents(client, organization)).filter((e) => e.actor.id === made.worker.id).map((e) => e.detail),
    ).toContainEqual(expect.stringContaining("runtime session mismatch"));
    await api.bindLaunch(signIn, binding);
    const fast = await api.launchToken(signIn, { project: WIDGETS.slug, ticket: "WID-97" });
    await api.exchangeLaunchToken(fast.token, "ws-97/session-1");
    await api.bindLaunch(signIn, { ...fast.worker, runtime: "conductor", handle: "ws-97/session-1" });
    expect(await coordinator.pendingLaunches()).toContainEqual(
      expect.objectContaining({
        ticket: "WID-97",
        runtime: "conductor",
        handle: "ws-97/session-1",
      }),
    );
    await api.endWorkers(signIn, { project: WIDGETS.slug, ticket: "WID-97", reason: "released" });
    await api.endWorkers(signIn, { project: WIDGETS.slug, ticket: "WID-95", reason: "released" });
    expect(await refusal(api.bindLaunch(signIn, binding))).toEqual([409, expect.stringContaining("ended or unknown")]);
  });

  test("a launch no claim followed is in flight, then not started, told apart by its token's use; its claim or its end clears it", async () => {
    clock = start.getTime() + 2 * 24 * 60 * 60_000;
    const coordinator = fleetOf({ kind: "api-key", key: apiKey });
    const launch = (ticket: string) =>
      api.launchToken({ kind: "session", token: ownerToken }, { project: WIDGETS.slug, ticket });
    await launch("WID-70"); // never used
    const signedIn = await launch("WID-71");
    const claimed = await launch("WID-72");
    clock += 60_000;
    await api.exchangeLaunchToken(signedIn.token, "ws-71/s-1");
    const session = await api.exchangeLaunchToken(claimed.token);
    await fleetOf({ kind: "worker", token: session.token, ticket: "WID-72", project: WIDGETS.slug }).claim(
      claim("WID-72", "ws-72"),
    );
    const young = await inboxOf(coordinator);
    expect(young.items.filter((e) => e.kind === "not-started")).toEqual([]);
    expect(young.inFlight).toEqual(["WID-70", "WID-71", "WID-72"]);

    clock += 14 * 60_000;
    const late = await inboxOf(coordinator);
    expect(late.items.map((e) => [e.kind, e.ticket, e.author])).toEqual([
      ["not-started", "WID-70", null],
      ["not-started", "WID-71", "ws-71/s-1"],
    ]);
    expect(late.items[0]?.body).toContain("its launch token was never used");
    expect(late.items[1]?.body).toContain("the worker signed in with its launch token at 09:01 UTC");
    expect((await coordinator.pendingLaunches()).map((l) => [l.ticket, l.handle])).toEqual([
      ["WID-70", null],
      ["WID-71", "ws-71/s-1"],
    ]);

    // Ended (released, merged or revoked), a launch is no longer followed.
    await api.endWorkers(
      { kind: "session", token: ownerToken },
      { project: WIDGETS.slug, ticket: "WID-70", reason: "released" },
    );
    // Briefed again while its worker holds it, a ticket starts nobody new.
    await launch("WID-72");
    clock += 11 * 60_000;
    const after = await inboxOf(coordinator);
    expect(after.items.filter((e) => e.kind === "not-started").map((e) => e.ticket)).toEqual(["WID-71"]);
    // Shown as not started, a launch no longer holds the watch: its entry does.
    expect(after.inFlight).toEqual(["WID-72"]);
  });

  test("launch revoke ends only the newest pending launch with the Workers-page audit, and refuses claims", async () => {
    clock = start.getTime() + 3 * 24 * 60 * 60_000;
    const signIn: ArmadaSignIn = { kind: "session", token: ownerToken };
    const coordinator = fleetOf(signIn);
    const target = { project: WIDGETS.slug, ticket: "WID-80" };
    const older = await api.launchToken(signIn, target);
    clock += 60_000;
    const newest = await api.launchToken(signIn, target);
    const session = await api.exchangeLaunchToken(newest.token, "ws-80/s-1");
    expect(await refusal(api.revokeLaunch({ kind: "api-key", key: otherKey }, target))).toEqual([
      404,
      expect.stringContaining("no pending launch"),
    ]);
    const revoked = await api.revokeLaunch(signIn, target);
    expect(revoked.ticket).toBe("WID-80");
    expect((await coordinator.pendingLaunches()).some((launch) => launch.ticket === "WID-80")).toBe(false);
    expect(
      await refusal(api.whoami({ kind: "worker", token: session.token, project: WIDGETS.slug, ticket: "WID-80" })),
    ).toEqual([401, expect.stringContaining("cut off from Armada")]);
    const history = await client.query(
      'SELECT "endReason", "endedAt" FROM "armada_worker" WHERE "ticket" = $1 ORDER BY "createdAt"',
      [target.ticket],
    );
    expect(history.rows[0]?.endedAt).toBeNull();
    expect(history.rows[1]?.endReason).toBe("revoked");
    expect((await api.exchangeLaunchToken(older.token)).worker.ticket).toBe("WID-80");
    const audit = await client.query('SELECT detail FROM "armada_secret_event" WHERE action = $1 AND project = $2', [
      "end",
      WIDGETS.slug,
    ]);
    expect(audit.rows.map((row) => row.detail)).toContain("worker session of widgets WID-80 revoked");
    expect(await refusal(api.revokeLaunch(signIn, target))).toEqual([
      404,
      expect.stringContaining("no pending launch"),
    ]);

    const claimed = await worker("WID-81");
    await fleetOf(claimed).claim(claim("WID-81", "ws-81"));
    await api.launchToken(signIn, { project: WIDGETS.slug, ticket: "WID-81" });
    expect(await refusal(api.revokeLaunch(signIn, { project: WIDGETS.slug, ticket: "WID-81" }))).toEqual([
      409,
      expect.stringContaining("already claimed"),
    ]);
    expect((await api.whoami(claimed)).worker?.ticket).toBe("WID-81");

    const unusedTarget = { project: WIDGETS.slug, ticket: "WID-82" };
    const unused = await api.launchToken(signIn, unusedTarget);
    expect((await api.revokeLaunch({ kind: "api-key", key: apiKey }, unusedTarget)).ticket).toBe("WID-82");
    expect(await refusal(api.exchangeLaunchToken(unused.token))).toEqual([401, expect.stringContaining("revoked")]);
    expect(await refusal(api.revokeLaunch(claimed, unusedTarget))).toEqual([403, expect.stringContaining("worker")]);
  });

  test("failed-launch cleanup ends its own unused token even after a newer launch claims", async () => {
    clock = start.getTime() + 3 * 24 * 60 * 60_000 + 60 * 60_000;
    const signIn: ArmadaSignIn = { kind: "session", token: ownerToken };
    const target = { project: WIDGETS.slug, ticket: "WID-83" };
    const failed = await api.launchToken(signIn, target);
    clock += 60_000;
    const newer = await api.launchToken(signIn, target);
    const session = await api.exchangeLaunchToken(newer.token);
    const live: ArmadaSignIn = { kind: "worker", token: session.token, ...target };
    await fleetOf(live).claim(claim(target.ticket, "ws-83"));
    const cleanup = { ...target, id: failed.worker.id };
    expect(await refusal(api.revokePendingLaunch({ kind: "api-key", key: otherKey }, cleanup))).toEqual([
      404,
      expect.stringContaining("no pending launch"),
    ]);
    expect(await refusal(api.revokePendingLaunch(signIn, { ...cleanup, ticket: "WID-84" }))).toEqual([
      404,
      expect.stringContaining("no pending launch"),
    ]);
    expect(await refusal(api.revokePendingLaunch(live, cleanup))).toEqual([403, expect.stringContaining("worker")]);
    expect(await refusal(api.revokePendingLaunch(signIn, { ...cleanup, id: "" }))).toEqual([
      400,
      expect.stringContaining("needs its id"),
    ]);
    await api.revokePendingLaunch(signIn, cleanup);
    expect(await refusal(api.exchangeLaunchToken(failed.token))).toEqual([401, expect.stringContaining("revoked")]);
    expect((await api.whoami(live)).worker?.id).toBe(newer.worker.id);
    expect(await refusal(api.revokePendingLaunch(signIn, { ...target, id: newer.worker.id }))).toEqual([
      409,
      expect.stringContaining("already claimed"),
    ]);
  });

  test("an unused token expires after its grace hour, shows once even with the old ETag, then clears; exchanged launches age out at 24 h", async () => {
    clock = start.getTime() + 4 * 24 * 60 * 60_000;
    const launchedAt = clock;
    const signIn: ArmadaSignIn = { kind: "session", token: ownerToken };
    const coordinator = fleetOf(signIn);
    await api.launchToken(signIn, { project: WIDGETS.slug, ticket: "WID-90" });
    await api.launchToken({ kind: "api-key", key: otherKey }, { project: WIDGETS.slug, ticket: "WID-92" });
    const exchanged = await api.launchToken(signIn, { project: WIDGETS.slug, ticket: "WID-91" });
    await api.exchangeLaunchToken(exchanged.token, "ws-91/s-1");
    clock += 120 * 60_000;
    const grace = await inboxOf(coordinator);
    expect(grace.items.find((entry) => entry.ticket === "WID-90")?.body).not.toContain("token expired");
    clock += 1;
    const concurrent = await Promise.all([
      coordinator.inbox({ ...read, etag: grace.etag }),
      coordinator.inbox({ ...read, etag: grace.etag }),
    ]);
    const notices = concurrent.flatMap((answer) => answer?.items ?? []).filter((entry) => entry.ticket === "WID-90");
    expect(notices).toHaveLength(1);
    const expired = concurrent.find((answer) => answer?.items.some((entry) => entry.ticket === "WID-90"));
    expect(expired?.items.find((entry) => entry.ticket === "WID-90")?.body).toContain("not started (token expired)");
    expect(expired?.inFlight).not.toContain("WID-90");
    expect(expired?.items.some((entry) => entry.ticket === "WID-92")).toBe(false);
    const foreign = await client.query('SELECT "endReason" FROM "armada_worker" WHERE "ticket" = $1', ["WID-92"]);
    expect(foreign.rows[0]?.endReason).toBeNull();
    const cleared = await inboxOf(coordinator);
    expect(cleared.items.some((entry) => entry.ticket === "WID-90")).toBe(false);
    expect((await coordinator.pendingLaunches()).map((launch) => launch.ticket)).toContain("WID-91");
    clock = launchedAt + 24 * 60 * 60_000 + 1;
    expect((await coordinator.pendingLaunches()).map((launch) => launch.ticket)).not.toContain("WID-91");
    const afterWindow = await inboxOf(coordinator);
    expect(afterWindow.items.some((entry) => entry.ticket === "WID-91")).toBe(false);
    expect(afterWindow.inFlight).not.toContain("WID-91");
    expect((await api.revokeLaunch(signIn, { project: WIDGETS.slug, ticket: "WID-91" })).ticket).toBe("WID-91");
  });

  test("the masked token of the brief's human view is named as such, not as an invalid token", async () => {
    const res = await fetch(`${BASE}/api/cli/launch-tokens/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "armada_launch_••••" }),
    });
    expect([res.status, await res.json()]).toEqual([
      400,
      {
        error: "this is the masked token from `armada brief`'s human view, not a launch token",
        next: "ask the coordinator for the `armada brief <ticket> --prompt` text: only it carries the token",
      },
    ]);
  });

  test("the inbox reconciles the stored snapshot before checking its ETag, without external reads", async () => {
    const coordinator = fleetOf({ kind: "api-key", key: apiKey });
    const store = fleetStore(client);
    await store.putHandBack({
      project: WIDGETS.slug,
      ticket: "WID-101",
      author: null,
      body: "Agent status: ready-to-merge — PR #91, head abc",
      at: now(),
    });
    await store.putHandBack({ project: WIDGETS.slug, ticket: "WID-102", author: null, body: "PR #92", at: now() });
    const stale = (await coordinator.ticketItems("WID-101"))[0]?.id;
    if (!stale) throw new Error("missing hand-back");
    await store.saveRuntimeHandle({
      project: WIDGETS.slug,
      ticket: "WID-101",
      runtime: "conductor",
      handle: "ws/stale-merge",
      branch: null,
      at: now(),
    });
    const before = await inboxOf(coordinator);
    expect(before.items.some((i) => i.id === stale)).toBe(true);
    expect(before.inFlight).toContain("WID-101");
    const snapshots = dbSnapshots(client, memorySnapshots());
    const lease = await snapshots.claim(WIDGETS.slug, now(), 60_000);
    if (!lease) throw new Error("missing snapshot lease");
    await snapshots.save(
      WIDGETS.slug,
      {
        startedAt: now(),
        config: parseConfig(configTemplate(WIDGETS)),
        configWarning: null,
        sources: {
          program: {
            rootId: WIDGETS.programRoot,
            fetchedAt: now().toISOString(),
            issues: [issue("WID-1"), issue("WID-101", { parentId: "WID-1", statusType: "completed" })],
            comments: [],
            warnings: [],
          },
          forge: {
            repo: WIDGETS.repository,
            fetchedAt: now().toISOString(),
            prs: [
              {
                number: 91,
                repo: WIDGETS.repository,
                url: "https://github.com/acme/widgets/pull/91",
                title: "Synthetic merge",
                state: "merged",
              },
            ],
            warnings: [],
          },
          forgeError: null,
        },
      },
      lease,
      { full: true, now: now() },
    );
    const healed = await coordinator.inbox({ ...read, etag: before.etag });
    expect(healed).not.toBeNull();
    expect(healed?.items.some((i) => i.id === stale)).toBe(false);
    expect(healed?.inFlight).not.toContain("WID-101");
    expect((await store.getRuntimeHandle(WIDGETS.slug, "WID-101"))?.releasedAt).toBeNull();
    expect(healed?.items.some((i) => i.ticket === "WID-102")).toBe(true);
    expect(await coordinator.inboxItem(stale)).toMatchObject({
      resolution: "resolved: PR merged",
      resolvedAt: now().toISOString(),
    });
    expect(await coordinator.inbox({ ...read, etag: healed?.etag ?? null })).toBeNull();
    await coordinator.resolve({
      id: (await coordinator.ticketItems("WID-102"))[0]?.id ?? 0,
      resolution: "test complete",
    });
  });

  test("two coordinators taking the merge lock at once: one gets it, the other waits for it", async () => {
    const a = fleetOf({ kind: "api-key", key: apiKey });
    const b = fleetOf({ kind: "session", token: ownerToken });
    const lease = { name: "merge", ttlMs: 20 * 60_000 };
    const [first, second] = await Promise.all([
      a.acquireLease({ ...lease, holder: "coordinator-a" }),
      b.acquireLease({ ...lease, holder: "coordinator-b" }),
    ]);
    expect([first.acquired, second.acquired].sort()).toEqual([false, true]);
    const [winner, loser] = first.acquired ? [a, b] : [b, a];
    const [won, lost] = first.acquired ? ["coordinator-a", "coordinator-b"] : ["coordinator-b", "coordinator-a"];
    expect(first.acquired ? second : first).toMatchObject({ acquired: false, held: { holder: won } });
    expect(await loser.renewLease({ ...lease, holder: lost })).toBe(false);
    await winner.releaseLease({ name: "merge", holder: won });
    expect(await loser.acquireLease({ ...lease, holder: lost })).toEqual({ acquired: true });
    // A lease beyond an hour is refused.
    expect((await refusal(a.acquireLease({ ...lease, holder: "x", ttlMs: 2 * 3_600_000 })))[0]).toBe(400);
    expect(logged.join("\n")).not.toContain(apiKey);
  });
});

test("digest reads and sends use organization scope and keep the channel address server-side", async () => {
  const signIn: ArmadaSignIn = { kind: "api-key", key: apiKey };
  const fleet = fleetOf(signIn);
  const printed = await fleet.digest({ since: null, language: "fr" });
  expect(printed.text).toContain("flotte");
  expect((await refusal(fleet.sendDigest({ since: null })))[1]).toContain("Notifications");
  const scoped = await worker("WID-91");
  expect((await refusal(fleetOf(scoped).digest({ since: null })))[0]).toBe(403);
  expect((await refusal(fleetOf(scoped).sendDigest({ since: null })))[0]).toBe(403);
  expect((await refusal(fleetOf({ kind: "api-key", key: otherKey }).digest({ since: null })))[0]).toBe(403);
  const org = (await client.query(`SELECT organization_id FROM projects WHERE slug = $1`, [WIDGETS.slug])).rows[0]
    ?.organization_id;
  const mode = deps.vault?.();
  if (mode?.kind !== "on") throw new Error("synthetic vault missing");
  await saveOwnerChannel(client, {
    organization: String(org),
    project: WIDGETS.slug,
    format: "slack",
    alerts: false,
    digest: { times: [], days: [1, 2, 3, 4, 5], skipQuiet: false },
    timeZone: "UTC",
    language: "fr",
    quiet: null,
    url: "https://hooks.example.test/private-digest-address",
    signingSecret: "",
    actor: { kind: "person", id: "synthetic", label: "Olive" },
    now: now(),
    vault: mode.key,
  });
  let payload = "";
  const sendingApi = armadaApi({
    url: BASE,
    fetch: (url, init) =>
      handleCli(new Request(url, init), new URL(url).pathname.replace(/^\/api\/cli\//, "").split("/"), {
        accounts: async () => accounts,
        ...deps,
        ownerFetch: async (_url, options) => {
          payload = String(options?.body);
          return new Response(null, { status: 200 });
        },
      }),
  });
  const sent = await fleetClient({ api: sendingApi, signIn, project: WIDGETS }).sendDigest({
    since: null,
    language: "fr",
  });
  expect(sent.sent).toBe(true);
  expect(JSON.parse(payload).text).toContain("flotte");
  expect(JSON.stringify(sent)).not.toContain("private-digest-address");
});

test("older callers' prose and captions are masked with scoped vault values before persistence", async () => {
  clock += 60_000;
  const coordinator: ArmadaSignIn = { kind: "api-key", key: apiKey };
  const f = fleetOf(coordinator);
  const organization = (await api.whoami(coordinator)).organization?.id ?? "";
  const mode = deps.vault?.();
  if (mode?.kind !== "on") throw new Error("missing vault");
  const value = "synthetic-arbitrary-project-value";
  const target = {
    organization,
    project: WIDGETS.slug,
    name: "CUSTOM_KEY",
    user: null,
    actor: { kind: "person" as const, id: "owner", label: "Olive Owner" },
    now: now(),
  };
  await setSecret(client, mode.key, { ...target, value });
  try {
    const session = await worker("WID-78");
    const wf = fleetOf(session);
    await wf.claim(claim("WID-78", "ws/masked"));
    await wf.report({
      ticket: "WID-78",
      phase: "implementing",
      previous: "planning",
      summary: value,
      message: "sk-synthetic-unknown",
      prUrl: null,
      headSha: null,
    });
    await wf.ask({ ticket: "WID-78", body: value });
    await f.answer({ ticket: "WID-78", text: value, item: null, note: true });
    await wf.validate({
      ticket: "WID-78",
      kind: "validation",
      what: value,
      reason: null,
      choices: [value, "fine"],
      pr: null,
      attachments: [],
    });
    await addSnapshotIssue(client, parseConfig(configTemplate(WIDGETS)), issue("WID-78", { parentId: "WID-1" }));
    const attachment = await api.attach(coordinator, {
      project: WIDGETS,
      ticket: "WID-78",
      caption: value,
      reference: null,
      input: { kind: "link", url: "https://example.test/masked-evidence" },
    });
    expect(attachment.attachment.caption).toBe("«secret CUSTOM_KEY»");
    const rows = await client.query("SELECT message FROM events WHERE ticket = $1", ["WID-78"]);
    expect(JSON.stringify(rows.rows)).not.toContain(value);
    expect(JSON.stringify(rows.rows)).not.toContain("sk-synthetic-unknown");
    expect(JSON.stringify(rows.rows)).toContain("«secret CUSTOM_KEY»");
    expect(JSON.stringify(await f.validations({ ticket: "WID-78" }))).not.toContain(value);
    // An unreadable vault refuses the write, rather than storing raw text.
    const response = await handleCli(
      new Request(`${BASE}/api/cli/fleet/ask`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({ project: WIDGETS, input: { ticket: "WID-78", body: value } }),
      }),
      ["fleet", "ask"],
      { accounts: async () => accounts, vault: () => ({ kind: "off" }), now },
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(value);
  } finally {
    await deleteSecret(client, target);
  }
});
