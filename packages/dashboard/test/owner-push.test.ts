import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { configTemplate, type OwnerValidation, parseConfig } from "@armada/core/read";
import { issue } from "../../core/test/support.ts";
import { organizationKeys, releaseCredentials, releaseWorkerSecrets } from "../lib/broker.ts";
import type { Database } from "../lib/db.ts";
import { addInboxItem, addValidation, upsertProject } from "../lib/fleet-store.ts";
import { ownerCron } from "../lib/owner-cron.ts";
import {
  listOwnerChannels,
  ownerPulse,
  ownerTick,
  publicAddress,
  removeOwnerChannel,
  saveOwnerChannel,
  sendOwnerTest,
  webhookUrl,
} from "../lib/owner-push.ts";
import { dbSnapshots, markRepository, memorySnapshots } from "../lib/snapshots.ts";
import {
  listSecrets,
  listWorkerSecrets,
  readProjectKey,
  readSecrets,
  type VaultKey,
  vaultModeOf,
} from "../lib/vault.ts";
import { addOrganizations, tempDatabase } from "./support.ts";

const now = new Date("2026-04-06T12:00:00Z");
const org = "org-widgets";
const project = { slug: "widgets", name: "Widgets", repository: "acme/widgets", programRoot: "WID-1" };
const actor = { kind: "person" as const, id: "ada", label: "Ada" };
const URL_VALUE = "https://hooks.example.test/secret-address";
const SIGNING = "synthetic-channel-signing-secret";
const BASE = "https://armada.example.test";
const mode = vaultModeOf({ ARMADA_SECRETS_KEY: Buffer.alloc(32, 7).toString("base64") });
if (mode.kind !== "on") throw new Error("synthetic vault unavailable");
const vault: VaultKey = mode.key;
let db: Database;
const posts: { url: string; body: string; headers: Headers }[] = [];
let status = 200;
const fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async (url, init) => {
  posts.push({ url: String(url), body: String(init?.body), headers: new Headers(init?.headers) });
  return new Response(null, { status });
};
const opts = (at = now) => ({ organization: org, now: at, fetch: fetcher, vault, baseUrl: BASE });
const save = (over: Partial<Parameters<typeof saveOwnerChannel>[1]> = {}) =>
  saveOwnerChannel(db, {
    organization: org,
    project: null,
    format: "slack",
    alerts: true,
    timeZone: "UTC",
    language: "en",
    quiet: null,
    url: URL_VALUE,
    signingSecret: SIGNING,
    actor,
    now,
    vault,
    ...over,
  });
async function validation(ticket = "WID-2", kind: OwnerValidation["kind"] = "merge") {
  return addValidation(db, {
    project: project.slug,
    ticket,
    kind,
    what: "worker free text must never be sent",
    reason: "synthetic",
    choices: null,
    pr:
      kind === "merge"
        ? {
            number: Number(ticket.split("-")[1]),
            url: "https://github.com/acme/widgets/pull/2",
            title: "Export the report",
            headSha: "a".repeat(40),
            files: [],
            additions: 0,
            deletions: 0,
            ci: "success",
            preview: null,
          }
        : null,
    attachments: [],
    author: "coordinator",
    at: now,
  });
}

beforeAll(async () => {
  db = await tempDatabase();
  await addOrganizations(db, org, "org-other");
  await upsertProject(db, project, now);
  await db.query(`UPDATE projects SET organization_id = $1 WHERE slug = $2`, [org, project.slug]);
  const snapshots = dbSnapshots(db, memorySnapshots());
  const claim = await snapshots.claim(project.slug, now, 60_000);
  if (!claim) throw new Error("snapshot not claimed");
  await snapshots.save(
    project.slug,
    {
      startedAt: now,
      config: parseConfig(configTemplate(project)),
      configWarning: null,
      sources: {
        program: {
          rootId: "WID-1",
          fetchedAt: now.toISOString(),
          issues: [issue("WID-1"), issue("WID-2", { title: "Export the report", parentId: "WID-1" })],
          comments: [],
          warnings: [],
        },
        forge: { repo: project.repository, fetchedAt: now.toISOString(), prs: [], warnings: [] },
        forgeError: null,
      },
    },
    claim,
    { full: true, now },
  );
});
afterAll(async () => {
  await db?.end();
});
beforeEach(async () => {
  posts.length = 0;
  status = 200;
  await db.query(`TRUNCATE owner_channels, validations, inbox_items, leases RESTART IDENTITY CASCADE`);
  await db.query(`DELETE FROM "armada_secret"`);
  await db.query(`DELETE FROM "armada_secret_event"`);
  await db.query(`DELETE FROM coordinator_presence`);
});

