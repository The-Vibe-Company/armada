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

test.each([
  { status: 200, body: { id: row.id, status: "deleted" }, settled: true },
  { status: 404, body: { error: { code: "not_found" } }, settled: true },
  { status: 409, body: { error: { code: "sandbox_not_ready" } }, settled: false },
  { status: 409, body: { error: { code: "conflict" } }, settled: false },
  { status: 200, body: { id: row.id, status: "stopping" }, settled: false },
  { status: 200, body: { id: "other", status: "deleted" }, settled: false },
  { status: 0, body: null, settled: false },
])("submits only one DELETE and checks its receipt ($status, $body)", async ({ status, body, settled }) => {
  const calls: string[] = [];
  const output: unknown[] = [];
  const remaining = await deleteSmokeReceipts(STAGING_ORIGIN, "token", [row], {
    out: (line) => output.push(JSON.parse(line)),
    fetch: async (url, init) => {
      calls.push(`${init.method} ${url}`);
      if (status === 0) throw Error("response lost");
      return Response.json(body, { status });
    },
  });
  expect(calls).toEqual([`DELETE ${STAGING_ORIGIN}/api/v1/sandboxes/${row.id}?org=${row.org}`]);
  expect(remaining).toEqual(settled ? [] : [row]);
  expect(output).toEqual([expect.objectContaining({ step: "delete_smoke_sandbox", id: row.id, pass: settled })]);
});

test.each(["unknown_route", "forbidden"])("cleanup retains a 404 that is not sandbox not_found: %s", async (code) => {
  const remaining = await deleteSmokeReceipts(STAGING_ORIGIN, "token", [row], {
    out: () => {},
    fetch: async () => Response.json({ error: { code } }, { status: 404 }),
  });
  expect(remaining).toEqual([row]);
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
    let clock = 0;
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
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
          out: () => {},
          fetch: async (url, init) => {
            const action = init.method === "DELETE" ? "delete" : url.split("/").at(-1)!;
            calls.push(action);
            if (action === "launch")
              return Response.json({ sandbox: { id: row.id, provider: "modal" }, promptId: "unexpected-prompt" });
            if (action === "stop") return Response.json({ id: JSON.parse(String(init.body)).id, status: "stopped" });
            if (action === "status")
              return Response.json({
                id: JSON.parse(String(init.body)).id,
                status: "stopped",
                providerState: "stopped",
              });
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

test.each([1, 32])("child deletion follows parent deletion with a batch limit of %s", async (limit) => {
  const child = {
    ...row,
    id: "33333333-3333-3333-3333-333333333333",
    requestKey: "smoke-scoped-11111111-1111-1111-1111-111111111111",
  };
  const calls: string[] = [];
  const remaining = await deleteSmokeReceipts(
    STAGING_ORIGIN,
    "token",
    [child, row, { ...row }],
    {
      out: () => {},
      fetch: async (url) => {
        const id = new URL(url).pathname.split("/").at(-1)!;
        calls.push(id);
        return Response.json({ id, status: "deleted" });
      },
    },
    { limit },
  );
  expect(remaining).toEqual(limit === 1 ? [child] : []);
  expect(calls).toEqual(limit === 1 ? [row.id] : [row.id, child.id]);
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
    let clock = 0;
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
            now: () => clock,
            sleep: async (ms) => {
              clock += ms;
            },
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
              if (route === "sandbox/list") return Response.json({ sandboxes: [] });
              if (route === "templates/delete" || route === "variables/delete")
                return Response.json({ item: { status: "deleted" } });
              throw Error(`unexpected route ${route}`);
            },
          },
        ),
      ).toBe(false);
      expect(routes).toContain("templates/launch");
      expect(routes.some((route) => route !== "sandbox/list" && /^sandboxes?\//.test(route))).toBe(false);
      const retained = await readSmokeJournal(path);
      expect(retained).toHaveLength(1);
      expect(retained[0]?.id).toBe(row.id);
      expect(retained[0]?.provider).toBe(provider === "boat" ? "boat" : undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("a staging run stops historical receipts once before deleting and never sweeps settled IDs again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smoke-missing-history-"));
  const path = join(directory, "journal.json");
  const historical = [
    { ...row, provider: "modal" as const },
    { ...row, id: "33333333-3333-3333-3333-333333333333", provider: "modal" as const },
  ];
  const deferred = { ...row, id: "44444444-4444-4444-4444-444444444444", provider: "boat" as const };
  const stopped = new Set<string>();
  const deleted: string[] = [];
  try {
    await saveSmokeJournal(path, [...historical, deferred]);
    for (let run = 0; run < 2; run++) {
      const output: Record<string, unknown>[] = [];
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
          out: (line) => {
            if (line.startsWith("{")) output.push(JSON.parse(line));
          },
          fetch: async (url, init) => {
            if (url.endsWith("/stop")) {
              const { id } = JSON.parse(String(init.body));
              expect(stopped.has(id)).toBe(false);
              stopped.add(id);
              return Response.json({ id, status: "stopped" });
            }
            if (init.method === "DELETE") {
              const id = new URL(url).pathname.split("/").at(-1)!;
              expect(stopped.has(id)).toBe(true);
              deleted.push(id);
              return Response.json({ id, status: "deleted" });
            }
            expect(url.endsWith("/launch")).toBe(true);
            return Response.json({ error: { code: "invalid_request" } }, { status: 400 });
          },
        },
      );
      expect(passed).toBe(false); // A functional failure must not be hidden by successful cleanup.
      expect(await readSmokeJournal(path)).toEqual([deferred]);
      expect(output.find((item) => item.step === "smoke_cleanup_summary")).toMatchObject({
        pass: true,
        remainingRows: 0,
        deferredRows: 1,
      });
      expect(deleted.toSorted()).toEqual(historical.map((item) => item.id).toSorted());
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
