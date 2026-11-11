import { describe, expect, test } from "bun:test";
import { runVaultCase, VaultSmokeFailure, type VaultSmokeIo } from "./vault-smoke.ts";

const org = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
type Row = {
  id: string;
  name: string;
  scope: string;
  orgId: string;
  ownerId: string;
  version: number;
  epoch: number;
  status: string;
  createdAt: string;
  updatedAt: string;
};
type Fault =
  | "none"
  | "canary"
  | "extra_metadata"
  | "stale_accepted"
  | "read_mismatch"
  | "wrong_status"
  | "wrong_code"
  | "lost_set"
  | "lost_rotate"
  | "lost_revoke"
  | "lost_delete"
  | "delete_unavailable"
  | "cleanup_list_omits";

/** Stateful wire peer, not the smoke implementation: CAS, tombstones and HTTP errors. */
function fixture(fault: Fault = "none") {
  const rows = new Map<string, Row>();
  const values = new Map<string, string>();
  const protectedValues: string[] = [];
  const lines: string[] = [];
  const failures: string[] = [];
  const calls: { path: string; version?: number }[] = [];
  let injected = false;
  let cleaning = false;
  const wireError = (status: number, code: string) => ({ status, code });
  const io: VaultSmokeIo = {
    protect(value) {
      protectedValues.push(value);
    },
    isFailure(error, status, code) {
      return (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        "code" in error &&
        error.status === status &&
        error.code === code
      );
    },
    out(line) {
      lines.push(line);
    },
    async withCleanup(action) {
      cleaning = true;
      try {
        return await action();
      } finally {
        cleaning = false;
      }
    },
    async step(name, action) {
      try {
        return await action();
      } catch (error) {
        const code = error instanceof VaultSmokeFailure ? error.code : "wire_failure";
        failures.push(`${name}:${code}`);
        lines.push(JSON.stringify({ step: name, code }));
        throw error;
      }
    },
    async request<T>(path: string, input: object): Promise<T> {
      const body = input as Record<string, unknown>;
      expect(body.org).toBe(org);
      const [family, operation] = path.split("/");
      if (family !== "secrets" && family !== "variables") throw new Error("Unexpected fixture route");
      if (family === "secrets" && typeof body.value === "string") expect(protectedValues).toContain(body.value);
      calls.push({ path, ...(typeof body.expectedVersion === "number" ? { version: body.expectedVersion } : {}) });
      let response: unknown;
      let row: Row | undefined;
      if (operation === "list") {
        response = {
          items: [...rows.values()]
            .filter(
              (entry) =>
                entry.name.startsWith(family === "secrets" ? "SMOKE_SECRET_" : "SMOKE_VAR_") &&
                entry.status !== "deleted" &&
                !(cleaning && fault === "cleanup_list_omits"),
            )
            .map((entry) => ({ ...entry })),
        };
      } else if (operation === "set") {
        expect(body.scope).toBe("personal");
        expect(body.name).toMatch(family === "secrets" ? /^SMOKE_SECRET_[A-F0-9]+$/ : /^SMOKE_VAR_[A-F0-9]+$/);
        row = {
          id: crypto.randomUUID(),
          name: String(body.name),
          scope: "personal",
          orgId: org,
          ownerId: owner,
          version: 1,
          epoch: 1,
          status: "active",
          createdAt: "2026-11-11T00:00:00Z",
          updatedAt: "2026-11-11T00:00:00Z",
        };
        rows.set(row.id, row);
        values.set(row.id, String(body.value));
        response = { item: { ...row } };
      } else {
        row = rows.get(String(body.id));
        if (!row) throw wireError(404, "not_found");
        if (operation === "read") {
          if (family === "secrets")
            throw wireError(fault === "wrong_status" ? 403 : 400, fault === "wrong_code" ? "forbidden" : "invalid");
          response = { item: { ...row }, value: fault === "read_mismatch" ? "wrong" : values.get(row.id) };
        } else {
          if (fault === "delete_unavailable" && family === "secrets" && operation === "delete")
            throw wireError(503, "unavailable");
          const stale = body.expectedVersion !== row.version;
          if ((stale && fault !== "stale_accepted") || (row.status !== "active" && operation === "rotate"))
            throw wireError(409, "conflict");
          row.version++;
          row.epoch++;
          if (operation === "rotate") values.set(row.id, String(body.value));
          if (operation === "revoke") row.status = "revoked";
          if (operation === "delete") row.status = "deleted";
          response = { item: { ...row } };
        }
      }
      if (family === "secrets" && !injected) {
        if (fault === "canary" && operation === "set") {
          injected = true;
          (response as { item: object }).item = {
            ...(response as { item: object }).item,
            nested: { echo: body.value },
          };
        } else if (fault === "extra_metadata" && operation === "list") {
          injected = true;
          (response as { items: object[] }).items[0] = {
            ...(response as { items: object[] }).items[0],
            value_enc: "not-a-canary",
          };
        } else if (fault === `lost_${operation}`) {
          injected = true;
          throw wireError(502, "unknown_result");
        }
      }
      return response as T;
    },
  };
  return { io, rows, calls, failures, lines, protectedValues };
}
function checkNoLeaks(f: ReturnType<typeof fixture>) {
  const output = JSON.stringify({ lines: f.lines, failures: f.failures });
  for (const value of f.protectedValues) expect(output.includes(value)).toBe(false);
}

