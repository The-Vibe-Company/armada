import { expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { harness } from "./support.ts";

test("harness closes its database when handler setup fails", async () => {
  let opened: PGlite | undefined;
  const setupError = new Error("handler setup failed");
  try {
    await expect(
      harness({
        authStore(db) {
          opened = db;
          throw setupError;
        },
      }),
    ).rejects.toBe(setupError);
    expect(opened?.closed).toBe(true);
  } finally {
    if (opened && !opened.closed) await opened.close();
  }
});
