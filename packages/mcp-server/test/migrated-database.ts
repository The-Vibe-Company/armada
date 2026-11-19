// Keep the MCP fixture entrypoint used by the stacked slices, but share main's
// process-local image instead of building a second pristine database.
export { openMigratedDatabase as migratedDatabase } from "../../../scripts/test-support/migrated-database.ts";

import { afterAll, beforeAll } from "bun:test";
import { openMigratedDatabase } from "../../../scripts/test-support/migrated-database.ts";

/** Owns both an opening database and the ready connection borrowed by SQL callbacks. */
export function databaseFixture<T extends { close(): Promise<void> }>(open: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  let ready: T | undefined;
  return {
    async setup() {
      const opening = open();
      pending = opening;
      const database = await opening;
      if (pending === opening) ready = database;
    },
    get() {
      if (!ready) throw new Error("Database fixture is not open");
      return ready;
    },
    async close() {
      const opening = pending;
      pending = undefined;
      ready = undefined;
      // The setup hook reports an open failure. Teardown owns any engine it produced.
      const database = await opening?.catch(() => undefined);
      await database?.close();
    },
  };
}

export function useMigratedDatabase() {
  const fixture = databaseFixture(openMigratedDatabase);
  beforeAll(fixture.setup);
  afterAll(fixture.close);
  return fixture.get;
}
