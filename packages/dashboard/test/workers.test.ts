import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Auth, createAuth, type EmailMessage } from "../lib/accounts.ts";
import { accountsModeOf } from "../lib/accounts-settings.ts";
import type { Release } from "../lib/broker.ts";
import { type CliAccounts, type CliIdentity, handleCli } from "../lib/cli-api.ts";
import type { Database } from "../lib/db.ts";
import { fleetStore, getRuntimeHandle, saveRuntimeHandle } from "../lib/fleet-store.ts";
import { listEvents, setSecret, type VaultKey, vaultModeOf } from "../lib/vault.ts";
import { EXCHANGES_PER_MINUTE, endWorker, listWorkers, workerState } from "../lib/workers.ts";
import { tempDatabase } from "./support.ts";

// Synthetic people, projects, tickets and keys, for these tests only.
const BASE = "http://localhost:4841";
const OWNER = "owner@example.test";
const MEMBER = "member@example.test";
const PASSWORD = "a synthetic password";
const ORG_LINEAR = "lin_api_synthetic_org_0841";
const OWN_LINEAR = "lin_api_synthetic_own_0841";
const ENV = {
  ARMADA_DATABASE_URL: "pglite:memory",
  ARMADA_AUTH_SECRET: "a synthetic secret for tests, long enough",
  ARMADA_AUTH_URL: BASE,
  ARMADA_AUTH_OWNER_EMAILS: OWNER,
  NODE_ENV: "test",
};
const vaultMode = vaultModeOf({ ARMADA_SECRETS_KEY: Buffer.alloc(32, 7).toString("base64") });
const vault = (vaultMode.kind === "on" ? vaultMode.key : null) as VaultKey;
const start = new Date("2026-09-30T12:00:00Z");
let now = start;
const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

let client: Database;
let auth: Auth;
let accounts: CliAccounts;
const outbox: EmailMessage[] = [];
let orgId = "";
let ownerToken = "";
let memberToken = "";
let apiKey = "";
/** Every token handed out, which no log line and no stored row may contain. */
const tokens: string[] = [];
const logged: string[] = [];
const original = { info: console.info, warn: console.warn, error: console.error };

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
const as = (cookie: string) => new Headers({ cookie });

async function signUp(email: string, name: string): Promise<string> {
  await auth.api.signUpEmail({ body: { email, name, password: PASSWORD } });
  const link = outbox.findLast((m) => m.kind === "verification" && m.to === email);
  return cookiesOf(await auth.handler(new Request(link?.url ?? "")));
}

beforeAll(async () => {
  console.info = (...a: unknown[]) => void logged.push(a.join(" "));
  console.warn = (...a: unknown[]) => void logged.push(a.join(" "));
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  client = await tempDatabase();
  const mode = accountsModeOf(ENV);
  if (mode.kind !== "accounts") throw new Error("test settings incomplete");
  auth = createAuth(mode.settings, { client, sender: { send: async (m) => void outbox.push(m) } });
  accounts = { auth, client, settings: mode.settings };
  const owner = await signUp(OWNER, "Olive Owner");
  orgId = (await auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: as(owner) }))?.id ?? "";
  const invitation = await auth.api.createInvitation({
    body: { email: MEMBER, role: "member", organizationId: orgId },
    headers: as(owner),
  });
  const member = await signUp(MEMBER, "Mia Member");
  await auth.api.acceptInvitation({ body: { invitationId: invitation.id }, headers: as(member) });
  ownerToken = (await auth.api.signInEmail({ body: { email: OWNER, password: PASSWORD } })).token ?? "";
  const m = await auth.api.signInEmail({ body: { email: MEMBER, password: PASSWORD } });
  memberToken = m.token ?? "";
  apiKey = (
    await auth.api.createApiKey({ body: { name: "headless coordinator", organizationId: orgId }, headers: as(owner) })
  ).key;
  const actor = { kind: "person" as const, id: "owner", label: "Olive Owner" };
  await setSecret(client, vault, {
    organization: orgId,
    user: null,
    name: "linear-api-key",
    value: ORG_LINEAR,
    actor,
    now,
  });
  await setSecret(client, vault, {
    organization: orgId,
    user: m.user.id,
    name: "linear-api-key",
    value: OWN_LINEAR,
    actor,
    now,
  });
});

afterAll(async () => {
  Object.assign(console, original);
  await client.end();
});

