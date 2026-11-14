import { expect, test } from "bun:test";
import { GoldenCreateService, goldenScript, withGoldenDirs } from "../src/server.ts";

const actor: any = { userId: "u", orgId: "o", role: "admin" };
const repo = { owner: "acme", repo: "web", id: 1, installationId: 2 };
test("coordinates only scanned golden lifecycle", async () => {
  const log: string[] = [];
  const p: any = {
    id: "boat",
    createGolden: async () => {
      log.push("create");
      return { id: "bx" };
    },
    snapshot: async () => {
      log.push("snapshot");
      return { name: "golden-bx", status: "ready" };
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
    id: "boat",
    createGolden: async () => ({ id: "bx" }),
    snapshot: async () => {
      log.push("snapshot");
      return { name: "golden-bx", status: "ready" };
    },
    stop: async () => void log.push("stop"),
  };
  await expect(s.create(p, actor, { name: "x", visibility: "private", repos: ["a"] })).rejects.toMatchObject({
    code: "build_failed",
  });
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
    id: "boat",
    createGolden: async () => ({ id: "bx" }),
    snapshot: async ({ name }: any) => ({ name, status: "ready" }),
    stop: async () => {},
  };
  await s.create(p, actor, { name: "x", visibility: "org", repos: ["acme/web"] });
  expect(log).toEqual(["caller-token", "scan", "persist"]);
});

test("public checkout without an installation never mints", async () => {
  const calls: string[] = [];
  const service = new GoldenCreateService({
    authorize: async () => ({ repos: [{ ...repo, installationId: 0 }], token: "caller-token" }),
    mint: async () => {
      throw Error("Public checkout must not mint");
    },
    ssh: async (_provider, input) => {
      calls.push(input.token);
    },
    scan: async () => {},
    persist: async () => {},
  });
  await service.create(
    {
      id: "boat",
      createGolden: async () => ({ id: "bx" }),
      snapshot: async ({ name }: any) => ({ name, status: "ready" }),
      stop: async () => {},
    } as any,
    actor,
    { name: "public", visibility: "org", repos: ["acme/web"] },
  );
  expect(calls).toEqual(["caller-token"]);
});

test("two installations and a private sixth repository use scoped tokens per checkout, preserving public fallback and one init pass", async () => {
  const repositories = [
    { owner: "acme", repo: "public1", id: 1, installationId: 2 },
    { owner: "acme", repo: "public2", id: 2, installationId: 2 },
    { owner: "acme", repo: "public3", id: 3, installationId: 0 },
    { owner: "acme", repo: "public4", id: 4, installationId: 2 },
    { owner: "acme", repo: "public5", id: 5, installationId: 2 },
    { owner: "other", repo: "private6", id: 6, installationId: 3 },
  ];
  const minted: { installation: number; ids: number[] }[] = [];
  const checkout: { token: string; repositories?: readonly string[]; script: string }[] = [];
  const revoked: number[] = [];
  const service = new GoldenCreateService({
    authorize: async () => ({ repos: repositories, token: "caller-token" }),
    mint: async (installation, ids) => {
      minted.push({ installation, ids });
      return {
        token: "scoped-" + installation,
        revoke: async () => {
          revoked.push(installation);
        },
      };
    },
    ssh: async (_provider, input) => {
      checkout.push(input);
    },
    scan: async () => {},
    persist: async () => {},
  });
  await service.create(
    {
      id: "boat",
      createGolden: async () => ({ id: "bx" }),
      snapshot: async ({ name }: any) => ({ name, status: "ready" }),
      stop: async () => {},
    } as any,
    actor,
    {
      name: "many",
      visibility: "org",
      repos: [],
      config: {
        repos: withGoldenDirs(repositories).map((repository) => ({
          ...repository,
          branch: repository.branch ?? "main",
        })),
        init: ["echo all-ready"],
      },
    },
  );
  expect(minted).toEqual([
    { installation: 2, ids: [1, 2, 4, 5] },
    { installation: 3, ids: [6] },
  ]);
  expect(checkout.map(({ token, repositories }) => ({ token, repositories }))).toEqual([
    { token: "scoped-2", repositories: ["acme/public1", "acme/public2"] },
    { token: "caller-token", repositories: ["acme/public3"] },
    { token: "scoped-2", repositories: ["acme/public4", "acme/public5"] },
    { token: "scoped-3", repositories: ["other/private6"] },
    { token: "", repositories: repositories.map((repository) => repository.owner + "/" + repository.repo) },
  ]);
  expect(checkout.filter(({ script }) => script.includes("echo all-ready"))).toHaveLength(1);
  expect(checkout.at(-1)?.script).not.toContain("git clone");
  for (const { script } of checkout) {
    expect(script).not.toContain("scoped-2");
    expect(script).not.toContain("scoped-3");
    expect(script).not.toContain("caller-token");
    expect(script).toContain("unset ARMADA_GIT_TOKEN");
  }
  expect(revoked).toEqual([2, 3]);
});

