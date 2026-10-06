import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Auth, createAuth, type EmailMessage, recordApiKeyCreator } from "../lib/accounts.ts";
import { accountsModeOf } from "../lib/accounts-settings.ts";
import type { Release, SecretsRelease } from "../lib/broker.ts";
import { type CliAccounts, handleCli } from "../lib/cli-api.ts";
import type { Database } from "../lib/db.ts";
import { listEvents, setSecret, type VaultKey, vaultModeOf } from "../lib/vault.ts";
import { tempDatabase } from "./support.ts";

// Each project's secrets through the CLI API (THE-859). Synthetic people,
// projects, tickets and values, for these tests only.
const BASE = "http://localhost:4859";
const OWNER = "owner@example.test";
const PASSWORD = "a synthetic password";
const ENV = {
  ARMADA_DATABASE_URL: "pglite:memory",
  ARMADA_AUTH_SECRET: "a synthetic secret for tests, long enough",
  ARMADA_AUTH_URL: BASE,
  ARMADA_AUTH_OWNER_EMAILS: OWNER,
  NODE_ENV: "test",
};
const vaultMode = vaultModeOf({ ARMADA_SECRETS_KEY: Buffer.alloc(32, 7).toString("base64") });
const vault = (vaultMode.kind === "on" ? vaultMode.key : null) as VaultKey;
const now = new Date("2026-10-01T12:00:00Z");
const project = (slug: string) => ({
  slug,
  name: slug[0]?.toUpperCase() + slug.slice(1),
  repository: `example/${slug}`,
  programRoot: "ABC-1",
});
const WIDGETS = project("widgets");
const GADGETS = project("gadgets");
/** Every value set, which no log line and no stored event may contain. */
const VALUES = {
  openai: "sk-synthetic-widgets-0859",
  rotated: "sk-synthetic-widgets-rotated",
  shared: "synthetic-shared-sentry-dsn",
  linearOrg: "lin_api_synthetic_org_0859",
  linearOwn: "lin_api_synthetic_own_0859",
  linearWidgets: "lin_api_synthetic_widgets_0859",
};

let client: Database;
let auth: Auth;
let accounts: CliAccounts;
const outbox: EmailMessage[] = [];
let orgId = "";
let ownerId = "";
let ownerCookie = "";
let ownerToken = "";
let memberToken = "";
let memberId = "";
let worker = "";
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

/** One call from a terminal to /api/cli, with the vault on. */
async function cli(path: string, init: { body?: unknown; token?: string; key?: string } = {}) {
  const headers = new Headers({ "x-forwarded-for": "192.0.2.1", "content-type": "application/json" });
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.key) headers.set("x-api-key", init.key);
  const res = await handleCli(
    new Request(`${BASE}/api/cli/${path}`, { method: "POST", headers, body: JSON.stringify(init.body ?? {}) }),
    path.split("/"),
    { accounts: async () => accounts, vault: () => vaultMode, now: () => now },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: string } };
}

const secrets = (op: string, by: { token?: string; key?: string }, body: Record<string, unknown>) =>
  cli(`secrets/${op}`, { ...by, body });

// Cold PGlite startup has its own bounded budget, independent of authentication.
beforeAll(async () => {
  console.info = (...a: unknown[]) => void logged.push(a.join(" "));
  console.warn = (...a: unknown[]) => void logged.push(a.join(" "));
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  client = await tempDatabase();
}, 10_000);

// Authentication retains Bun's default bounded setup budget.
beforeAll(async () => {
  const mode = accountsModeOf(ENV);
  if (mode.kind !== "accounts") throw new Error("test settings incomplete");
  auth = createAuth(mode.settings, { client, sender: { send: async (m) => void outbox.push(m) } });
  accounts = { auth, client, settings: mode.settings };
  const owner = await signUp(OWNER, "Olive Owner");
  ownerCookie = owner;
  orgId = (await auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: as(owner) }))?.id ?? "";
  const invitation = await auth.api.createInvitation({
    body: { email: "member@example.test", role: "member", organizationId: orgId },
    headers: as(owner),
  });
  const member = await signUp("member@example.test", "Mia Member");
  await auth.api.acceptInvitation({ body: { invitationId: invitation.id }, headers: as(member) });
  const o = await auth.api.signInEmail({ body: { email: OWNER, password: PASSWORD } });
  ownerToken = o.token ?? "";
  ownerId = o.user.id;
  const m = await auth.api.signInEmail({ body: { email: "member@example.test", password: PASSWORD } });
  memberToken = m.token ?? "";
  memberId = m.user.id;
  // The worker of widgets ABC-7, launched by the owner.
  const launched = await cli("launch-tokens", { token: ownerToken, body: { project: "widgets", ticket: "ABC-7" } });
  worker = String((await cli("launch-tokens/exchange", { body: { token: launched.body.token } })).body.token);
});

