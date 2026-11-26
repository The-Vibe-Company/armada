import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const row = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "org",
  ownerId: "teammate",
  provider: "modal",
  providerSandboxId: null,
  harness: "codex",
  model: null,
  reasoningEffort: null,
  status: "running",
  taskOutcome: null,
  createdAt: "2026-11-09T12:00:00.000Z",
  stoppedAt: null,
  expiresAt: null,
  effectiveTtlSeconds: null,
  machineSize: null,
  displayLabel: "Sandbox 11111111",
  canOpen: false,
  canManage: false,
};

test("safe sandbox list renders metadata-only access without interior lookups and preserves JSON", async () => {
  const boat = {
    ...row,
    id: "22222222-2222-4222-8222-222222222222",
    status: "stopped",
    idlePaused: true,
    expiresAt: "2026-11-09T15:00:00.000Z",
    provider: "boat",
    providerSandboxId: "bx_display",
    taskOutcome: { state: "ready", prNumber: 42 },
    canOpen: true,
    canManage: true,
  };
  const unknown = { ...row, canOpen: undefined, canManage: undefined };
  for (const mode of ["text", "json", "page-info"]) {
    let out = "";
    const requests: { path: string; body: unknown }[] = [];
    const filters = mode === "json" ? ["--status", "running", "--ref", "job/42"] : [];
    const code = await run(
      ["ls", ...filters, ...(mode === "json" ? ["--json"] : mode === "page-info" ? ["--page-info"] : [])],
      {
        out: (text) => {
          out += text;
        },
        err: () => undefined,
      },
      {
        auth: {
          out: (text) => {
            out += text;
          },
          err: () => undefined,
          env: { ARMADA_TOKEN: "fixture-session" },
          fetch: async (input, init) => {
            requests.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
            return Response.json({
              sandboxes: [row, boat, unknown],
              total: 1,
              page: 1,
              limit: 25,
              hasMore: false,
              nextPage: null,
            });
          },
          now: () => new Date("2026-11-09T14:00:00.000Z"),
          open: () => undefined,
          session: memorySessionStore(),
        },
      },
    );
    expect(code).toBe(0);
    expect(requests).toEqual([
      { path: "/api/v1/sandbox/list", body: mode === "json" ? { status: ["running"], externalRef: "job/42" } : {} },
    ]);
    if (mode === "json")
      expect(JSON.parse(out)).toEqual({ sandboxes: [row, boat, JSON.parse(JSON.stringify(unknown))] });
    else if (mode === "page-info")
      expect(JSON.parse(out)).toMatchObject({
        sandboxes: [row, boat, JSON.parse(JSON.stringify(unknown))],
        total: 1,
        page: 1,
        hasMore: false,
      });
    else {
      expect(out).toContain("Modal  —  running  —  2h  —  teammate  metadata only");
      expect(out).toContain(row.id);
      expect(out).toContain("UNKNOWN (server reauthorizes)");
      expect(out).toContain(
        "Boat  bx_display  Paused — wakes on your next message  ready  2h  —  teammate  open/manage",
      );
    }
  }
});

test("invalid sandbox list pages and metadata exit 1 as operational failures", async () => {
  for (const body of [{ sandboxes: null }, { sandboxes: [{ id: 123 }] }]) {
    let err = "";
    const code = await run(
      ["ls"],
      { out: () => {}, err: (text) => (err += text) },
      {
        auth: {
          out: () => {},
          err: (text) => (err += text),
          env: { ARMADA_TOKEN: "fixture-session" },
          fetch: async () => Response.json(body),
          now: () => new Date(0),
          open: () => {},
          session: memorySessionStore(),
        },
      },
    );
    expect(code).toBe(1);
    expect(err).toMatch(/invalid/i);
  }
});