test.each(["mint", "checkout"])(
  "all minted installation tokens are revoked after partial %s failure",
  async (failure) => {
    const revoked: number[] = [];
    let snapshots = 0;
    const service = new GoldenCreateService({
      authorize: async () => ({
        repos: [repo, { ...repo, id: 2, repo: "private", installationId: 3 }],
        token: "caller-token",
      }),
      mint: async (installation) => {
        if (installation === 3 && failure === "mint") throw Error("Synthetic mint failure");
        return {
          token: "scoped-" + installation,
          revoke: async () => {
            revoked.push(installation);
          },
        };
      },
      ssh: async () => {
        throw Error("Synthetic checkout failure");
      },
      scan: async () => {},
      persist: async () => {
        throw Error("Must not publish");
      },
    });
    await expect(
      service.create(
        {
          id: "boat",
          createGolden: async () => ({ id: "bx" }),
          snapshot: async () => {
            snapshots++;
            throw Error("Must not snapshot");
          },
          stop: async () => {},
        } as any,
        actor,
        { name: "many", visibility: "org", repos: ["acme/web", "acme/private"] },
      ),
    ).rejects.toThrow();
    expect(revoked).toEqual(failure === "mint" ? [2] : [2, 3]);
    expect(snapshots).toBe(0);
  },
);

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
    id: "boat",
    createGolden: async () => ({ id: "bx" }),
    snapshot: async ({ name }: any) => {
      log.push("snapshot");
      return { name, status: "saving" };
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
    id: "boat",
    createGolden: async () => ({ id: "bx" }),
    snapshot: async ({ name }: any) => ({ name, status: "saving" }),
    getSnapshot: async () => ({ status: "failed", error: "disk full" }),
    deleteSnapshot: async (name: string) => void log.push(`delete:${name}`),
    stop: async () => void log.push("stop"),
  };
  await expect(
    s.create(p, actor, { name: "x", visibility: "org", repos: ["acme/web"] }, { sleep: async () => {} }),
  ).rejects.toThrow("disk full");
  expect(log).toEqual(["delete:golden-bx", "stop"]);
});

test("a persist failure deletes only a confirmed unreferenced ready snapshot and still stops the builder", async () => {
  const log: string[] = [];
  const s = new GoldenCreateService({
    canDiscardSnapshot: async () => true,
    authorize: async () => ({ repos: [repo], token: "caller-token" }),
    ssh: async () => {},
    scan: async () => {},
    persist: async () => {
      throw new Error("database is down");
    },
  });
  const p: any = {
    id: "boat",
    createGolden: async () => ({ id: "bx" }),
    snapshot: async ({ name }: any) => ({ name, status: "ready" }),
    deleteSnapshot: async (name: string) => void log.push(`delete:${name}`),
    stop: async () => void log.push("stop"),
  };
  await expect(s.create(p, actor, { name: "x", visibility: "org", repos: ["acme/web"] })).rejects.toMatchObject({
    code: "build_failed",
  });
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
    id: "boat",
    createGolden: async () => ({ id: "bx" }),
    snapshot: async ({ name }: any) => ({ name, status: "ready" }),
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
  const existing: any = {
    id: "g1",
    provider: "boat",
    modal: null,
    orgId: "o",
    name: "x",
    visibility: "private",
    ownerId: "u",
    config: { repos: [], init: [] },
  };
  const seen: any[] = [];
  const s = new GoldenCreateService({
    authorize: async () => ({ repos: [repo], token: "caller" }),
    reserve: async (_p, _a, value) => {
      seen.push(value);
      return undefined;
    },
    ssh: async () => {},
    scan: async () => {},
    persist: async (value) => {
      seen.push(value.existingGolden);
    },
  });
  const p: any = {
    id: "boat",
    createGolden: async () => ({ id: "bx" }),
    snapshot: async ({ name }: any) => ({ name, status: "ready" }),
    stop: async () => {},
  };
  await s.create(p, actor, { name: "x", visibility: "private", repos: ["acme/web"], existingGolden: existing });
  expect(seen).toEqual([existing, existing]);
});

