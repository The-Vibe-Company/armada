import { expect, test } from "bun:test";
import { GoldenCreateService, goldenScript, withGoldenDirs } from "../src/index.ts";

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
    authorize: async () => ({ repos: [repo], token: "caller-token" }),
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
    authorize: async () => ({ repos: [repo], token: "caller-token" }),
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
test("falls back to the caller's own token and never mints when no App is configured", async () => {
  const log: string[] = [];
  const s = new GoldenCreateService({
    authorize: async () => ({ repos: [repo], token: "caller-token" }),
    ssh: async (_p, x) => {
      log.push(x.token);
    },
    scan: async () => {
      void log.push("scan");
    },
    persist: async () => {
      void log.push("persist");
    },
  });
  const p: any = {
    createGolden: async () => ({ id: "bx" }),
    snapshot: async () => ({ status: "ready" }),
    stop: async () => {},
  };
  await s.create(p, actor, { name: "x", visibility: "org", repos: ["acme/web"] });
  expect(log).toEqual(["caller-token", "scan", "persist"]);
});

test("script has canonical single-segment paths and unsets token", () => {
  const prepared = withGoldenDirs([repo]);
  const x = goldenScript(prepared);
  expect(x).toContain("/home/user/web");
  expect(x).not.toContain("/home/user/acme/web");
  expect(x).toContain("unset ARMADA_GIT_TOKEN");
  expect(() => goldenScript(withGoldenDirs([{ ...repo, owner: "../x" }]))).toThrow("Unsafe");
});

test("withGoldenDirs disambiguates repos that share a name", () => {
  const other = { owner: "other", repo: "web", id: 9, installationId: 2 };
  const dirs = withGoldenDirs([repo, other]).map((r) => r.dir);
  expect(dirs).toEqual(["web", "web-2"]);
});
