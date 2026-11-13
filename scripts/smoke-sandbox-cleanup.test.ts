import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postDeploySmoke } from "./post-deploy-smoke.ts";
import {
  deleteSmokeReceipts,
  readSmokeJournal,
  STAGING_ORIGIN,
  saveSmokeJournal,
  smokeReceipts,
} from "./smoke-sandbox-cleanup.ts";

const row = {
  requestKey: "post-deploy-smoke:11111111-1111-1111-1111-111111111111",
  org: "staging-org",
  id: "22222222-2222-2222-2222-222222222222",
};

test("bounded cleanup only removes receipted IDs and retains unconfirmed deletes for a later sweep", async () => {
  for (const success of [true, false]) {
    const calls: string[] = [];
    const rows = [row, { ...row, id: "33333333-3333-3333-3333-333333333333" }];
    const remaining = await deleteSmokeReceipts(
      STAGING_ORIGIN,
      "token",
      rows,
      {
        out: () => {},
        fetch: (async (url: string, init: RequestInit) => {
          calls.push(url);
          if (init.method === "DELETE") {
            expect(new URL(url).searchParams.get("org")).toBe(row.org);
            expect(new URL(url).pathname).toBe(`/api/v1/sandboxes/${row.id}`);
            expect(init.body).toBeUndefined();
            return Response.json(success ? { id: row.id, status: "deleted" } : { error: { code: "forbidden" } }, {
              status: success ? 200 : 403,
            });
          }
          expect(JSON.parse(String(init.body))).toEqual({ org: row.org, id: row.id });
          return Response.json({ id: row.id, status: "stopped" });
        }) as unknown as typeof fetch,
      },
      1,
    );
    expect(calls).toHaveLength(2);
    expect(remaining.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual(success ? rows.slice(1) : rows);
  }
});

test("cleanup refuses production and malformed/non-smoke manifests without network access", async () => {
  let calls = 0;
  await expect(
    deleteSmokeReceipts("https://armada.example", "token", [row], {
      out: () => {},
      fetch: (async () => {
        calls++;
        return Response.json({});
      }) as unknown as typeof fetch,
    }),
  ).rejects.toThrow("staging_only");
  expect(calls).toBe(0);
  expect(() => smokeReceipts([{ ...row, requestKey: "all-stopped" }])).toThrow();
});

test("a malformed launch receipt still gets deleted and a failed delete persists in the journal", async () => {
  for (const deleted of [true, false]) {
    const directory = await mkdtemp(join(tmpdir(), "smoke-cleanup-"));
    const path = join(directory, "journal.json");
    const calls: string[] = [];
    try {
      const backlog = Array.from({ length: 100 }, (_, index) => ({
        ...row,
        id: `44444444-4444-4444-4444-${String(index).padStart(12, "0")}`,
      }));
      await saveSmokeJournal(path, backlog);
      const passed = await postDeploySmoke(
        {
          ARMADA_URL: STAGING_ORIGIN,
          ARMADA_TOKEN: "token",
          ARMADA_SMOKE: "create_real_compute",
          ARMADA_SMOKE_JOURNAL: path,
          ARMADA_SMOKE_CASES: JSON.stringify([
            {
              provider: "modal",
              harness: "codex",
              org: row.org,
              golden: "smoke",
              model: "model",
              modelAccountId: "account",
              repo: "/repo",
            },
          ]),
        },
        [],
        {
          now: () => 0,
          sleep: async () => {},
          out: () => {},
          fetch: async (url, init) => {
            const action = init.method === "DELETE" ? "delete" : url.split("/").at(-1)!;
            calls.push(action);
            if (action === "launch")
              return Response.json({ sandbox: { id: row.id, provider: "modal" }, promptId: "unexpected-prompt" });
            if (action === "stop") return Response.json({ status: "stopped" });
            if (action === "status") return Response.json({ status: "stopped", providerState: "stopped" });
            if (action === "delete") {
              const id = new URL(url).pathname.split("/").at(-1);
              return Response.json({ id, status: id === row.id && deleted ? "deleted" : "stopped" });
            }
            throw new Error("unexpected request");
          },
        },
      );
      expect(passed).toBe(false);
      expect(calls).toContain("delete");
      expect(await readSmokeJournal(path)).toHaveLength(deleted ? 100 : 101);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("cleanup waits for terminal stop and reconciles pending provider deletion across its retained activity lease", async () => {
  let clock = 0;
  let stopCalls = 0;
  let deleteCalls = 0;
  const output: Record<string, unknown>[] = [];
  const remaining = await deleteSmokeReceipts(STAGING_ORIGIN, "token", [row], {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    out: (line) => output.push(JSON.parse(line)),
    fetch: async (url, init) => {
      if (url.endsWith("/stop")) {
        stopCalls++;
        return Response.json({ status: "stopping" });
      }
      if (url.endsWith("/status")) return Response.json({ id: row.id, status: clock === 0 ? "stopping" : "stopped" });
      expect(init.method).toBe("DELETE");
      deleteCalls++;
      if (clock < 125_000)
        return Response.json(
          { error: { code: deleteCalls === 1 ? "conflict" : "sandbox_not_ready", message: "private-provider-body" } },
          { status: 409 },
        );
      return Response.json({ id: row.id, status: "deleted" });
    },
  });
  expect(remaining).toEqual([]);
  expect(stopCalls).toBe(1);
  expect(deleteCalls).toBeGreaterThan(1);
  expect(output).toContainEqual({
    step: "delete_smoke_sandbox_retry",
    ...row,
    phase: "delete",
    httpStatus: 409,
    code: "conflict",
  });
  expect(JSON.stringify(output)).not.toContain("private-provider-body");
});

test.each(["forbidden", "not_found", "private-provider-secret"])(
  "failed cleanup reports only safe HTTP status and closed error codes: %s",
  async (remoteCode) => {
    const output: Record<string, unknown>[] = [];
    const remaining = await deleteSmokeReceipts(STAGING_ORIGIN, "secret-token", [row], {
      out: (line) => output.push(JSON.parse(line)),
      fetch: async (_url, init) =>
        init.method === "DELETE"
          ? Response.json({ error: { code: remoteCode, message: "secret-message" } }, { status: 403 })
          : Response.json({ id: row.id, status: "stopped" }),
    });
    expect(remaining).toEqual([row]);
    expect(output).toContainEqual({
      step: "delete_smoke_sandbox",
      pass: false,
      ...row,
      phase: "delete",
      httpStatus: 403,
      code: remoteCode === "private-provider-secret" ? "api_failed" : remoteCode,
    });
    expect(JSON.stringify(output)).not.toMatch(/secret-token|secret-message|private-provider-secret/);
  },
);

test("lease retries remain inside the caller's cleanup deadline and preserve the final HTTP refusal", async () => {
  let clock = 0;
  const output: Record<string, unknown>[] = [];
  const remaining = await deleteSmokeReceipts(STAGING_ORIGIN, "token", [row], {
    now: () => clock,
    deadline: 10_000,
    sleep: async (ms) => {
      clock += ms;
    },
    out: (line) => output.push(JSON.parse(line)),
    fetch: async (_url, init) =>
      init.method === "DELETE"
        ? Response.json({ error: { code: "conflict" } }, { status: 409 })
        : Response.json({ id: row.id, status: "stopped" }),
  });
  expect(clock).toBe(10_000);
  expect(remaining).toEqual([row]);
  expect(output.at(-1)).toEqual({
    step: "delete_smoke_sandbox",
    pass: false,
    ...row,
    phase: "delete",
    httpStatus: 409,
    code: "conflict",
  });
});

test("a terminal stop receipt goes directly to idempotent deletion even if the provider is already gone", async () => {
  const remaining = await deleteSmokeReceipts(STAGING_ORIGIN, "token", [row], {
    out: () => {},
    fetch: async (url, init) => {
      if (url.endsWith("/status")) throw Error("provider status must not block tombstone finalization");
      return Response.json({ id: row.id, status: init.method === "DELETE" ? "deleted" : "stopped" });
    },
  });
  expect(remaining).toEqual([]);
});

test.each([1, 32])("late parent settles before scoped child, even when the sweep limit is %s", async (limit) => {
  let clock = 0;
  let parentDeleted = false;
  let stopCalls = 0;
  const child = {
    ...row,
    id: "33333333-3333-3333-3333-333333333333",
    requestKey: "smoke-scoped-11111111-1111-1111-1111-111111111111",
  };
  const remaining = await deleteSmokeReceipts(
    STAGING_ORIGIN,
    "token",
    [child, row],
    {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      out: () => {},
      fetch: async (url, init) => {
        const id =
          init.method === "DELETE" ? new URL(url).pathname.split("/").at(-1) : JSON.parse(String(init.body)).id;
        if (id === child.id) {
          expect(parentDeleted).toBe(true);
          return Response.json({ id, status: init.method === "DELETE" ? "deleted" : "stopped" });
        }
        if (url.endsWith("/stop")) {
          stopCalls++;
          return Response.json({ id, status: "stopping" });
        }
        if (url.endsWith("/status")) return Response.json({ id, status: clock < 130_000 ? "stopping" : "stopped" });
        if (clock < 250_000) return Response.json({ error: { code: "sandbox_not_ready" } }, { status: 409 });
        parentDeleted = true;
        return Response.json({ id, status: "deleted" });
      },
    },
    limit,
  );
  expect(remaining).toEqual(limit === 1 ? [child] : []);
  expect(parentDeleted).toBe(true);
  expect(stopCalls).toBe(1);
  expect(clock).toBe(250_000);
});

test("excluded and unclassified historical receipts are preserved without Boat calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smoke-deferred-"));
  const path = join(directory, "journal.json");
  const receipts = [row, { ...row, id: "33333333-3333-3333-3333-333333333333", provider: "boat" as const }];
  try {
    await saveSmokeJournal(path, receipts);
    const lines: string[] = [];
    let calls = 0;
    expect(
      await postDeploySmoke(
        {
          ARMADA_URL: STAGING_ORIGIN,
          ARMADA_TOKEN: "token",
          ARMADA_SMOKE: "create_real_compute",
          ARMADA_SMOKE_JOURNAL: path,
          ARMADA_SMOKE_CASES: JSON.stringify([{ provider: "boat" }]),
        },
        [],
        {
          now: () => 0,
          sleep: async () => {},
          out: (line) => lines.push(line),
          fetch: async () => {
            calls++;
            throw Error("No excluded provider call");
          },
        },
      ),
    ).toBe(false);
    expect(calls).toBe(0);
    expect(await readSmokeJournal(path)).toEqual(receipts);
    expect(lines.filter((line) => line === "boat: not part of the release gate")).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unexpected Boat receipt is retained for operator reconciliation without any Boat cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smoke-unexpected-"));
  const path = join(directory, "journal.json");
  const calls: string[] = [];
  try {
    expect(
      await postDeploySmoke(
        {
          ARMADA_URL: STAGING_ORIGIN,
          ARMADA_TOKEN: "token",
          ARMADA_SMOKE: "create_real_compute",
          ARMADA_SMOKE_JOURNAL: path,
          ARMADA_SMOKE_CASES: JSON.stringify([
            {
              provider: "modal",
              harness: "codex",
              org: row.org,
              golden: "smoke",
              model: "model",
              modelAccountId: "account",
              repo: "/repo",
            },
          ]),
        },
        [],
        {
          now: () => 0,
          sleep: async () => {},
          out: () => {},
          fetch: async (url) => {
            calls.push(url.split("/").at(-1)!);
            return Response.json({ sandbox: { id: row.id, provider: "boat" } });
          },
        },
      ),
    ).toBe(false);
    expect(calls).toEqual(["launch"]);
    const retained = await readSmokeJournal(path);
    expect(retained).toHaveLength(1);
    expect(retained[0]?.provider).toBe("boat");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  { state: "failed", provider: "boat", manifestProvider: "boat" },
  { state: "reconciling", provider: "boat", manifestProvider: "boat" },
  { state: "reconciling", provider: undefined, manifestProvider: undefined },
  { state: "failed", provider: "modal", manifestProvider: "boat" },
])(
  "$state template excluded/unverified handle is quarantined before helper cleanup adoption",
  async ({ state, provider, manifestProvider }) => {
    const directory = await mkdtemp(join(tmpdir(), "smoke-template-excluded-"));
    const path = join(directory, "journal.json");
    const routes: string[] = [];
    try {
      expect(
        await postDeploySmoke(
          {
            ARMADA_URL: STAGING_ORIGIN,
            ARMADA_TOKEN: "token",
            ARMADA_SMOKE: "create_real_compute",
            ARMADA_SMOKE_JOURNAL: path,
            ARMADA_SMOKE_CASES: JSON.stringify([
              {
                provider: "modal",
                harness: "codex",
                org: row.org,
                golden: "smoke",
                goldenId: "golden",
                model: "model",
                modelAccountId: "account",
                repo: "/repo",
              },
            ]),
          },
          ["--templates-skills"],
          {
            now: () => 0,
            sleep: async () => {},
            out: () => {},
            fetch: async (url) => {
              const route = url.split("/api/v1/")[1]!;
              routes.push(route);
              if (route === "creds/list")
                return Response.json({
                  user: [{ id: "account", version: 1, kind: "openai_api_key" }],
                  orgs: [{ id: row.org, credentials: [] }],
                });
              if (route === "variables/set") return Response.json({ item: { id: "variable", version: 1 } });
              if (route === "templates/create") return Response.json({ item: { id: "template", currentRevision: 1 } });
              if (route === "templates/launch")
                return Response.json({
                  state,
                  id: row.id,
                  provider,
                  manifest: { definition: { provider: manifestProvider } },
                });
              if (route === "templates/delete" || route === "variables/delete")
                return Response.json({ item: { status: "deleted" } });
              throw Error(`unexpected route ${route}`);
            },
          },
        ),
      ).toBe(false);
      expect(routes).toContain("templates/launch");
      expect(routes.some((route) => route.startsWith("sandbox/") || route.startsWith("sandboxes/"))).toBe(false);
      const retained = await readSmokeJournal(path);
      expect(retained).toHaveLength(1);
      expect(retained[0]?.id).toBe(row.id);
      expect(retained[0]?.provider).toBe(provider === "boat" ? "boat" : undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