/** One call from a terminal to /api/cli, with the vault on. */
async function cli(
  method: string,
  path: string,
  init: { body?: unknown; token?: string; key?: string; from?: string } = {},
  vaultOn = true,
) {
  const headers = new Headers({ "x-forwarded-for": init.from ?? "192.0.2.1" });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.key) headers.set("x-api-key", init.key);
  const res = await handleCli(
    new Request(`${BASE}/api/cli/${path}`, {
      method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    path.split("/"),
    { accounts: async () => accounts, vault: () => (vaultOn ? vaultMode : { kind: "off" }), now: () => now },
  );
  const body = (await res.json()) as Record<string, unknown> & { error?: string; next?: string };
  if (typeof body.token === "string") tokens.push(body.token);
  return { status: res.status, body };
}

/** A coordinator's launch token for a ticket, from `armada brief`. */
async function launch(ticket: string, by: { token?: string; key?: string } = { token: ownerToken }) {
  const r = await cli("POST", "launch-tokens", { ...by, body: { project: "widgets", ticket } });
  expect(r.status).toBe(200);
  return String(r.body.token);
}

/** The worker's first command: the launch token for a worker session. */
const exchange = (token: string, from?: string) =>
  cli("POST", "launch-tokens/exchange", { body: { token }, ...(from ? { from } : {}) });

/** A worker command asking for its keys: `purpose` is what the CLI sends. */
const keysFor = (token: string, purpose: { command: string; project: string; ticket: string } | null) =>
  cli("POST", "credentials", { token, body: { purpose } });

describe("launch tokens: one ticket, once, within the hour", () => {
  test("a signed-in coordinator gets a token; the worker exchanges it once for a session on that ticket, with the launcher's keys", async () => {
    now = at(0);
    const made = await cli("POST", "launch-tokens", {
      token: memberToken,
      body: { project: "widgets", ticket: "abc-12" },
    });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({
      schemaVersion: 1,
      expiresAt: at(60).toISOString(),
      worker: { project: "widgets", ticket: "ABC-12" },
      organization: { id: orgId, slug: "acme" },
    });
    const token = String(made.body.token);
    expect(token).toStartWith("armada_launch_");

    const first = await exchange(token);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      worker: { project: "widgets", ticket: "ABC-12", launchedBy: "Mia Member <member@example.test>" },
      organization: { slug: "acme" },
    });
    const session = String(first.body.token);
    expect(session).toStartWith("armada_worker_");

    const again = await exchange(token);
    expect(again.status).toBe(401);
    expect(again.body.error).toBe(
      "this launch token was already used at 2026-09-30 12:00 UTC: a launch token signs one worker in, once",
    );
    expect(again.body.next).toContain("armada brief <ticket>");

    const who = await cli("GET", "session", { token: session });
    expect(who.status).toBe(200);
    expect(who.body as unknown as CliIdentity).toMatchObject({
      via: "worker",
      user: null,
      organization: { id: orgId },
      worker: { project: "widgets", ticket: "ABC-12", launchedBy: "Mia Member <member@example.test>" },
    });

    // The launcher's own Linear key: the worker's comments carry their name.
    const keys = await keysFor(session, { command: "report", project: "widgets", ticket: "ABC-12" });
    expect(keys.status).toBe(200);
    expect((keys.body as unknown as Release).linear).toEqual({ apiKey: OWN_LINEAR, scope: "own" });
    const events = await listEvents(client, orgId);
    expect(events.find((e) => e.action === "release")).toMatchObject({
      actor: { kind: "worker", label: "worker on ABC-12 (launched by Mia Member <member@example.test>)" },
      detail: expect.stringContaining("for ABC-12"),
    });
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(["launch", "exchange", "release"]));

    // An API key launches too; its worker gets the organization's key.
    const byKey = await exchange(await launch("ABC-13", { key: apiKey }));
    const orgKeys = await keysFor(String(byKey.body.token), { command: "claim", project: "widgets", ticket: "ABC-13" });
    expect((orgKeys.body as unknown as Release).linear).toEqual({ apiKey: ORG_LINEAR, scope: "organization" });
  });

  test("a token used after its hour is refused; one used within it works", async () => {
    now = at(100);
    const late = await launch("ABC-14");
    const inTime = await launch("ABC-15");
    now = at(159);
    expect((await exchange(inTime)).status).toBe(200);
    now = at(161);
    const refused = await exchange(late);
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe("this launch token expired at 2026-09-30 14:40 UTC: it lasts one hour");
    expect((await exchange("armada_launch_not-a-real-token")).body.error).toBe("this launch token is not valid");
    const unused = (await listWorkers(client, orgId)).find((w) => w.ticket === "ABC-14");
    expect(unused && workerState(unused, now)).toBe("unused");
  });

  test("each command renews the worker session; one left unused past 72 hours has expired", async () => {
    now = at(200);
    const session = String((await exchange(await launch("ABC-16"))).body.token);
    const purpose = { command: "report", project: "widgets", ticket: "ABC-16" };
    now = at(200 + 71 * 60);
    expect((await keysFor(session, purpose)).status).toBe(200);
    now = at(200 + 142 * 60);
    expect((await keysFor(session, purpose)).status).toBe(200);
    now = at(200 + 215 * 60);
    const idle = await keysFor(session, purpose);
    expect(idle.status).toBe(401);
    expect(idle.body.error).toContain("the worker session of ABC-16 expired at");
  });
});

