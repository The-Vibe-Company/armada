import { describe, expect, test } from "bun:test";
import { ControlError, createVaultControl } from "../src/lib/control.ts";
import {
  audience,
  canManage,
  nameProblem,
  parseVaultItem,
  valueProblem,
  vaultFailure,
  vaultState,
} from "../src/lib/variables.ts";

const ORG = "00000000-0000-4000-8000-000000000010";
const ALICE = "00000000-0000-4000-8000-000000000001";
const ID = "00000000-0000-4000-8000-000000000070";
const wire = {
  id: ID,
  orgId: ORG,
  ownerId: ALICE,
  scope: "personal",
  name: "APP_TOKEN",
  version: 2,
  epoch: 2,
  status: "active",
  expiresAt: null,
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-11T10:00:00.000Z",
};

describe("vault items", () => {
  test("keeps only the known metadata: a value or ciphertext the server might send never enters the page", () => {
    const item = parseVaultItem("secret", { ...wire, value: "canary", value_enc: "\\x00" });
    expect(item).toEqual({
      kind: "secret",
      id: ID,
      orgId: ORG,
      ownerId: ALICE,
      scope: "personal",
      name: "APP_TOKEN",
      version: 2,
      status: "active",
      createdAt: wire.createdAt,
      updatedAt: wire.updatedAt,
      expiresAt: null,
    });
    expect(JSON.stringify(item)).not.toContain("canary");
  });

  test.each([
    ["a deleted tombstone", { status: "deleted" }],
    ["an unknown scope", { scope: "team" }],
    ["a malformed id", { id: "nope" }],
    ["a missing date", { createdAt: undefined }],
  ])("drops %s", (_, change) => {
    expect(parseVaultItem("variable", { ...wire, ...change })).toBeNull();
  });

  test("an active item is ready; a revoked one sorts last without looking like a fault", () => {
    expect(vaultState({ status: "active" })).toEqual({ bucket: "ready", tone: "success", label: "Active" });
    expect(vaultState({ status: "revoked" })).toEqual({ bucket: "rest", tone: "neutral", label: "Revoked" });
  });

  test("the owner manages a personal item, an admin an org one; the row says who can use it", () => {
    const personal = { scope: "personal" as const, ownerId: ALICE };
    const shared = { scope: "org" as const, ownerId: ALICE };
    expect(canManage(personal, { userId: ALICE, admin: false })).toBe(true);
    expect(canManage(personal, { userId: "someone-else", admin: true })).toBe(false);
    expect(canManage(shared, { userId: ALICE, admin: false })).toBe(false);
    expect(canManage(shared, { userId: "someone-else", admin: true })).toBe(true);
    expect(audience(personal, "Acme")).toBe("Only you");
    expect(audience(shared, "Acme")).toBe("Everyone in Acme");
  });
});

describe("the server's rules, said before sending", () => {
  test.each([
    ["APP_REGION", "variable", null],
    ["app_region", "variable", /capital letters/],
    ["1ST", "variable", /starting with a letter/],
    ["A".repeat(129), "variable", /128/],
    ["GITHUB_TOKEN", "secret", /GITHUB_ are reserved/],
    ["PATH", "variable", /PATH is reserved/],
    ["NEXT_PUBLIC_KEY", "secret", /frontend builds/],
    ["NEXT_PUBLIC_URL", "variable", null],
  ] as const)("%s as a %s", (name, kind, expected) => {
    const problem = nameProblem(name, kind);
    if (expected === null) expect(problem).toBeNull();
    else expect(problem).toMatch(expected);
  });

  test("values: a secret is never empty or part of its name; no NUL; at most 8 KiB; never quoted back", () => {
    expect(valueProblem("", "variable", "APP_REGION")).toBeNull();
    expect(valueProblem("", "secret", "APP_TOKEN")).toBe("Enter the secret value.");
    expect(valueProblem("TOKEN", "secret", "APP_TOKEN")).toMatch(/cannot appear in its name/);
    expect(valueProblem("a\0b", "variable", "X")).toMatch(/NUL/);
    expect(valueProblem("é".repeat(4097), "variable", "X")).toMatch(/8 KiB/);
    expect(valueProblem("x".repeat(8192), "secret", "X_KEY")).toBeNull();
    for (const value of ["s3cr3t-canary", "a\0canary"])
      expect(valueProblem(value, "secret", "APP_TOKEN") ?? "").not.toContain("canary");
  });

  test("a refusal is said for this page, not in the vault's generic words", () => {
    expect(vaultFailure(409, "Application vault version changed.")).toMatch(/Refresh and try again/);
    expect(vaultFailure(403, "Application vault access denied.")).toMatch(/Only an admin/);
    expect(vaultFailure(503, "Application vault unavailable.")).toBe("Application vault unavailable.");
  });
});

describe("vault control client", () => {
  function client(answer: (route: string, body: Record<string, unknown>) => Response) {
    const calls: { route: string; body: Record<string, unknown>; authorization: string | null }[] = [];
    const control = createVaultControl({
      serverUrl: "https://armada.test/mcp",
      token: "user-jwt",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const route = new URL(String(input)).pathname;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push({ route, body, authorization: new Headers(init?.headers).get("authorization") });
        return answer(route, body);
      }) as typeof fetch,
    });
    return { control, calls };
  }

  test("lists both kinds of the org as the viewer, dropping rows of another org", async () => {
    const { control, calls } = client((route) =>
      Response.json({
        items: route.includes("secrets")
          ? [wire, { ...wire, id: "00000000-0000-4000-8000-000000000071", orgId: "another-org" }]
          : [{ ...wire, name: "APP_REGION" }],
      }),
    );
    const items = await control.list(ORG);
    expect(items.map((item) => [item.kind, item.name])).toEqual([
      ["variable", "APP_REGION"],
      ["secret", "APP_TOKEN"],
    ]);
    expect(calls.map((call) => call.route).sort()).toEqual(["/api/v1/secrets/list", "/api/v1/variables/list"]);
    expect(calls.every((call) => call.authorization === "Bearer user-jwt" && call.body.org === ORG)).toBe(true);
  });

  test("a rotation sends the value once and returns metadata only", async () => {
    const { control, calls } = client(() => Response.json({ item: { ...wire, version: 3 } }));
    const item = await control.rotateSecret({ org: ORG, id: ID, expectedVersion: 2, value: "canary" });
    expect(calls).toEqual([
      {
        route: "/api/v1/secrets/rotate",
        body: { org: ORG, id: ID, expectedVersion: 2, value: "canary" },
        authorization: "Bearer user-jwt",
      },
    ]);
    expect(item.version).toBe(3);
    expect(JSON.stringify(item)).not.toContain("canary");
  });

  test("a stale version keeps the server's code; an older server is named as such", async () => {
    const stale = client(() =>
      Response.json({ error: { code: "conflict", message: "Application vault version changed." } }, { status: 409 }),
    );
    const error = await stale.control
      .revoke("variable", { org: ORG, id: ID, expectedVersion: 1 })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ControlError);
    expect([error.status, error.code]).toEqual([409, "conflict"]);

    const older = client(() =>
      Response.json({ error: { code: "unknown_route", message: "Unknown route." } }, { status: 404 }),
    );
    const missing = await older.control.list(ORG).catch((caught) => caught);
    expect([missing.message, missing.code]).toEqual([
      "This Armada server does not offer variables and secrets yet.",
      undefined,
    ]);
  });
});
