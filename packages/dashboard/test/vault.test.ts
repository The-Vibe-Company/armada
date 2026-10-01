import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Database, DB_MIGRATIONS, migrateDatabase, pgliteDatabase } from "../lib/db.ts";
import {
  deleteSecret,
  listEvents,
  listSecrets,
  listWorkerSecrets,
  openSecret,
  readSecrets,
  readWorkerSecrets,
  SealError,
  sealSecret,
  setSecret,
  targetRefusal,
  type VaultKey,
  vaultModeOf,
} from "../lib/vault.ts";
import { tempDatabase } from "./support.ts";

// Synthetic master keys and values, for these tests only.
const KEY_A = Buffer.alloc(32, 7).toString("base64");
const KEY_B = Buffer.alloc(32, 9).toString("hex");
const LINEAR = "lin_api_synthetic_value_0001";
const slot = { organization: "org-1", user: "", name: "linear-api-key" } as const;

const vaultOf = (value: string): VaultKey => {
  const mode = vaultModeOf({ ARMADA_SECRETS_KEY: value });
  if (mode.kind !== "on") throw new Error("test key refused");
  return mode.key;
};

describe("the master key", () => {
  test("32 bytes in base64 or hex turn the vault on; nothing keeps it off; anything else is refused, named", () => {
    expect(vaultModeOf({}).kind).toBe("off");
    expect(vaultModeOf({ ARMADA_SECRETS_KEY: "  " }).kind).toBe("off");
    const short = vaultModeOf({ ARMADA_SECRETS_KEY: "too-short" });
    expect(short.kind).toBe("invalid");
    expect(short.kind === "invalid" && short.reason).toContain("openssl rand -base64 32");
    // The same key always has the same id; another key another id.
    expect(vaultOf(KEY_A).id).toBe(vaultOf(` ${KEY_A}\n`).id);
    expect(vaultOf(KEY_A).id).not.toBe(vaultOf(KEY_B).id);
    expect(vaultOf(Buffer.alloc(32, 7).toString("base64url")).id).toBe(vaultOf(KEY_A).id);
  });
});

describe("sealing a value", () => {
  test("opens with the same master key on the same row only; a moved, altered or foreign value never opens", () => {
    const a = vaultOf(KEY_A);
    const sealed = sealSecret(a, slot, LINEAR);
    expect(sealed).not.toContain(LINEAR);
    expect(openSecret(a, slot, sealed)).toBe(LINEAR);
    // A fresh data key and nonce every time.
    expect(sealSecret(a, slot, LINEAR)).not.toBe(sealed);

    const refusals = [
      () => openSecret(vaultOf(KEY_B), slot, sealed),
      () => openSecret(a, { ...slot, organization: "org-2" }, sealed),
      () => openSecret(a, { ...slot, user: "someone" }, sealed),
      () => openSecret(a, { ...slot, name: "github-token" }, sealed),
      // A project's row is bound to its project: neither the organization's row nor another project's opens it.
      () => openSecret(a, { ...slot, project: "widgets" }, sealed),
      () => openSecret(a, { ...slot, project: "gadgets" }, sealSecret(a, { ...slot, project: "widgets" }, LINEAR)),
      () => openSecret(a, slot, sealSecret(a, { ...slot, project: "widgets" }, LINEAR)),
      () => {
        const s = JSON.parse(sealed) as { c: string[] };
        const ct = Buffer.from(s.c[2] ?? "", "base64");
        ct[0] = (ct[0] ?? 0) ^ 1;
        s.c[2] = ct.toString("base64");
        return openSecret(a, slot, JSON.stringify(s));
      },
      () => openSecret(a, slot, "not sealed"),
    ];
    for (const open of refusals) {
      expect(open).toThrow(SealError);
      try {
        open();
      } catch (err) {
        expect(String(err)).not.toContain(LINEAR);
      }
    }
    expect(refusals[0]).toThrow(/another ARMADA_SECRETS_KEY/);
    expect(openSecret(a, { ...slot, project: "widgets" }, sealSecret(a, { ...slot, project: "widgets" }, LINEAR))).toBe(
      LINEAR,
    );
  });
});