describe("a worker session acts on its own ticket only", () => {
  test("worker ownership comes from the launch row, never its fleet request", async () => {
    now = at(800);
    const made = await cli("POST", "launch-tokens", {
      token: ownerToken,
      body: { project: "widgets", ticket: "ABC-24", coordinator: "front" },
    });
    expect(made.status).toBe(200);
    expect(
      (
        await cli("POST", "launch-tokens", {
          token: ownerToken,
          body: { project: "widgets", ticket: "ABC-24", coordinator: "Bad_Name" },
        })
      ).status,
    ).toBe(400);
    const signed = await exchange(String(made.body.token));
    expect(signed.body.worker).toMatchObject({ coordinator: "front" });
    const session = String(signed.body.token);
    const project = { slug: "widgets", name: "Widgets", repository: "acme/widgets", programRoot: "ABC-1" };
    expect(
      (
        await cli("POST", "fleet/claim", {
          token: session,
          body: {
            project,
            input: {
              ticket: "ABC-24",
              runtime: "Conductor",
              handle: "workspace/named",
              branch: null,
              phase: "planning",
              resuming: false,
              profile: null,
              coordinator: "spoof",
              coordinatorName: "Invalid spoof",
            },
          },
        })
      ).status,
    ).toBe(200);
    expect((await getRuntimeHandle(client, "widgets", "ABC-24"))?.coordinator).toBe("front");
    expect((await cli("GET", "session", { token: session })).body.worker).toMatchObject({ coordinator: "front" });
  });

  test("a heartbeat is project/ticket/session scoped, server timed, vault-free, and refuses replaced sessions", async () => {
    now = at(900);
    const session = String((await exchange(await launch("ABC-25"))).body.token);
    const project = { slug: "widgets", name: "Widgets", repository: "acme/widgets", programRoot: "ABC-1" };
    const call = (op: string, input: unknown, token = session) =>
      cli("POST", `fleet/${op}`, { token, body: { project, input } });
    const claim = {
      ticket: "ABC-25",
      runtime: "Conductor",
      handle: "workspace/worker-one",
      branch: null,
      phase: "implementing",
      resuming: false,
      profile: null,
    };
    expect((await call("claim", claim)).status).toBe(200);
    now = at(905);
    const before = await listEvents(client, orgId);
    const ping = { ticket: claim.ticket, handle: claim.handle, at: "2099-01-01T00:00:00Z" };
    expect((await call("heartbeat", ping)).body.result).toEqual({
      active: true,
      claimedAt: at(900).toISOString(),
      phase: "implementing",
      shippingStage: null,
      agent: null,
    });
    expect(await listEvents(client, orgId)).toEqual(before);
    const rows = await client.query("SELECT heartbeat_at FROM runtime_handles WHERE project = $1 AND ticket = $2", [
      "widgets",
      claim.ticket,
    ]);
    expect(new Date(rows.rows[0]?.heartbeat_at as string).toISOString()).toBe(at(905).toISOString());
    expect((await call("heartbeat", { ...ping, ticket: "ABC-26" })).status).toBe(403);
    const replacement = String((await exchange(await launch(claim.ticket))).body.token);
    expect((await call("claim", { ...claim, handle: "workspace/worker-two" }, replacement)).status).toBe(200);
    expect((await call("heartbeat", ping)).body.result).toEqual({ active: false, claimedAt: null });
  });
  test("keys for another ticket, another project or a coordinator's command are refused; it launches and ends no worker", async () => {
    now = at(1000);
    const session = String((await exchange(await launch("ABC-20"))).body.token);
    const other = await keysFor(session, { command: "report", project: "widgets", ticket: "ABC-21" });
    expect(other.status).toBe(403);
    expect(other.body.error).toBe("this worker session acts on ABC-20 only, not ABC-21");
    const project = await keysFor(session, { command: "report", project: "gadgets", ticket: "ABC-20" });
    expect(project.body.error).toBe("this worker session is for the project widgets, not gadgets");
    for (const command of ["merge", "answer", "brief", "status"]) {
      const r = await keysFor(session, { command, project: "widgets", ticket: "ABC-20" });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(
        `a worker session only claim, report, ask, validate and release on its own ticket, not \`armada ${command}\``,
      );
    }
    expect((await keysFor(session, null)).status).toBe(403);
    for (const command of ["claim", "report", "ask", "release"])
      expect((await keysFor(session, { command, project: "widgets", ticket: "abc-20" })).status).toBe(200);

    const relaunch = await cli("POST", "launch-tokens", {
      token: session,
      body: { project: "widgets", ticket: "ABC-20" },
    });
    expect(relaunch.status).toBe(403);
    const end = await cli("POST", "workers/end", {
      token: session,
      body: { project: "widgets", ticket: "ABC-21", reason: "merged" },
    });
    expect(end.status).toBe(403);
  });
});