test("existing golden denial happens before authorization or provider", async () => {
  let touched = false;
  const s = new GoldenCreateService({
    authorize: async () => {
      touched = true;
      return { repos: [repo], token: "x" };
    },
    ssh: async () => {},
    scan: async () => {},
    persist: async () => {},
  });
  const p: any = {
    id: "boat",
    createGolden: async () => {
      touched = true;
      return { id: "bx" };
    },
  };
  const existing: any = {
    id: "g",
    provider: "boat",
    modal: null,
    orgId: "other",
    name: "x",
    visibility: "private",
    ownerId: "u",
    config: { repos: [], init: [] },
  };
  await expect(
    s.create(p, actor, { name: "x", visibility: "private", repos: ["acme/web"], existingGolden: existing }),
  ).rejects.toThrow("cannot rebuild");
  expect(touched).toBe(false);
});

test.each(["returned", "lookup"])("uses provider snapshot identifier with builder provenance from %s", async (mode) => {
  const seen: string[] = [];
  let persisted = "";
  let requested = "";
  const existing: any = {
    id: "stable-id",
    provider: "boat",
    modal: null,
    orgId: "o",
    name: "x",
    visibility: "private",
    ownerId: "u",
    providerSnapshotId: "last-good",
    config: { repos: [], init: [] },
  };
  const service = new GoldenCreateService({
    authorize: async () => ({ repos: [repo], token: "t" }),
    ssh: async () => {},
    scan: async () => {},
    persist: async (input) => {
      persisted = input.snapshot;
    },
  });
  const provider: any = {
    id: "boat",
    createGolden: async () => ({ id: "builder" }),
    snapshot: async ({ name }: { name: string }) => {
      requested = name;
      return {
        name: "opaque-provider-reference",
        status: "saving",
        ...(mode === "returned" ? { sourceSandboxId: "builder" } : {}),
      };
    },
    getSnapshot: async (name: string) => {
      seen.push(name);
      return { name, status: "ready", sourceSandboxId: "builder" };
    },
    stop: async () => {},
  };
  const result = await service.create(
    provider,
    actor,
    {
      name: "x",
      visibility: "private",
      repos: ["acme/web"],
      existingGolden: existing,
    },
    { sleep: async () => {} },
  );
  expect(result.snapshot).toBe("opaque-provider-reference");
  expect(persisted).toBe(result.snapshot);
  expect(requested).toMatch(/^golden-r-[a-f0-9-]+$/);
  expect(seen).toEqual(
    mode === "returned" ? ["opaque-provider-reference"] : ["opaque-provider-reference", "opaque-provider-reference"],
  );
});

test("an uncertain Modal snapshot retains its source and returns an actionable reconciliation refusal", async () => {
  const cleaned: string[] = [];
  const service = new GoldenCreateService({
    authorize: async () => ({ repos: [repo], token: "caller" }),
    ssh: async () => {},
    scan: async () => {},
    persist: async () => {
      throw new Error("must not persist");
    },
  });
  const provider: any = {
    id: "modal",
    createGolden: async () => ({ id: "modal-builder" }),
    snapshot: async () => {
      throw new Error("response lost");
    },
    delete: async () => {
      cleaned.push("delete");
    },
    stop: async () => {
      cleaned.push("stop");
    },
  };
  let error: unknown;
  try {
    await service.create(provider, actor, {
      name: "x",
      visibility: "private",
      repos: ["acme/web"],
      modal: { workspace: "ws", environment: "main", appId: "ap-immutable" },
    });
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({
    code: "conflict",
    retryable: false,
    details: { keepSource: true, sourceSandboxId: "modal-builder" },
  });
  expect(cleaned).toEqual([]);
});
test.each(["missing", "wrong", "last-good"])(
  "unverified remap (%s) never publishes or deletes an unrelated artifact",
  async (mode) => {
    const effects: string[] = [];
    const service = new GoldenCreateService({
      authorize: async () => ({ repos: [repo], token: "t" }),
      ssh: async () => {},
      scan: async () => {},
      persist: async () => {
        effects.push("persist");
      },
    });
    const reference = mode === "last-good" ? "last-good" : "unrelated";
    const provider: any = {
      id: "boat",
      createGolden: async () => ({ id: "builder" }),
      snapshot: async () => ({
        name: reference,
        status: "ready",
        ...(mode === "last-good" ? { sourceSandboxId: "builder" } : {}),
      }),
      getSnapshot: async (name: string) => ({
        name,
        status: "ready",
        ...(mode === "wrong" ? { sourceSandboxId: "another-builder" } : {}),
      }),
      deleteSnapshot: async () => {
        effects.push("delete");
      },
      stop: async () => {
        effects.push("stop");
      },
    };
    await expect(
      service.create(provider, actor, {
        name: "x",
        visibility: "private",
        repos: ["acme/web"],
        existingGolden: {
          id: "g",
          provider: "boat",
          modal: null,
          orgId: "o",
          name: "x",
          visibility: "private",
          ownerId: "u",
          providerSnapshotId: "last-good",
        } as any,
      }),
    ).rejects.toThrow();
    expect(effects).toEqual(["stop"]);
  },
);