describe("the keys of an organization", () => {
  let client: Database;
  const now = new Date("2026-09-30T12:00:00Z");
  const owner = { kind: "person" as const, id: "u-owner", label: "Olive Owner <owner@example.test>" };

  beforeAll(async () => {
    client = await tempDatabase();
    // The rows reference an organization.
    await client.query(
      `INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ('org-1', 'Acme', 'acme', '2026-09-30')`,
    );
  });
  afterAll(async () => {
    await client.end();
  });

  test("are listed with who set them and when, never a secret's value; the audit list names keys, never values", async () => {
    const a = vaultOf(KEY_A);
    await setSecret(client, a, {
      organization: "org-1",
      user: null,
      name: "linear-api-key",
      value: LINEAR,
      actor: owner,
      now,
    });
    await setSecret(client, a, {
      organization: "org-1",
      user: null,
      name: "github-token",
      value: "synthetic-github-token-0003",
      actor: owner,
      now,
    });
    // A key the vault no longer keeps (an earlier version's) is neither listed nor handed out.
    await client.query(
      `INSERT INTO "armada_secret" ("organizationId", "userId", "name", "sealed", "setById", "setByLabel", "createdAt", "updatedAt")
       VALUES ('org-1', '', 'retired-key', 'x', 'u-owner', 'Olive Owner', $1, $1)`,
      [now],
    );
    await setSecret(client, a, {
      organization: "org-1",
      user: "u-mia",
      name: "linear-api-key",
      value: "lin_api_synthetic_own_0002",
      actor: { kind: "person", id: "u-mia", label: "Mia" },
      now,
    });
    // Only a personal kind has a person's own.
    await expect(
      setSecret(client, a, {
        organization: "org-1",
        user: "u-mia",
        name: "github-token",
        value: "x",
        actor: owner,
        now,
      }),
    ).rejects.toThrow();

    const seen = await listSecrets(client, a, { organization: "org-1", user: "u-mia" });
    expect(seen).toEqual([
      {
        name: "github-token",
        project: "",
        own: false,
        setBy: owner.label,
        setAt: now.toISOString(),
        value: null,
        readable: true,
      },
      {
        name: "linear-api-key",
        project: "",
        own: false,
        setBy: owner.label,
        setAt: now.toISOString(),
        value: null,
        readable: true,
      },
      {
        name: "linear-api-key",
        project: "",
        own: true,
        setBy: "Mia",
        setAt: now.toISOString(),
        value: null,
        readable: true,
      },
    ]);
    // Another person does not see Mia's own key, even as a row.
    expect((await listSecrets(client, a, { organization: "org-1", user: "u-other" })).map((s) => s.own)).toEqual([
      false,
      false,
    ]);

    // The person's own key wins for them; the organization reads its own.
    expect((await readSecrets(client, a, { organization: "org-1", user: "u-mia" })).values["linear-api-key"]).toBe(
      "lin_api_synthetic_own_0002",
    );
    const organization = await readSecrets(client, a, { organization: "org-1", user: null });
    expect([organization.values, organization.problems]).toEqual([
      { "linear-api-key": LINEAR, "github-token": "synthetic-github-token-0003" },
      [],
    ]);

    // Another master key: listed as unreadable, to be entered again; the broker gets a problem, not a value.
    const b = vaultOf(KEY_B);
    expect((await listSecrets(client, b, { organization: "org-1", user: "u-mia" })).map((s) => s.readable)).toEqual([
      false,
      false,
      false,
    ]);
    const foreign = await readSecrets(client, b, { organization: "org-1", user: null });
    expect(foreign.values).toEqual({});
    expect(foreign.problems.join(" ")).toContain("another ARMADA_SECRETS_KEY");

    expect(
      await deleteSecret(client, { organization: "org-1", user: "u-mia", name: "linear-api-key", actor: owner, now }),
    ).toBe(true);
    expect(
      await deleteSecret(client, { organization: "org-1", user: "u-mia", name: "linear-api-key", actor: owner, now }),
    ).toBe(false);

    const events = await listEvents(client, "org-1");
    expect(events.map((e) => `${e.action} ${e.keys.join(",")} ${e.detail}`)).toEqual([
      "delete linear-api-key their own key",
      "set linear-api-key their own key",
      "set github-token for the organization",
      "set linear-api-key for the organization",
    ]);
    const stored = JSON.stringify((await client.query(`SELECT * FROM "armada_secret_event"`)).rows);
    const secrets = JSON.stringify((await client.query(`SELECT * FROM "armada_secret"`)).rows);
    for (const text of [stored, secrets]) {
      expect(text).not.toContain(LINEAR);
      expect(text).not.toContain("lin_api_synthetic_own_0002");
    }
  });
});