describe("the end of a worker", () => {
  test("revoked from the dashboard: its next command is refused with who cut it off, and it gets no more keys", async () => {
    now = at(2000);
    const session = String((await exchange(await launch("ABC-30"))).body.token);
    const worker = (await listWorkers(client, orgId)).find((w) => w.ticket === "ABC-30");
    expect(worker && workerState(worker, now)).toBe("active");
    // Another organization's id ends nothing.
    const person = { kind: "person" as const, id: "owner", label: "Olive Owner <owner@example.test>" };
    expect(
      await endWorker(client, {
        organization: "another-org",
        id: worker?.id ?? "",
        reason: "revoked",
        by: person,
        now,
      }),
    ).toBeNull();
    now = at(2005);
    expect(
      await endWorker(client, { organization: orgId, id: worker?.id ?? "", reason: "revoked", by: person, now }),
    ).toMatchObject({
      endReason: "revoked",
    });

    const refused = await keysFor(session, { command: "report", project: "widgets", ticket: "ABC-30" });
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe(
      "this worker was cut off from Armada by Olive Owner <owner@example.test> at 2026-10-01 21:25 UTC: stop working on ABC-30",
    );
    expect(refused.body.next).toContain("report the cut-off to the coordinator");
    expect((await cli("GET", "session", { token: session })).status).toBe(401);
    expect((await cli("POST", "fleet/heartbeat", { token: session, body: {} })).status).toBe(401);

    // Revoked before it was used, a token signs nothing in.
    const unused = await launch("ABC-31");
    const pending = (await listWorkers(client, orgId)).find((w) => w.ticket === "ABC-31");
    await endWorker(client, { organization: orgId, id: pending?.id ?? "", reason: "revoked", by: person, now });
    expect((await exchange(unused)).body.error).toBe("this launch was revoked before its token was used");
  });

  test("a coordinator release ends old launches but spares a newer replacement and its claim", async () => {
    now = at(2900);
    const old = String((await exchange(await launch("ABC-39"))).body.token);
    const project = { slug: "widgets", name: "Widgets", repository: "acme/widgets", programRoot: "ABC-1" };
    const claim = {
      ticket: "ABC-39",
      runtime: "Conductor",
      handle: "ws/old",
      branch: null,
      phase: "implementing",
      resuming: false,
      profile: null,
    };
    const call = (op: string, input: unknown, token: string) =>
      cli("POST", `fleet/${op}`, { token, body: { project, input } });
    expect((await call("claim", claim, old)).status).toBe(200);
    const claimedAt = now.toISOString();
    now = at(2901);
    const replacement = String((await exchange(await launch(claim.ticket))).body.token);
    expect((await call("claim", { ...claim, handle: "ws/new" }, replacement)).status).toBe(200);
    const release = { ticket: claim.ticket, reason: "old worker", handle: claim.handle, claimedAt };
    expect((await call("release", release, old)).body.result).toEqual({ released: false });
    expect((await call("release", release, ownerToken)).body.result).toEqual({ released: false });
    expect(
      (
        await cli("POST", "workers/end", {
          token: ownerToken,
          body: { project: "widgets", ticket: claim.ticket, reason: "released", claimedAt: "bad" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await cli("POST", "workers/end", {
          token: ownerToken,
          body: { project: "widgets", ticket: claim.ticket, reason: "released", claimedAt },
        })
      ).body.ended,
    ).toBe(1);
    expect((await keysFor(old, { command: "report", project: "widgets", ticket: claim.ticket })).status).toBe(401);
    expect(
      (
        await call(
          "report",
          {
            ticket: claim.ticket,
            phase: "implementing",
            previous: "implementing",
            summary: "working",
            message: "working",
          },
          replacement,
        )
      ).status,
    ).toBe(200);
    expect((await call("release", { ticket: claim.ticket, reason: "done" }, replacement)).body.result).toEqual({
      released: true,
    });
  });
  test("a release ends the worker's session; a merge ends every session of the ticket", async () => {
    now = at(3000);
    const released = String((await exchange(await launch("ABC-40"))).body.token);
    expect((await cli("DELETE", "session", { token: released })).status).toBe(200);
    const after = await keysFor(released, { command: "report", project: "widgets", ticket: "ABC-40" });
    expect(after.body.error).toContain("the worker session of ABC-40 ended at");
    expect(after.body.error).toContain("the ticket was released");
    expect((await cli("POST", "fleet/heartbeat", { token: released, body: {} })).status).toBe(401);

    const merged = String((await exchange(await launch("ABC-41"))).body.token);
    const end = await cli("POST", "workers/end", {
      token: ownerToken,
      body: { project: "widgets", ticket: "abc-41", reason: "merged" },
    });
    expect(end.body).toEqual({ ended: 1 });
    expect((await cli("POST", "fleet/heartbeat", { token: merged, body: {} })).status).toBe(401);
    expect((await keysFor(merged, { command: "report", project: "widgets", ticket: "ABC-41" })).body.error).toContain(
      "the ticket was merged",
    );
    const states = (await listWorkers(client, orgId)).map((w) => [w.ticket, workerState(w, now)]);
    expect(states).toEqual(
      expect.arrayContaining([
        ["ABC-40", "released"],
        ["ABC-41", "merged"],
      ]),
    );
  });
});

describe("safety", () => {
  test("exchanges are limited per address, and no token is ever logged or stored", async () => {
    now = at(4000);
    for (let k = 0; k < EXCHANGES_PER_MINUTE; k++)
      expect((await exchange(`armada_launch_guess-${k}`, "198.51.100.7")).status).toBe(401);
    const limited = await exchange(await launch("ABC-50"), "198.51.100.7");
    expect(limited.status).toBe(429);
    // Another address, or the same one a minute later, goes through.
    now = at(4001.5);
    expect((await exchange(`armada_launch_guess-late`, "198.51.100.7")).status).toBe(401);

    const stored = JSON.stringify([
      (await client.query(`SELECT * FROM "armada_worker"`)).rows,
      (await client.query(`SELECT * FROM "armada_secret_event"`)).rows,
    ]);
    const log = logged.join("\n");
    expect(log).toContain("launch token for widgets ABC-12 used");
    expect(tokens.length).toBeGreaterThan(10);
    for (const token of tokens) {
      expect(stored).not.toContain(token);
      expect(log).not.toContain(token);
    }
  });

  test("without a vault no launch token is made; without accounts every route answers 503 with the next step", async () => {
    const off = await cli(
      "POST",
      "launch-tokens",
      { token: ownerToken, body: { project: "widgets", ticket: "ABC-60" } },
      false,
    );
    expect(off.status).toBe(503);
    expect(off.body.error).toContain("a worker it launches would get no key");
    const bad = await cli("POST", "launch-tokens", {
      token: ownerToken,
      body: { project: "widgets", ticket: "not a ticket" },
    });
    expect(bad.status).toBe(400);
    for (const path of ["launch-tokens", "launch-tokens/exchange", "workers/end"]) {
      const res = await handleCli(new Request(`${BASE}/api/cli/${path}`, { method: "POST" }), path.split("/"), {
        accounts: async () => null,
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { next: string }).next).toContain("ARMADA_AUTH_");
    }
  });
});

test("ended worker sessions release their exact claim and history, preserve replacements, and reconcile without tracker reads", async () => {
  const project = { slug: "widgets", name: "Widgets", repository: "acme/widgets", programRoot: "ABC-1" };
  const person = { kind: "person" as const, id: "owner", label: "Olive Owner" };
  const claim = async (ticket: string, handle: string) => {
    const session = String((await exchange(await launch(ticket))).body.token);
    expect(
      (
        await cli("POST", "fleet/claim", {
          token: session,
          body: {
            project,
            input: {
              ticket,
              runtime: "Conductor",
              handle,
              branch: null,
              phase: "implementing",
              resuming: false,
              profile: null,
            },
          },
        })
      ).status,
    ).toBe(200);
    const worker = (await listWorkers(client, orgId)).find((w) => w.ticket === ticket);
    if (!worker) throw new Error("worker missing");
    return { session, worker };
  };
  now = at(9000);
  const revoked = await claim("ABC-90", "ws/revoked");
  const expired = await claim("ABC-91", "ws/expired");
  const old = await claim("ABC-92", "ws/old");
  now = at(9001);
  const replacement = await claim("ABC-92", "ws/new");
  await endWorker(client, { organization: orgId, id: revoked.worker.id, reason: "revoked", by: person, now });
  await endWorker(client, { organization: orgId, id: old.worker.id, reason: "revoked", by: person, now });
  expect((await getRuntimeHandle(client, "widgets", "ABC-90"))?.releasedAt).toBe(now.toISOString());
  // Authentication that preceded revocation cannot resurrect the claim after the project lock is released.
  await expect(
    saveRuntimeHandle(client, {
      project: "widgets",
      ticket: "ABC-90",
      runtime: "Conductor",
      handle: "ws/revoked",
      branch: null,
      workerSessionId: revoked.worker.id,
      at: now,
    }),
  ).rejects.toThrow("session ended");
  expect((await getRuntimeHandle(client, "widgets", "ABC-90"))?.releasedAt).toBe(now.toISOString());

  expect((await getRuntimeHandle(client, "widgets", "ABC-92"))?.workerSessionId).toBe(replacement.worker.id);
  expect((await getRuntimeHandle(client, "widgets", "ABC-92"))?.releasedAt).toBeNull();
  const history = await client.query(
    "SELECT released_at FROM fleet_sessions WHERE project = $1 AND ticket = $2 AND handle = $3",
    ["widgets", "ABC-90", "ws/revoked"],
  );
  expect(new Date(history.rows[0]?.released_at as string).toISOString()).toBe(now.toISOString());
  expect((await fleetStore(client).latestEvents("widgets"))["ABC-90"]?.kind).toBe("release");
  now = at(9000 + 73 * 60);
  expect((await keysFor(expired.session, { command: "report", project: "widgets", ticket: "ABC-91" })).status).toBe(
    401,
  );
  expect((await getRuntimeHandle(client, "widgets", "ABC-91"))?.releasedAt).toBe(now.toISOString());
  expect((await listWorkers(client, orgId)).find((w) => w.id === expired.worker.id)?.endReason).toBe("expired");
  const completed = await claim("ABC-93", "ws/complete");
  const { serveInbox } = await import("../../core/src/live.ts");
  now = new Date(now.getTime() + 60_000);
  await serveInbox(
    fleetStore(client),
    "widgets",
    { coordinator: null, silentAfterMinutes: 15, etag: null },
    now,
    null,
    {
      repository: "acme/widgets",
      issues: [{ id: "ABC-93", statusType: "completed" }],
      prs: [],
      flight: {
        after: now.toISOString(),
        forge: null,
        program: {
          rootId: "ABC-1",
          fetchedAt: now.toISOString(),
          issues: [{ ...(await import("../../core/test/support.ts")).issue("ABC-1") }],
          comments: [],
          warnings: [],
        },
      },
    },
  );
  expect((await getRuntimeHandle(client, "widgets", "ABC-93"))?.releasedAt).toBe(now.toISOString());
  expect((await listWorkers(client, orgId)).find((w) => w.id === completed.worker.id)?.endReason).toBe("released");
  expect((await cli("GET", "session", { token: completed.session })).status).toBe(401);
});
