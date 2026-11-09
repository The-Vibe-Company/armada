import { expect, test } from "bun:test";
import { statsAccounts } from "../src/lib/stats-db";

test("missing ARMADA_DATABASE_URL provides no privileged stats database", async () => {
  const previous = process.env.ARMADA_DATABASE_URL;
  delete process.env.ARMADA_DATABASE_URL;
  try {
    expect(await statsAccounts()).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.ARMADA_DATABASE_URL;
    else process.env.ARMADA_DATABASE_URL = previous;
  }
});
