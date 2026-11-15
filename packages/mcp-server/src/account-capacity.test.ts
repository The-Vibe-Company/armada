import { expect, test } from "bun:test";
import type { Sql } from "@armada/core/server";
import { admitAccountCapacity } from "./account-capacity.ts";

test("account capacity refuses a full account and admits available or unlimited capacity", async () => {
  for (const [max, running, refused] of [
    [2, 2, true],
    [2, 1, false],
    [null, 20, false],
  ] as const) {
    let reserved = false;
    const tx = {
      query: async (query: string) => {
        if (query.startsWith("select name")) return { rows: [{ name: "Shared Morph", max_agents: max }] };
        if (query.startsWith("select count")) return { rows: [{ running }] };
        if (query.startsWith("select id")) return { rows: [] };
        reserved = true;
        return { rows: [] };
      },
    } as unknown as Sql;
    const admission = admitAccountCapacity(tx, "account", "sandbox");
    if (refused) {
      await expect(admission).rejects.toThrow("Shared Morph is at its limit: 2/2 agents running");
      expect(reserved).toBe(false);
    } else {
      await admission;
      expect(reserved).toBe(max !== null);
    }
  }
});
