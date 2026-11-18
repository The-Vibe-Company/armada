import { expect, test } from "bun:test";
import { DOCKER_SNAPSHOT_FAILURE_MESSAGES } from "@armada/core";

// The migrated constraint is what rejects an unlisted reason at runtime; keep it in sync with the
// one set every snapshot writer uses instead of restating the closed domain by hand.
test("the snapshot failure reason constraint admits every shared writer message", async () => {
  const migration = await Bun.file(
    "supabase/migrations/20261118093947_docker_host_snapshot_baseline_capability.sql",
  ).text();
  for (const message of Object.values(DOCKER_SNAPSHOT_FAILURE_MESSAGES))
    expect(migration).toContain(`'${message.replaceAll("'", "''")}'`);
});
