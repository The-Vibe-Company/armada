import { expect, test } from "bun:test";
import { GoldenCreateService, goldenScript, withGoldenDirs } from "../src/server.ts";

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

test("authorized repositories across installations use the caller token and do not revoke it", async () => {
  const log: string[] = [];
  const s = new GoldenCreateService({
    authorize: async () => ({
      repos: [repo, { owner: "other", repo: "api", id: 2, installationId: 3 }],
      token: "caller-token",
    }),
    mint: async () => {
      throw new Error("installation mint must not run");
    },
    ssh: async (_p, input) => {
      log.push(input.token);
    },
    scan: async () => {},
    persist: async () => {
      log.push("persist");
    },
  });
  const p: any = {
    createGolden: async () => ({ id: "bx" }),
    snapshot: async () => ({ status: "ready" }),
    stop: async () => {},
  };
  await s.create(p, actor, { name: "many", visibility: "org", repos: ["acme/web", "other/api"] });
  expect(log).toEqual(["caller-token", "persist"]);
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

test("a snapshot that starts out saving is polled until ready before persisting", async () => {
  const log: string[] = [];
  const s = new GoldenCreateService({
    authorize: async () => ({ repos: [repo], token: "caller-token" }),
    ssh: async () => {},
    scan: async () => {},
    persist: async () => {
      void log.push("persist");
    },
  });
  let getSnapshotCalls = 0;
  const p: any = {
    createGolden: async () => ({ id: "bx" }),
    snapshot: async () => {
      log.push("snapshot");
      return { status: "saving" };
    },
    getSnapshot: async (name: string) => {
      getSnapshotCalls += 1;
      log.push(`getSnapshot:${name}`);
      return { name, status: getSnapshotCalls < 3 ? "saving" : "ready" };
    },
    stop: async () => void log.push("stop"),
  };
  const result = await s.create(
    p,
    actor,
    { name: "x", visibility: "org", repos: ["acme/web"] },
    { sleep: async () => {}, snapshotPolls: 10 },
  );
  expect(result.snapshot).toBe("golden-bx");
  expect(getSnapshotCalls).toBe(3);
  expect(log).toEqual([
    "snapshot",
    "getSnapshot:golden-bx",
    "getSnapshot:golden-bx",
    "getSnapshot:golden-bx",
    "persist",
    "stop",
  ]);
});

test("a snapshot that never becomes ready is never persisted", async () => {
  const log: string[] = [];
  const s = new GoldenCreateService({
    authorize: async () => ({ repos: [repo], token: "caller-token" }),
    ssh: async () => {},
    scan: async () => {},
    persist: async () => {
      void log.push("persist");
    },
  });
  const p: any = {
    createGolden: async () => ({ id: "bx" }),
    snapshot: async () => ({ status: "saving" }),
    getSnapshot: async () => ({ status: "failed", error: "disk full" }),
    stop: async () => void log.push("stop"),
  };
  await expect(
    s.create(p, actor, { name: "x", visibility: "org", repos: ["acme/web"] }, { sleep: async () => {} }),
  ).rejects.toThrow("disk full");
  expect(log).toEqual(["stop"]);
});

test("a persist failure deletes the orphaned ready snapshot and still stops the builder", async () => {
  const log: string[] = [];
  const s = new GoldenCreateService({
    authorize: async () => ({ repos: [repo], token: "caller-token" }),
    ssh: async () => {},
    scan: async () => {},
    persist: async () => {
      throw new Error("database is down");
    },
  });
  const p: any = {
    createGolden: async () => ({ id: "bx" }),
    snapshot: async () => ({ status: "ready" }),
    deleteSnapshot: async (name: string) => void log.push(`delete:${name}`),
    stop: async () => void log.push("stop"),
  };
  await expect(s.create(p, actor, { name: "x", visibility: "org", repos: ["acme/web"] })).rejects.toThrow(
    "database is down",
  );
  expect(log).toEqual(["delete:golden-bx", "stop"]);
});

test("uses normalized branches, directories, and init commands after canonical authorization", async () => {
  let script = "";
  let authorized: string[] = [];
  const service = new GoldenCreateService({
    authorize: async (_actor, _visibility, repos) => {
      authorized = repos;
      return { repos: [repo], token: "caller" };
    },
    ssh: async (_provider, input) => {
      script = input.script;
    },
    scan: async () => {},
    persist: async () => {},
  });
  const provider: any = {
    createGolden: async () => ({ id: "bx" }),
    snapshot: async () => ({ status: "ready" }),
    stop: async () => {},
  };
  await service.create(provider, actor, {
    name: "x",
    visibility: "org",
    repos: [],
    config: {
      repos: [{ owner: "acme", repo: "web", branch: "feature/login", dir: "frontend" }],
      init: ["pnpm install"],
    },
  });
  expect(authorized).toEqual(["acme/web"]);
  expect(script).toContain("--branch 'feature/login'");
  expect(script).toContain("/home/user/frontend");
  expect(script).toContain("pnpm install");
});

test("keeps the legacy repo-string API compatible", () => {
  expect(goldenScript(withGoldenDirs([repo]), ["echo setup"])).toContain("echo setup");
});

test("existing golden context is authorized before provider work and propagated", async () => {
  const existing: any = { id: "g1", orgId: "o", name: "x", visibility: "private", ownerId: "u", config: { repos: [], init: [] } };
  const seen: any[] = [];
  const s = new GoldenCreateService({
    authorize: async () => ({ repos: [repo], token: "caller" }),
    reserve: async (_p, _a, value) => { seen.push(value); return undefined; },
    ssh: async () => {}, scan: async () => {},
    persist: async (value) => { seen.push(value.existingGolden); },
  });
  const p: any = { createGolden: async () => ({ id: "bx" }), snapshot: async () => ({ status: "ready" }), stop: async () => {} };
  await s.create(p, actor, { name: "x", visibility: "private", repos: ["acme/web"], existingGolden: existing });
  expect(seen).toEqual([existing, existing]);
});

test("existing golden denial happens before authorization or provider", async () => {
  let touched = false;
  const s = new GoldenCreateService({ authorize: async () => { touched = true; return { repos: [repo], token: "x" }; }, ssh: async () => {}, scan: async () => {}, persist: async () => {} });
  const p: any = { createGolden: async () => { touched = true; return { id: "bx" }; } };
  const existing: any = { id: "g", orgId: "other", name: "x", visibility: "private", ownerId: "u", config: { repos: [], init: [] } };
  await expect(s.create(p, actor, { name: "x", visibility: "private", repos: ["acme/web"], existingGolden: existing })).rejects.toThrow("cannot rebuild");
  expect(touched).toBe(false);
});