describe("deployed vault smoke at its injected HTTP boundary", () => {
  test("checks personal variable and write-only secret lifecycle with exact CAS versions and deletion", async () => {
    const f = fixture();
    expect(await runVaultCase(org, f.io)).toBe(true);
    expect(f.protectedValues).toHaveLength(2);
    expect(f.failures).toEqual([]);
    expect(f.calls.filter((call) => call.path.startsWith("secrets/") && call.version)).toEqual([
      { path: "secrets/rotate", version: 1 },
      { path: "secrets/rotate", version: 1 },
      { path: "secrets/revoke", version: 2 },
      { path: "secrets/rotate", version: 3 },
      { path: "secrets/delete", version: 3 },
    ]);
    expect(f.calls.find((call) => call.path === "variables/delete")?.version).toBe(1);
    expect([...f.rows.values()].map((row) => [row.status, row.version]).sort()).toEqual([
      ["deleted", 2],
      ["deleted", 4],
    ]);
    checkNoLeaks(f);
  });

  test.each(["canary", "extra_metadata", "stale_accepted", "read_mismatch", "wrong_status", "wrong_code"] as const)(
    "fails safely on %s and still cleans all owned resources",
    async (fault) => {
      const f = fixture(fault);
      expect(await runVaultCase(org, f.io)).toBe(false);
      expect(f.failures.length).toBeGreaterThan(0);
      expect([...f.rows.values()].every((row) => row.status === "deleted")).toBe(true);
      expect(JSON.parse(f.lines.at(-1) ?? "{}").pass).toBe(true);
      checkNoLeaks(f);
    },
  );

  test.each(["lost_set", "lost_rotate", "lost_revoke", "lost_delete"] as const)(
    "reconciles %s without replaying an uncertain mutation",
    async (fault) => {
      const f = fixture(fault);
      expect(await runVaultCase(org, f.io)).toBe(false);
      expect([...f.rows.values()].every((row) => row.status === "deleted")).toBe(true);
      const operation = fault.slice(5);
      const count = f.calls.filter((call) => call.path === `secrets/${operation}`).length;
      expect(count).toBe(1);
      const secret = [...f.rows.values()].find((row) => row.name.startsWith("SMOKE_SECRET_"));
      const deletion = f.calls.find((call) => call.path === "secrets/delete");
      expect(deletion?.version).toBe((secret?.version ?? 0) - 1);
      expect(f.calls.some((call) => call.path === "variables/delete")).toBe(true);
      checkNoLeaks(f);
    },
  );

  test("cleanup deletes known handles even if the list omits their rows", async () => {
    const f = fixture("cleanup_list_omits");
    expect(await runVaultCase(org, f.io)).toBe(true);
    expect(f.calls.filter((call) => call.path.endsWith("/delete"))).toHaveLength(2);
    expect([...f.rows.values()].every((row) => row.status === "deleted")).toBe(true);
    checkNoLeaks(f);
  });

  test("reports only an owned identifier when secret cleanup cannot be confirmed, then continues variable cleanup", async () => {
    const f = fixture("delete_unavailable");
    expect(await runVaultCase(org, f.io)).toBe(false);
    const summary = JSON.parse(f.lines.at(-1) ?? "{}");
    expect(summary.pass).toBe(false);
    const secret = [...f.rows.values()].find((row) => row.name.startsWith("SMOKE_SECRET_"));
    expect(summary.leftoverSecrets).toEqual([secret?.id]);
    expect(summary.leftoverVariables).toEqual([]);
    expect(f.calls.some((call) => call.path === "variables/delete")).toBe(true);
    checkNoLeaks(f);
  });
});
