import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { retryDatabaseBoot } from "../src/database-boot.ts";

afterEach(() => jest.restoreAllMocks());

test("boot survives admission pressure with capped backoff and redacted diagnostics", async () => {
  const delays: number[] = [];
  spyOn(Bun, "sleep").mockImplementation((async (ms: number) => {
    delays.push(ms);
  }) as typeof Bun.sleep);
  let attempts = 0;
  const logs: string[] = [];
  await retryDatabaseBoot(
    async () => {
      if (++attempts < 9) throw Object.assign(new Error("secret connection string"), { errno: "EMAXCONNSESSION" });
    },
    (line) => logs.push(line),
  );
  expect(attempts).toBe(9);
  expect(delays).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
  expect(logs.every((line) => !line.includes("secret"))).toBe(true);
});

test("boot fails promptly on permanent SQL errors and stops retrying after its deadline", async () => {
  const log = () => {};
  const permanent = Object.assign(new Error("invalid auth"), { errno: "28P01" });
  await expect(
    retryDatabaseBoot(async () => {
      throw permanent;
    }, log),
  ).rejects.toBe(permanent);
  let now = 0;
  spyOn(Date, "now").mockImplementation(() => now);
  spyOn(Bun, "sleep").mockImplementation((async () => {
    now += 120_000;
  }) as typeof Bun.sleep);
  let attempts = 0;
  const full = { code: "EMAXCONNSESSION" };
  await expect(
    retryDatabaseBoot(async () => {
      attempts++;
      throw full;
    }, log),
  ).rejects.toBe(full);
  expect(attempts).toBe(2);
});
