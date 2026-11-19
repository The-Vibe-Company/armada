import { expect, spyOn, test } from "bun:test";
import { harness } from "./support.ts";

test("harness closes its remaining clients and database after a client close rejects", async () => {
  const server = await harness();
  const token = await server.token(server.people.owner);
  const first = await server.client(token);
  const second = await server.client(token);
  const failure = new Error("client close failed");
  // oxlint-disable-next-line landmines-testing/no-test-doubles -- Inject one close rejection while exercising real cleanup for the remaining client and PGlite engine.
  const rejectClose = spyOn(first, "close").mockRejectedValueOnce(failure);
  const closeRemaining = spyOn(second, "close");
  try {
    await expect(server.close()).rejects.toBe(failure);
    expect(server.db.closed).toBe(true);
    expect(closeRemaining).toHaveBeenCalledTimes(1);
  } finally {
    rejectClose.mockRestore();
    closeRemaining.mockRestore();
    await first.close();
    await second.close();
    if (!server.db.closed) await server.db.close();
  }
});