describe("each project's keys and secrets (THE-859)", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const owner = { kind: "person" as const, id: "u-owner", label: "Olive Owner" };

  test("a key stored before projects had their own still opens once the schema has them", async () => {
    // The database as it was before migration 7, with a key sealed then.
    const db = await pgliteDatabase();
    await db.query("CREATE TABLE armada_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL)");
    for (const m of DB_MIGRATIONS.filter((m) => m.version < 7)) {
      for (const statement of m.statements) await db.query(statement);
      await db.query("INSERT INTO armada_migrations (version, applied_at) VALUES ($1, now())", [m.version]);
    }
    await db.query(
      `INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ('org-1', 'Acme', 'acme', now())`,
    );
    const a = vaultOf(KEY_A);
    await db.query(
      `INSERT INTO "armada_secret" ("organizationId", "userId", "name", "sealed", "setById", "setByLabel", "createdAt", "updatedAt")
       VALUES ('org-1', '', 'linear-api-key', $1, 'u-owner', 'Olive Owner', $2, $2)`,
      [sealSecret(a, slot, LINEAR), now],
    );
    await migrateDatabase(db);
    const read = await readSecrets(db, a, { organization: "org-1", user: null, project: "widgets" });
    expect([read.values["linear-api-key"], read.fromProject, read.problems]).toEqual([LINEAR, [], []]);
    // The new key admits a project's row next to it.
    await setSecret(db, a, {
      organization: "org-1",
      project: "widgets",
      user: null,
      name: "linear-api-key",
      value: "lin_api_synthetic_widgets",
      actor: owner,
      now,
    });
    expect((await readSecrets(db, a, { organization: "org-1", user: null })).values["linear-api-key"]).toBe(LINEAR);
    await db.end();
  });

  test("the Linear key of a project: its own, then the person's own, then the organization's", async () => {
    const client = await tempDatabase();
    await client.query(
      `INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ('org-1', 'Acme', 'acme', now())`,
    );
    const a = vaultOf(KEY_A);
    const set = (project: string | null, user: string | null, value: string) =>
      setSecret(client, a, { organization: "org-1", project, user, name: "linear-api-key", value, actor: owner, now });
    await set(null, null, "lin_api_synthetic_org");
    await set(null, "u-mia", "lin_api_synthetic_mia");
    await set("widgets", null, "lin_api_synthetic_widgets");
    const read = (project: string | null, user: string | null) =>
      readSecrets(client, a, { organization: "org-1", user, project });
    const widgets = await read("widgets", "u-mia");
    expect([widgets.values["linear-api-key"], widgets.fromProject, widgets.own]).toEqual([
      "lin_api_synthetic_widgets",
      ["linear-api-key"],
      [],
    ]);
    expect((await read("gadgets", "u-mia")).values["linear-api-key"]).toBe("lin_api_synthetic_mia");
    expect((await read("gadgets", null)).values["linear-api-key"]).toBe("lin_api_synthetic_org");
    expect((await read("widgets", null)).values["linear-api-key"]).toBe("lin_api_synthetic_widgets");
    // A project's key that no longer opens leaves the project with none, never another workspace's.
    await client.query(
      `UPDATE "armada_secret" SET "sealed" = $1 WHERE "project" = 'widgets' AND "name" = 'linear-api-key'`,
      [sealSecret(a, { organization: "org-1", project: "gadgets", user: "", name: "linear-api-key" }, "moved")],
    );
    const broken = await read("widgets", "u-mia");
    expect([broken.values["linear-api-key"], broken.problems.length]).toEqual([undefined, 1]);
    // Neither a project's GitHub token nor a person's own key per project.
    expect(targetRefusal({ organization: "org-1", project: "widgets", user: null, name: "github-token" })).toContain(
      "organization's only",
    );
    expect(
      targetRefusal({ organization: "org-1", project: "widgets", user: "u-mia", name: "linear-api-key" }),
    ).toBeTruthy();
    await client.end();
  });

  test("secrets for workers: named in upper snake case, never a key Armada uses; a project's own wins over the organization's", async () => {
    const client = await tempDatabase();
    await client.query(
      `INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ('org-1', 'Acme', 'acme', now())`,
    );
    const a = vaultOf(KEY_A);
    const set = (project: string | null, name: string, value: string) =>
      setSecret(client, a, { organization: "org-1", project, user: null, name, value, actor: owner, now });
    for (const name of ["openai_api_key", "LINEAR_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "ARMADA_API_KEY", "1PASSWORD"])
      await expect(set("widgets", name, "x")).rejects.toThrow();
    await expect(
      setSecret(client, a, {
        organization: "org-1",
        user: "u-mia",
        name: "OPENAI_API_KEY",
        value: "x",
        actor: owner,
        now,
      }),
    ).rejects.toThrow(/never a person's own/);

    await set(null, "OPENAI_API_KEY", "synthetic-org-openai");
    await set(null, "SENTRY_DSN", "synthetic-org-sentry");
    await set("widgets", "OPENAI_API_KEY", "synthetic-widgets-openai");
    await set("widgets", "TEST_DATABASE_URL", "synthetic-widgets-db");
    await set("gadgets", "GADGETS_ONLY", "synthetic-gadgets");

    const all = await readWorkerSecrets(client, a, { organization: "org-1", project: "widgets", names: null });
    expect(all.values).toEqual({
      OPENAI_API_KEY: "synthetic-widgets-openai",
      SENTRY_DSN: "synthetic-org-sentry",
      TEST_DATABASE_URL: "synthetic-widgets-db",
    });
    expect(all.scopes).toEqual({ OPENAI_API_KEY: "project", SENTRY_DSN: "organization", TEST_DATABASE_URL: "project" });
    const some = await readWorkerSecrets(client, a, {
      organization: "org-1",
      project: "widgets",
      names: ["SENTRY_DSN", "GADGETS_ONLY"],
    });
    expect(some.values).toEqual({ SENTRY_DSN: "synthetic-org-sentry" });

    // The project's own that no longer opens is not replaced by the organization's.
    await set("gadgets", "OPENAI_API_KEY", "synthetic-gadgets-openai");
    await client.query(
      `UPDATE "armada_secret" SET "sealed" = 'tampered' WHERE "project" = 'gadgets' AND "name" = 'OPENAI_API_KEY'`,
    );
    const gadgets = await readWorkerSecrets(client, a, { organization: "org-1", project: "gadgets", names: null });
    expect([Object.keys(gadgets.values).sort(), gadgets.problems.length]).toEqual([["GADGETS_ONLY", "SENTRY_DSN"], 1]);

    const listed = await listWorkerSecrets(client, { organization: "org-1", project: "widgets" });
    expect(listed.map((s) => `${s.name} ${s.scope}${s.overridden ? " overridden" : ""}`)).toEqual([
      "OPENAI_API_KEY project",
      "OPENAI_API_KEY organization overridden",
      "SENTRY_DSN organization",
      "TEST_DATABASE_URL project",
    ]);
    // The typed keys are not secrets for workers, and no value is listed.
    expect(JSON.stringify(listed)).not.toContain("synthetic-");

    const events = await listEvents(client, "org-1", 50, "widgets");
    expect(events.map((e) => `${e.action} ${e.keys.join(",")} ${e.detail}`)).toEqual([
      "set TEST_DATABASE_URL for the project widgets",
      "set OPENAI_API_KEY for the project widgets",
    ]);
    expect((await listEvents(client, "org-1")).length).toBe(6);
    await client.end();
  });
});