describe("owner chat delivery", () => {
  test("concurrent instances send one POST per durable item; marked snapshots stay untouched; payloads contain titles and links only", async () => {
    const v = await validation();
    await validation("WID-3", "question");
    await save({ format: "json" });
    await markRepository(db, project.repository, now);
    await Promise.all([ownerTick(db, opts()), ownerTick(db, opts())]);
    expect(posts).toHaveLength(2);
    const payloads = posts.map((p) => JSON.parse(p.body));
    expect(payloads.some((p) => p.items[0].url === `${BASE}/approve/${v.id}`)).toBe(true);
    expect(posts.every((p) => !p.body.includes("worker free text"))).toBe(true);
    for (const p of posts)
      expect(p.headers.get("x-armada-signature")).toBe(
        `sha256=${createHmac("sha256", SIGNING).update(p.body).digest("hex")}`,
      );
    await ownerTick(db, opts(new Date(now.getTime() + 120_000)));
    expect(posts).toHaveLength(2);
    expect((await dbSnapshots(db, memorySnapshots()).entries([project.slug])).get(project.slug)?.dirty).toBe(true);
  });

  test("long batches reserve each attempt against the live injected clock", async () => {
    await save({ format: "json" });
    for (let n = 2; n < 22; n++) await validation(`WID-${n}`, "validation");
    let clock = now.getTime();
    let count = 0;
    await ownerTick(db, {
      ...opts(),
      now: () => new Date(clock),
      fetch: async (_url, init) => {
        const payload = JSON.parse(String(init?.body));
        const push = (await db.query(`SELECT claimed_until FROM owner_pushes WHERE key = $1`, [payload.items[0].key]))
          .rows[0];
        expect(new Date(String(push?.claimed_until)).getTime()).toBeGreaterThan(clock);
        count++;
        clock += 5_000;
        return new Response(null, { status: 200 });
      },
    });
    expect(count).toBe(20);
  });

  test("a stopped coordinator with waiting items alerts once until it returns and stops again", async () => {
    await save();
    const ago = new Date(now.getTime() - 60 * 60_000);
    await addInboxItem(db, {
      project: project.slug,
      ticket: "WID-2",
      kind: "question",
      recipient: "coordinator",
      author: "worker",
      body: "free text",
      at: ago,
    });
    await db.query(`INSERT INTO coordinator_presence (project,seen_at,started_at,inbox_seen_at) VALUES ($1,$2,$2,$2)`, [
      project.slug,
      ago,
    ]);
    await ownerTick(db, opts());
    await ownerTick(db, opts());
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toContain("coordinator stopped");
    await db.query(`UPDATE coordinator_presence SET seen_at = $2, inbox_seen_at = $2 WHERE project = $1`, [
      project.slug,
      now,
    ]);
    await ownerTick(db, opts());
    expect(posts).toHaveLength(1);
    await ownerTick(db, opts(new Date(now.getTime() + 60 * 60_000)));
    expect(posts).toHaveLength(2);
  });

  test("quiet-hour arrivals are stored for the next digest in the channel timezone, never posted later as alerts", async () => {
    await validation();
    await save({ timeZone: "Pacific/Auckland", quiet: { from: "22:00", to: "07:30" } });
    await ownerTick(db, opts()); // midnight in Auckland
    expect(posts).toHaveLength(0);
    expect((await db.query(`SELECT sent_at,error,attempts,payload FROM owner_pushes`)).rows[0]).toMatchObject({
      sent_at: now,
      error: "quiet",
      attempts: 0,
    });
    await ownerTick(db, opts(new Date("2026-04-06T21:00:00Z")));
    expect(posts).toHaveLength(0);
  });

  test("retries are claimed once per minute, stop at five attempts, and ten consecutive failures pause the channel", async () => {
    await validation();
    await validation("WID-3");
    await save();
    status = 503;
    for (let minute = 0; minute < 5; minute++) {
      const o = opts(new Date(now.getTime() + minute * 60_000));
      await Promise.all([ownerTick(db, o), ownerTick(db, o)]);
    }
    expect(posts).toHaveLength(10);
    expect((await listOwnerChannels(db, org))[0]).toMatchObject({ failures: 10, pausedReason: "failures" });
    await ownerTick(db, opts(new Date(now.getTime() + 360_000)));
    expect(posts).toHaveLength(10);
    expect((await db.query(`SELECT attempts FROM owner_pushes ORDER BY key`)).rows.map((r) => r.attempts)).toEqual([
      5, 5,
    ]);
  });

  test("404 and 410 pause immediately; saving resumes; success clears consecutive failures; provider text is never kept", async () => {
    for (const code of [404, 410]) {
      await save();
      status = code;
      await sendOwnerTest(db, opts());
      expect((await listOwnerChannels(db, org))[0]?.pausedReason).toBe(`http-${code}`);
    }
    await save({ url: "", signingSecret: "" });
    expect((await listOwnerChannels(db, org))[0]?.pausedReason).toBeNull();
    const throwing: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async () => {
      throw new Error(URL_VALUE);
    };
    expect(await sendOwnerTest(db, { ...opts(), fetch: throwing })).toBe(false);
    expect((await listOwnerChannels(db, org))[0]).toMatchObject({ failures: 1, last: { error: "unavailable" } });
    status = 200;
    expect(await sendOwnerTest(db, opts())).toBe(true);
    expect((await listOwnerChannels(db, org))[0]?.failures).toBe(0);
    expect(JSON.stringify(await listOwnerChannels(db, org))).not.toContain(URL_VALUE);
  });

  test("organization/project filters and scoped pulse leases isolate delivery", async () => {
    await validation();
    await save();
    await ownerTick(db, { ...opts(), organization: "org-other" });
    await ownerPulse(db, { ...opts(), organization: "org-other", project: project.slug });
    expect(posts).toHaveLength(0);
    await Promise.all([
      ownerPulse(db, { ...opts(), project: project.slug }),
      ownerPulse(db, { ...opts(), project: project.slug }),
    ]);
    expect(posts).toHaveLength(1);
    expect((await db.query(`SELECT name,project FROM leases`)).rows).toEqual([
      { name: "owner-tick", project: project.slug },
    ]);
    await expect(save({ project: "unknown" })).rejects.toThrow("invalid project");
  });

  test("webhook credentials cannot be listed/released through the keys/worker broker", async () => {
    await save();
    expect(await listSecrets(db, vault, { organization: org, user: "ada" })).toEqual([]);
    expect(await listWorkerSecrets(db, { organization: org, project: project.slug })).toEqual([]);
    expect((await readSecrets(db, vault, { organization: org, user: null })).values).toEqual({});
    await expect(
      readProjectKey(db, vault, { organization: org, project: project.slug, name: "owner-webhook" }),
    ).rejects.toThrow("server-only");
    const holder = { actor, organization: { id: org, name: "Widgets", slug: org }, user: "ada", project: project.slug };
    const deps = { client: db, vault, now: () => now };
    expect(await releaseWorkerSecrets(deps, holder, ["owner-webhook"])).toMatchObject({
      ok: true,
      release: { secrets: [], missing: ["owner-webhook"] },
    });
    expect(await releaseCredentials(deps, holder)).toMatchObject({ ok: true, release: { linear: null, warnings: [] } });
    expect(await organizationKeys(deps, org)).toMatchObject({ linearApiKey: null, githubToken: null, warnings: [] });
    const sealed = (await db.query(`SELECT "sealed" FROM "armada_secret"`)).rows[0]?.sealed;
    expect(String(sealed)).not.toContain(URL_VALUE);
    expect(String(sealed)).not.toContain(SIGNING);
    await removeOwnerChannel(db, { organization: org, actor, now });
    expect(await listOwnerChannels(db, org)).toEqual([]);
    expect((await db.query(`SELECT * FROM "armada_secret"`)).rows).toEqual([]);
  });

  test("cron checks its bearer before opening accounts; password deployments are off", async () => {
    let opened = 0;
    const deps = {
      secret: "synthetic-cron-secret",
      accounts: async () => {
        opened++;
        return null;
      },
      vault: () => mode,
    };
    expect((await ownerCron(new Request(`${BASE}/api/cron/owner`), deps)).status).toBe(401);
    expect(opened).toBe(0);
    const request = new Request(`${BASE}/api/cron/owner`, {
      headers: { authorization: "Bearer synthetic-cron-secret" },
    });
    expect(await (await ownerCron(request, deps)).json()).toEqual({ enabled: false });
    await validation();
    await save();
    expect(
      (
        await ownerCron(request, {
          ...deps,
          accounts: async () => ({ client: db, settings: { baseUrl: BASE } }),
          fetch: fetcher,
          now: () => now,
        })
      ).status,
    ).toBe(200);
    expect(posts).toHaveLength(1);
  });
});

test("webhooks refuse private addresses, local hosts, userinfo, redirects and HTTP", () => {
  for (const url of [
    "http://hooks.example.test",
    "https://127.0.0.1/x",
    "https://10.0.0.1/x",
    "https://[::1]/x",
    "https://localhost/x",
    "https://user:pass@hooks.example.test/x",
    "https://hooks.example.test:8443/x",
  ])
    expect(() => webhookUrl(url)).toThrow("invalid webhook address");
  expect(webhookUrl(URL_VALUE).href).toBe(URL_VALUE);
  for (const ip of [
    "127.0.0.1",
    "169.254.169.254",
    "192.168.0.1",
    "100.64.0.1",
    "::ffff:127.0.0.1",
    "fd00::1",
    "fe80::1",
    "2001:db8::1",
  ])
    expect(publicAddress(ip)).toBe(false);
  expect(publicAddress("8.8.8.8")).toBe(true);
  expect(publicAddress("2606:4700::1111")).toBe(true);
});
