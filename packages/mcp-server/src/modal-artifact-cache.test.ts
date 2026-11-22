import { expect, test } from "bun:test";
import { createModalArtifactCache } from "./modal-artifact-cache.ts";

test("Modal cache coalesces warming per binding and retries after a failed seed", async () => {
  const binding = { appId: "app", appName: "name", environment: "main", tokenId: "id", tokenSecret: "secret" };
  const runtime = { sha256: "a".repeat(64), bytes: 1 };
  const archive = { sha256: "b".repeat(64), bytes: 2 };
  const opencode = { sha256: "c".repeat(64), bytes: 3 };
  const environments: string[] = [];
  const { warm } = createModalArtifactCache(
    { runtime, harnesses: { codex: { archive } }, opencode },
    "/public",
    async (request) => {
      expect(request.pins).toEqual([runtime, archive, opencode]);
      expect(request.directory).toBe("/public");
      environments.push(request.environment);
      if (environments.length === 1) throw Error("seed failed");
    },
  );

  const failed = warm(binding);
  expect(warm(binding)).toBe(failed);
  await expect(failed).rejects.toThrow("seed failed");
  await warm(binding);
  await warm(binding);
  await warm({ ...binding, environment: "other" });
  expect(environments).toEqual(["main", "main", "other"]);
});

test("first use leaves the launch free to proceed and shutdown cancels the pending seed", async () => {
  const binding = { appId: "app", appName: "name", environment: "main", tokenId: "id", tokenSecret: "secret" };
  const runtime = { sha256: "a".repeat(64), bytes: 1 };
  let starts = 0;
  let cancellations = 0;
  const cache = createModalArtifactCache({ runtime, harnesses: {} }, "/public", (_request, signal) => {
    starts++;
    return new Promise<void>((resolve) => {
      signal?.addEventListener("abort", () => {
        cancellations++;
        resolve();
      });
    });
  });
  expect(cache.beginWarming(binding, () => {})).toBeUndefined();
  cache.beginWarming(binding, () => {});
  await cache.drain();
  cache.beginWarming({ ...binding, environment: "other" }, () => {});
  expect(starts).toBe(1);
  expect(cancellations).toBe(1);
});

test("startup and first-use warming share four upload slots and coalesce by binding", async () => {
  const binding = { appId: "app", appName: "name", environment: "main", tokenId: "id", tokenSecret: "secret" };
  const runtime = { sha256: "a".repeat(64), bytes: 1 };
  const first = Promise.withResolvers<void>();
  const startedLast = Promise.withResolvers<void>();
  const started: string[] = [];
  const cache = createModalArtifactCache({ runtime, harnesses: {} }, "/public", async (request) => {
    started.push(request.appId);
    if (request.appId === "last") {
      startedLast.resolve();
      return;
    }
    await first.promise;
  });
  for (const appId of ["one", "two", "three", "four"]) cache.beginWarming({ ...binding, appId }, () => {});
  const startup = cache.warm({ ...binding, appId: "last" });
  cache.beginWarming({ ...binding, appId: "last" }, () => {});
  expect(started).toEqual(["one", "two", "three", "four"]);
  first.resolve();
  await Promise.all([startup, startedLast.promise]);
  await cache.drain();
  expect(started).toEqual(["one", "two", "three", "four", "last"]);
});
