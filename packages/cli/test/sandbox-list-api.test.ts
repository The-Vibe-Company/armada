import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

// Exact published #680 DTO: terminal presentation must need no interior enrichment.
const row = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "org",
  ownerId: "teammate",
  provider: "modal",
  providerSandboxId: null,
  boatId: null,
  harness: "codex",
  model: null,
  reasoningEffort: null,
  status: "running",
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
    provider: "boat",
    providerSandboxId: "bx_display",
    boatId: "bx_display",
    canOpen: true,
    canManage: true,
  };
  const unknown = { ...row, canOpen: undefined, canManage: undefined };
  for (const mode of ["text", "json", "page-info"]) {
    let out = "";
    const paths: string[] = [];
    const code = await run(
      ["list", ...(mode === "json" ? ["--json"] : mode === "page-info" ? ["--page-info"] : [])],
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
          fetch: async (input) => {
            paths.push(new URL(String(input)).pathname);
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
    expect(paths).toEqual(["/api/v1/sandbox/list"]);
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
      expect(out).toContain("Modal  —  running  2h  teammate  metadata only");
      expect(out).toContain(row.id);
      expect(out).toContain("UNKNOWN (server reauthorizes)");
      expect(out).toContain("Boat  bx_display  running  2h  teammate  open/manage");
    }
  }
});
