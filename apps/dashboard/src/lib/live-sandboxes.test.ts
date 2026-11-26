import { expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { createControlClient } from "./control";
import { readRecordedTurns } from "./data/sandbox-inventory";
import { liveSandboxLook } from "./live-sandbox-view";
import { queryLiveSandboxes } from "./live-sandboxes";
import type { Database } from "./supabase/types";

const now = new Date("2026-11-25T12:00:00Z");
const row = (id: string, status: string, createdAt = "2026-11-25T11:00:00Z", expiresAt = "2026-11-25T13:00:00Z") => ({
  id,
  status,
  expiresAt,
  providerSandboxId: `sb-${id}`,
  displayLabel: `Sandbox ${id}`,
  harness: "codex",
  createdAt,
});
const makeFetch = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  Object.assign(fn, { preconnect: fetch.preconnect });

function fakeSupabase(liveRows: unknown[], stoppedRows: unknown[] = []) {
  return createClient<Database, "public">("https://metadata.test", "placeholder", {
    global: {
      fetch: makeFetch(async (input) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/rest/v1/rpc/sandbox_list_metadata");
        return url.searchParams.get("status") === "eq.stopped"
          ? Response.json(stoppedRows)
          : Response.json(liveRows, {
              headers: { "content-range": `0-${Math.max(0, liveRows.length - 1)}/${liveRows.length}` },
            });
      }),
    },
  });
}

test("queryLiveSandboxes enriches live fleet with sandbox/list-turns, wakes stopped queued sandboxes, and falls back to running", async () => {
  const supabase = fakeSupabase(
    [
      row("ready-working", "ready", "2026-11-25T11:30:00Z"),
      row("ready-idle", "ready", "2026-11-25T11:20:00Z"),
      row("starting-queued", "starting", "2026-11-25T11:10:00Z"),
    ],
    [
      row("stopped-waking", "stopped", "2026-11-25T11:40:00Z", "2026-11-25T12:30:00Z"),
      row("stopped-expired", "stopped", "2026-11-25T11:35:00Z", "2026-11-25T11:50:00Z"),
    ],
  );
  const calls: string[] = [];
  const control = createControlClient({
    serverUrl: "https://armada.test",
    token: "placeholder",
    fetch: makeFetch(async (input, init) => {
      calls.push(new URL(String(input)).pathname);
      expect(JSON.parse(String(init?.body))).toEqual({ org: "org-1" });
      return Response.json({
        "ready-working": "running",
        "ready-idle": "finished",
        "starting-queued": "queued",
        "stopped-waking": "queued",
        "stopped-expired": "queued",
      });
    }),
  });
  expect(await queryLiveSandboxes(supabase, "org-1", control, now)).toEqual({
    total: 4,
    rows: [
      { id: "stopped-waking", label: "sb-stopped-waking", status: "stopped", working: true },
      { id: "ready-working", label: "sb-ready-working", status: "ready", working: true },
      { id: "ready-idle", label: "sb-ready-idle", status: "ready", working: false },
      { id: "starting-queued", label: "sb-starting-queued", status: "starting", working: true },
    ],
  });
  expect(calls).toEqual(["/api/v1/sandbox/list-turns"]);

  const fallbackDb = fakeSupabase([row("running-db", "running"), row("ready-idle", "ready")]);
  const failing = createControlClient({
    serverUrl: "https://armada.test",
    token: "placeholder",
    fetch: makeFetch(async () => new Response("err", { status: 503 })),
  });
  for (const client of [failing, null]) {
    expect((await queryLiveSandboxes(fallbackDb, "org-1", client, now))?.rows.map((r) => [r.id, r.working])).toEqual([
      ["running-db", true],
      ["ready-idle", false],
    ]);
  }
  for (const status of ["ready", "running", "starting", "stopped"] as const) {
    expect(liveSandboxLook({ status, working: true })).toEqual({ tone: "success", pulse: true, label: "Working" });
  }
  expect(liveSandboxLook({ status: "ready", working: false })).toMatchObject({ tone: "warning", pulse: false });
  expect(liveSandboxLook({ status: "running", working: false })).toMatchObject({ tone: "neutral", pulse: false });

  const malformed = createControlClient({
    serverUrl: "https://armada.test",
    token: "placeholder",
    fetch: makeFetch(async () => Response.json({ ok: "running", bad: "unknown", num: 42 })),
  });
  expect(await readRecordedTurns("org-2", malformed)).toEqual({ ok: "running" });
  const nonObject = createControlClient({
    serverUrl: "https://armada.test",
    token: "placeholder",
    fetch: makeFetch(async () => Response.json(["not-a-map"])),
  });
  expect(await readRecordedTurns("org-3", nonObject)).toEqual({});
  expect(await readRecordedTurns("org-3", null)).toEqual({});
});
