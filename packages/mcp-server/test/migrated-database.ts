// Keep the MCP fixture entrypoint used by the stacked slices, but share main's
// process-local image instead of building a second pristine database.
export { openMigratedDatabase as migratedDatabase } from "../../../scripts/test-support/migrated-database.ts";

import { afterAll, beforeAll } from "bun:test";
import { openMigratedDatabase } from "../../../scripts/test-support/migrated-database.ts";
import { closeableFixture } from "./closeable-fixture.ts";

export function useMigratedDatabase() {
  const fixture = closeableFixture(openMigratedDatabase);
  beforeAll(fixture.setup);
  afterAll(fixture.close);
  return fixture.get;
}
