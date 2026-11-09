import type { PGlite } from "@electric-sql/pglite";
import type { GoldenStore } from "../../src/golden.ts";
import { beginGoldenOperation, reconcileGoldenOperations, type Sql } from "../../src/golden-store.ts";

/** RLS fixtures model the API boundary: user-role resource reads/writes, trusted
 * server-role physical outcome ownership. Never omit admission or manufacture receipts. */
export function serviceGoldenOperations(db: PGlite): Pick<GoldenStore, "beginOperation" | "reconcileOperations"> {
  const server: Sql = {
    async query<T>(text: string, params?: unknown[]) {
      await db.exec("savepoint trusted_operation");
      try {
        await db.exec("set local role service_role");
        const result = await db.query<T>(text, params);
        await db.exec("release savepoint trusted_operation");
        return result;
      } catch (error) {
        await db.exec("rollback to savepoint trusted_operation; release savepoint trusted_operation");
        throw error;
      } finally {
        await db.exec("set local role authenticated");
      }
    },
  };
  return {
    beginOperation: (id, expected) => beginGoldenOperation(server, id, expected),
    reconcileOperations: (golden, actor) => reconcileGoldenOperations(server, golden, actor),
  };
}
