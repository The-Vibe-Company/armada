import { expect, spyOn, test } from "bun:test";
import * as postgres from "postgres";
import { statsAccounts } from "./stats-db";

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

test("stats client omits pooler-incompatible startup parameters", async () => {
  const previous = process.env.ARMADA_DATABASE_URL;
  const invalidUrl = "postgres://[";
  const connect = spyOn(postgres, "default");
  process.env.ARMADA_DATABASE_URL = invalidUrl;
  try {
    await expect(statsAccounts()).rejects.toThrow(TypeError);
    expect(connect.mock.calls).toEqual([
      [invalidUrl, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 10 }],
    ]);
  } finally {
    connect.mockRestore();
    if (previous === undefined) delete process.env.ARMADA_DATABASE_URL;
    else process.env.ARMADA_DATABASE_URL = previous;
  }
});