afterAll(async () => {
  Object.assign(console, original);
  await client.end();
});

describe("the coordinator sets a project's secrets from the CLI", () => {
  test("an owner sets and lists them, names and who and when only; a member or a worker session sets none", async () => {
    const set = await secrets(
      "set",
      { token: ownerToken },
      { project: WIDGETS, name: "OPENAI_API_KEY", value: VALUES.openai },
    );
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ schemaVersion: 1, name: "OPENAI_API_KEY", scope: "project", project: "widgets" });
    const shared = await secrets(
      "set",
      { token: ownerToken },
      { project: WIDGETS, name: "SENTRY_DSN", value: VALUES.shared, scope: "organization" },
    );
    expect(shared.body.scope).toBe("organization");

    const listed = await secrets("list", { token: memberToken }, { project: WIDGETS });
    expect(listed.body.secrets).toEqual([
      {
        name: "OPENAI_API_KEY",
        scope: "project",
        setBy: "Olive Owner <owner@example.test>",
        setAt: now.toISOString(),
        overridden: false,
      },
      {
        name: "SENTRY_DSN",
        scope: "organization",
        setBy: "Olive Owner <owner@example.test>",
        setAt: now.toISOString(),
        overridden: false,
      },
    ]);

    const byMember = await secrets("set", { token: memberToken }, { project: WIDGETS, name: "X_KEY", value: "x" });
    expect([byMember.status, byMember.body.error]).toEqual([
      403,
      "only an owner or admin of Acme sets or unsets secrets",
    ]);
    const byWorker = await secrets("unset", { token: worker }, { project: WIDGETS, name: "OPENAI_API_KEY" });
    expect(byWorker.status).toBe(403);
    // A key Armada uses itself is not a secret for workers.
    const reserved = await secrets(
      "set",
      { token: ownerToken },
      { project: WIDGETS, name: "LINEAR_API_KEY", value: "x" },
    );
    expect([reserved.status, reserved.body.error]).toEqual([
      400,
      "LINEAR_API_KEY is a key Armada itself uses: it is set on the Keys page as such, not as a secret for workers",
    ]);
  });
});

describe("a worker fetches its own project's secrets, and no other's", () => {
  test("each release names the project and the secrets in the audit list; another project's is refused and recorded", async () => {
    const r = await secrets("release", { token: worker }, { project: WIDGETS });
    expect(r.status).toBe(200);
    const release = r.body as unknown as SecretsRelease;
    expect(release.secrets).toEqual([
      { name: "OPENAI_API_KEY", value: VALUES.openai, scope: "project" },
      { name: "SENTRY_DSN", value: VALUES.shared, scope: "organization" },
    ]);
    const only = (await secrets("release", { token: worker }, { project: WIDGETS, names: ["SENTRY_DSN", "NOT_SET"] }))
      .body as unknown as SecretsRelease;
    expect([only.secrets.map((s) => s.name), only.missing]).toEqual([["SENTRY_DSN"], ["NOT_SET"]]);

    const other = await secrets("release", { token: worker }, { project: GADGETS });
    expect([other.status, other.body.error]).toEqual([
      403,
      "this worker session is for the project widgets, not gadgets",
    ]);

    const events = await listEvents(client, orgId, 3);
    expect(events.map((e) => `${e.action} ${e.project} ${e.keys.join(",")} ${e.detail}`)).toEqual([
      "refuse gadgets  secrets of gadgets refused: this worker session is for the project widgets, not gadgets",
      "release widgets SENTRY_DSN for ABC-7; secrets for workers of widgets; not set: NOT_SET",
      "release widgets OPENAI_API_KEY,SENTRY_DSN for ABC-7; secrets for workers of widgets",
    ]);
    expect((await listEvents(client, orgId, 50, "gadgets")).map((e) => e.action)).toEqual(["refuse"]);
  });

  test("an unset secret is no longer released, a changed one is released changed, on the very next call", async () => {
    await secrets("set", { token: ownerToken }, { project: WIDGETS, name: "OPENAI_API_KEY", value: VALUES.rotated });
    const rotated = (await secrets("release", { token: worker }, { project: WIDGETS }))
      .body as unknown as SecretsRelease;
    expect(rotated.secrets.find((s) => s.name === "OPENAI_API_KEY")?.value).toBe(VALUES.rotated);
    const unset = await secrets("unset", { token: ownerToken }, { project: WIDGETS, name: "OPENAI_API_KEY" });
    expect(unset.body.deleted).toBe(true);
    const after = (await secrets("release", { token: worker }, { project: WIDGETS })).body as unknown as SecretsRelease;
    expect(after.secrets.map((s) => s.name)).toEqual(["SENTRY_DSN"]);
  });
});

