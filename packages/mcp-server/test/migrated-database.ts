// Keep the MCP fixture entrypoint used by the stacked slices, but share main's
// process-local image instead of building a second pristine database.
export { openMigratedDatabase as migratedDatabase } from "../../../scripts/test-support/migrated-database.ts";
