import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ArmadaSignIn, armadaApi, type Fleet, fleetClient, type ProjectInput } from "@armada/core/read";
import { type Auth, createAuth, type EmailMessage, recordApiKeyCreator } from "../lib/accounts.ts";
import { accountsModeOf } from "../lib/accounts-settings.ts";
import { type CliAccounts, type CliApiDeps, handleCli } from "../lib/cli-api.ts";
import type { Database } from "../lib/db.ts";
import { fleetStore, liveStore } from "../lib/fleet-store.ts";
import { vaultModeOf } from "../lib/vault.ts";
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
  });
const CLI = "9.9.9";
const api = armadaApi({ url: BASE, fetch, version: CLI });
const fleetOf = (signIn: ArmadaSignIn, project: ProjectInput = WIDGETS): Fleet => fleetClient({ api, signIn, project });

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
      "Armada refused: a worker session only claims, reports, asks and releases its own ticket (WID-8), not WID-9",
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
    clock += 20 * 60_000;
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
