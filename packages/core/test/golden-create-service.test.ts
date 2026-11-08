import { expect, test } from "bun:test";
import { GoldenCreateService, goldenScript } from "../src/index.ts";

const actor: any = { userId: "u", orgId: "o", role: "admin" };
const repo = { owner: "acme", repo: "web", id: 1, installationId: 2 };
test("coordinates only scanned golden lifecycle", async () => {
  const log: string[] = [];
  const p: any = {
    createGolden: async () => {
      log.push("create");
      return { id: "bx" };
    },
    snapshot: async () => {
      log.push("snapshot");
      return { status: "ready" };
    },
    stop: async () => {
      void log.push("stop");
    },
  };
  const s = new GoldenCreateService({
    authorize: async () => [repo],
    mint: async () => ({
      token: "secret",
      revoke: async () => {
        void log.push("revoke");
      },
    }),
    ssh: async (_p, x) => {
      log.push(x.script.includes("unset ARMADA_GIT_TOKEN") ? "ssh" : "bad");
    },
    scan: async () => {
      void log.push("scan");
    },
    persist: async () => {
      void log.push("persist");
    },
  });
  await s.create(p, actor, { name: "x", visibility: "org", repos: ["acme/web"] });
  expect(log).toEqual(["create", "ssh", "scan", "snapshot", "persist", "revoke", "stop"]);
});
test("scan failure never snapshots or persists and cleans up", async () => {
  const log: string[] = [];
  const s = new GoldenCreateService({
    authorize: async () => [repo],
    mint: async () => ({ token: "x", revoke: async () => void log.push("revoke") }),
    ssh: async () => {},
    scan: async () => {
      throw Error("secret");
    },
    persist: async () => {
      void log.push("persist");
    },
  });
  const p: any = {
    createGolden: async () => ({ id: "bx" }),
    snapshot: async () => {
      log.push("snapshot");
      return { status: "ready" };
    },
    stop: async () => void log.push("stop"),
  };
  await expect(s.create(p, actor, { name: "x", visibility: "private", repos: ["a"] })).rejects.toThrow("secret");
  expect(log).toEqual(["revoke", "stop"]);
});
test("script has canonical paths and unsets token", () => {
  const x = goldenScript([repo]);
  expect(x).toContain("/home/user/acme/web");
  expect(x).toContain("unset ARMADA_GIT_TOKEN");
  expect(() => goldenScript([{ ...repo, owner: "../x" }])).toThrow("Unsafe");
});
