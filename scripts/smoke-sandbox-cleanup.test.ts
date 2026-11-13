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
          expect(JSON.parse(String(init.body))).toEqual({ org: row.org, id: row.id });
          return Response.json(success ? { id: row.id, status: "deleted" } : { error: { code: "conflict" } }, {
            status: success ? 200 : 409,
          });
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
              provider: "boat",
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
            const action = url.split("/").at(-1)!;
            calls.push(action);
            if (action === "launch") return Response.json({ sandbox: { id: row.id, provider: "wrong" } });
            if (action === "stop") return Response.json({ status: "stopped" });
            if (action === "status") return Response.json({ status: "stopped", providerState: "archived" });
            if (action === "delete") {
              const id = JSON.parse(String(init.body)).id;
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
