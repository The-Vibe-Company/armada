import { describe, expect, mock, test } from "bun:test";
import type { Supabase } from "@/lib/supabase/server";

mock.module("./selected-org", () => ({
  selectedOrganization: async () => ({ org: { id: "selected_org" } }),
}));

const { listGoldens, listGoldenHistory, findRemovedGolden } = await import("./goldens");
const { getSandbox } = await import("./sandboxes");

/** Model PostgREST projection against a row with a newly introduced, unapproved column. */
function database(row: Record<string, unknown>) {
  let columns = "*";
  const filters: unknown[][] = [];
  const query = {
    select(value: string) {
      columns = value;
      return query;
    },
    eq(...args: unknown[]) {
      filters.push(args);
      return query;
    },
    is: () => query,
    not: () => query,
    order: async () => ({ data: [project()], error: null }),
    maybeSingle: async () => ({ data: project(), error: null }),
  };
  function project() {
    return Object.fromEntries(
      Object.entries(row).filter(([key]) => columns === "*" || columns.split(",").includes(key)),
    );
  }
  return {
    client: { from: () => query } as unknown as Supabase,
    filters,
  };
}

describe("dashboard JWT projections", () => {
  for (const [name, read, single] of [
    ["active goldens", listGoldens, false],
    ["golden history", listGoldenHistory, false],
    ["removed golden", (db: Supabase) => findRemovedGolden(db, "golden_id"), true],
    ["sandbox interior", (db: Supabase) => getSandbox(db, "sandbox_id"), true],
  ] as const) {
    test(`${name} preserves readable data without implicitly fetching new columns`, async () => {
      const db = database({
        id: "row_id",
        org_id: "selected_org",
        created_at: "created_time",
        future_private_column: "not_approved",
      });
      const result = await read(db.client);
      const row = single ? result : (result as unknown[])[0];
      expect(row).toEqual({ id: "row_id", org_id: "selected_org", created_at: "created_time" });
      expect(db.filters).toContainEqual(["org_id", "selected_org"]);
    });
  }
});