describe("an organization API key acts with its creator's rights of today", () => {
  test("its creator an owner: it sets; demoted or gone, or unknown: refused", async () => {
    const created = await auth.api.createApiKey({
      body: { name: "headless coordinator", organizationId: orgId },
      headers: as(ownerCookie),
    });
    const key = created.key;
    // Before its creator is recorded (a key older than THE-859): refused.
    const unknown = await secrets("list", { key }, { project: WIDGETS });
    expect(unknown.status).toBe(403);
    expect(unknown.body.error).toContain("does not know this API key's creator");

    // The key made by Mia, then an admin.
    await client.query(`UPDATE "member" SET "role" = 'admin' WHERE "userId" = $1`, [memberId]);
    await recordApiKeyCreator(client, { id: created.id, organization: orgId, user: memberId, now });
    const set = await secrets("set", { key }, { project: WIDGETS, name: "CI_TOKEN", value: "synthetic-ci" });
    expect(set.status).toBe(200);

    await client.query(`UPDATE "member" SET "role" = 'member' WHERE "userId" = $1`, [memberId]);
    for (const op of ["set", "unset", "release"]) {
      const r = await secrets(op, { key }, { project: WIDGETS, name: "CI_TOKEN", value: "synthetic-ci-2" });
      expect([op, r.status, r.body.error]).toEqual([
        op,
        403,
        "this API key's creator is no longer an owner or admin of Acme, so it touches no secret",
      ]);
    }
    await client.query(`DELETE FROM "member" WHERE "userId" = $1`, [memberId]);
    expect((await secrets("release", { key }, { project: WIDGETS })).status).toBe(403);
  });
});

describe("a project's Linear key", () => {
  test("wins for that project over a person's own and the organization's; elsewhere they serve as before", async () => {
    const actor = { kind: "person" as const, id: ownerId, label: "Olive Owner" };
    const put = (p: string | null, user: string | null, value: string) =>
      setSecret(client, vault, { organization: orgId, project: p, user, name: "linear-api-key", value, actor, now });
    await put(null, null, VALUES.linearOrg);
    await put(null, ownerId, VALUES.linearOwn);
    await put("widgets", null, VALUES.linearWidgets);
    const keys = async (body: unknown, by: { token: string }) =>
      ((await cli("credentials", { ...by, body })).body as unknown as Release).linear;
    expect(await keys({ purpose: { project: "widgets" } }, { token: ownerToken })).toEqual({
      apiKey: VALUES.linearWidgets,
      scope: "project",
    });
    expect(await keys({ purpose: { project: "gadgets" } }, { token: ownerToken })).toEqual({
      apiKey: VALUES.linearOwn,
      scope: "own",
    });
    expect(await keys({}, { token: ownerToken })).toEqual({ apiKey: VALUES.linearOwn, scope: "own" });
    // `armada status --all` learns which projects keep their own, and asks for those.
    const listed = await handleCli(
      new Request(`${BASE}/api/cli/projects`, { headers: { authorization: `Bearer ${ownerToken}` } }),
      ["projects"],
      { accounts: async () => accounts, vault: () => vaultMode, now: () => now },
    );
    const projects = ((await listed.json()) as { projects: { slug: string; ownLinearKey: boolean }[] }).projects;
    expect(projects.map((p) => `${p.slug} ${p.ownLinearKey}`)).toEqual(["widgets true"]);
    // The worker of widgets, launched by the owner: the project's key, not its launcher's own.
    expect(
      await keys({ purpose: { command: "report", project: "widgets", ticket: "ABC-7" } }, { token: worker }),
    ).toEqual({ apiKey: VALUES.linearWidgets, scope: "project" });
  });

  test("no value is ever logged or recorded in the audit list", async () => {
    const events = JSON.stringify(await listEvents(client, orgId, 500));
    for (const value of Object.values(VALUES)) {
      expect(events).not.toContain(value);
      expect(logged.join("\n")).not.toContain(value);
    }
  });
});
