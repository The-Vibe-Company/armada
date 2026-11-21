import { expect, test } from "bun:test";
import { readLogsOperation } from "@armada/core/contract";
import type { Sql } from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { readLogs } from "../src/control-logs.ts";
import { withNativeLogJournal } from "../src/native-log-journal.ts";

test.each(["forward", "backward"] as const)(
  "serves a persisted %s log page during native activity",
  async (direction) => {
    const scope = { id: "sandbox", orgId: "org", userId: "owner" };
    const caller = { userId: scope.userId, orgs: [{ orgId: scope.orgId, role: "admin" }], via: "service" } as const;
    const key = Buffer.alloc(32, 1).toString("base64");
    const pages = new Map<unknown, unknown>();
    let pending = false;
    const sql: Sql = {
      async query<T>(statement: string, params: unknown[] = []) {
        if (statement.includes("insert into")) {
          pages.set(params[5], params[8]);
          return { rows: [] };
        }
        if (statement.includes("join armada_logs")) {
          const page = pages.get(params[5]);
          return { rows: page ? [{ page } as T] : [] };
        }
        return { rows: [{ generation: pending ? "2" : "1", pending, observed: "2026-11-21" } as T] };
      },
    };
    const provider = {
      ...createBoatProvider({ apiKey: "fixture" }),
      async events() {
        if (pending) throw new Error("The provider must not be read during native activity.");
        return {
          events: [{ kind: "other" as const, id: "event", at: 1, type: "example", data: {} }],
          cursor: "next",
          ...(direction === "backward" ? { olderCursor: "older" } : {}),
          hasMore: true,
        };
      },
    };
    const options = {
      logs: async () => ({ provider: withNativeLogJournal(sql, key, provider, scope), providerSandboxId: "boat-id" }),
    };
    const input = { direction, cursor: "from" };
    const live = readLogsOperation.output.parse(await readLogs(options, caller, scope.id, input));

    pending = true;
    const saved = readLogsOperation.output.parse(await readLogs(options, caller, scope.id, { ...input, follow: true }));
    expect(saved).toEqual({
      ...live,
      events: [expect.objectContaining({ id: "event" })],
      cursor: "next",
      ...(direction === "backward" ? { olderCursor: "older" } : {}),
      hasMore: true,
      settled: false,
    });
  },
);
