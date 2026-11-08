import { describe, expect, test } from "bun:test";

/**
 * Opt-in integration coverage for two real PostgreSQL connections. PGlite has one connection and
 * cannot prove an advisory lock's cross-connection lifetime. Set ARMADA_TEST_POSTGRES_URL to run.
 */
describe.skipIf(!process.env.ARMADA_TEST_POSTGRES_URL)("GitHub refresh advisory lock (PostgreSQL)", () => {
  test("blocks a second transaction until the first callback commits, then releases after errors", async () => {
    const url = process.env.ARMADA_TEST_POSTGRES_URL;
    if (!url) throw new Error("ARMADA_TEST_POSTGRES_URL is required");
    const one = new Bun.SQL(url);
    const two = new Bun.SQL(url);
    const key = crypto.randomUUID();
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let enteredFirst!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const first = one.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      enteredFirst();
      await held;
    });
    await entered;
    let secondEntered = false;
    const second = two.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      secondEntered = true;
    });
    await Bun.sleep(25);
    expect(secondEntered).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);

    await expect(
      one.begin(async (sql) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await two.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    });
    await one.end();
    await two.end();
  });
});
