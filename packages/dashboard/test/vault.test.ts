import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "../lib/db.ts";
import {
  deleteSecret,
  listEvents,
  listSecrets,
  openSecret,
  readSecrets,
  SealError,
  sealSecret,
  setSecret,
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
      { name: "github-token", own: false, setBy: owner.label, setAt: now.toISOString(), value: null, readable: true },
      { name: "linear-api-key", own: false, setBy: owner.label, setAt: now.toISOString(), value: null, readable: true },
      { name: "linear-api-key", own: true, setBy: "Mia", setAt: now.toISOString(), value: null, readable: true },
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
