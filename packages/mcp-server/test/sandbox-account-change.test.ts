import { expect, test } from "bun:test";
import type { Harness, HarnessCredentials, Sql } from "@armada/core";
import { createSandboxAccountChange } from "../src/sandbox-account-change.ts";

function fixture(status = "stopped", provider = "boat") {
  const user = crypto.randomUUID(),
    org = crypto.randomUUID(),
    id = crypto.randomUUID();
  const old = crypto.randomUUID(),
    selected = crypto.randomUUID();
  const row = {
    id,
    owner_id: user,
    org_id: org,
    provider,
    harness: "codex" as Harness,
    runtime_transport: "dialout",
    boat_runtime: provider === "boat",
    model: "gpt-test",
    status,
    deleted_at: null,
    stopped_at: status === "stopped" ? "2026-11-13" : null,
    leased: false,
    credential_id: old,
    credential_version: 1,
  };
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  let stops = 0;
  let strictStop = false;
  const sql: Sql = {
    query: async (query, values = []) => {
      if (query.startsWith("update")) {
        writes.push({ sql: query, values: [...values] });
        return { rows: [{ id }] } as never;
      }
      if (query.includes("native_drain_stop_requests")) return { rows: strictStop ? [{ id }] : [] } as never;
      if (query.includes("from public.sandboxes s")) return { rows: [{ ...row }] } as never;
      return { rows: [{ id: selected }] } as never;
    },
    transaction: async (work) => work(sql),
  };
  const credentials = {
    resolve: async (): Promise<HarnessCredentials> => ({
      binding: { credentialId: selected, credentialVersion: 2 },
      env: {},
      secrets: [],
      codexAuthJson: true,
    }),
  };
  const caller = { via: "supabase" as const, userId: user, orgs: [{ orgId: org, role: "member" as const }] };
  const bind = createSandboxAccountChange(sql, credentials);
  const quiesce = async () => {
    stops++;
    row.status = "stopped";
    row.stopped_at = "2026-11-13";
  };
  const markStrictStop = () => {
    strictStop = true;
  };
  return { row, writes, caller, bind, selected, quiesce, markStrictStop, stopped: () => stops };
}

test("owner account changes quiesce live compute before replacing stopped pins", async () => {
  for (const status of ["ready", "running", "stopped"]) {
    const f = fixture(status);
    const result = await f.bind(f.caller, { id: f.row.id, credentialId: f.selected }, f.quiesce);
    expect(result).toMatchObject({ credentialId: f.selected, credentialVersion: 2, status: "bound" });
    expect(f.stopped()).toBe(status === "stopped" ? 0 : 1);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.values).toEqual([f.row.id, f.selected, 2]);
  }
});

test("busy, leased and unauthorized sandboxes never stop compute or replace an account", async () => {
  for (const mode of ["running", "starting", "leased", "other-owner", "wrong-org"]) {
    const f = fixture();
    if (mode === "running" || mode === "starting") f.row.status = mode;
    if (mode === "running") f.row.boat_runtime = false;
    if (mode === "leased") f.row.leased = true;
    if (mode === "other-owner") f.row.owner_id = crypto.randomUUID();
    await expect(
      f.bind(
        f.caller,
        { id: f.row.id, credentialId: f.selected, ...(mode === "wrong-org" ? { org: crypto.randomUUID() } : {}) },
        f.quiesce,
      ),
    ).rejects.toMatchObject({
      code: mode === "other-owner" ? "not_found" : mode === "wrong-org" ? "forbidden" : "credential_binding_unsafe",
    });
    expect(f.stopped()).toBe(0);
    expect(f.writes).toHaveLength(0);
  }
});

test("a concurrent binding winner is not overwritten after stopping", async () => {
  const f = fixture("ready");
  await expect(
    f.bind(f.caller, { id: f.row.id, credentialId: f.selected }, async () => {
      await f.quiesce();
      f.row.credential_id = crypto.randomUUID();
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(f.writes).toHaveLength(0);
});

test("an account change rechecks strict-stop ownership after quiescing", async () => {
  const f = fixture("ready");
  await expect(
    f.bind(f.caller, { id: f.row.id, credentialId: f.selected }, async () => {
      await f.quiesce();
      f.markStrictStop();
    }),
  ).rejects.toMatchObject({ code: "conflict", message: "Native sandbox preservation is pending." });
  expect(f.writes).toHaveLength(0);
});

test("native Boat cannot falsely report an account switch without refreshing its retained environment", async () => {
  const f = fixture();
  f.row.boat_runtime = false;
  await expect(f.bind(f.caller, { id: f.row.id, credentialId: f.selected }, f.quiesce)).rejects.toMatchObject({
    code: "credential_binding_unsupported",
  });
  expect(f.stopped()).toBe(0);
  expect(f.writes).toHaveLength(0);
});

test("Modal dialout refreshes through the runtime pin without requiring native harness policy rows", async () => {
  const f = fixture("stopped", "modal");
  await f.bind(f.caller, { id: f.row.id, credentialId: f.selected }, f.quiesce);
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]?.values).toEqual([f.row.id, f.selected, 2]);
});

test("an incompatible OpenCode plan key is refused before stopping a custom-connection conversation", async () => {
  const f = fixture("ready", "docker");
  f.row.harness = "opencode";
  f.row.model = "armada/deepseek-flash";
  await expect(f.bind(f.caller, { id: f.row.id, credentialId: f.selected }, f.quiesce)).rejects.toMatchObject({
    code: "credential_refused",
  });
  expect(f.stopped()).toBe(0);
  expect(f.writes).toHaveLength(0);
});

test("a missing provider receipt is a state refusal, not a hidden sandbox error after ownership is established", async () => {
  const f = fixture("ready");
  await expect(
    f.bind(f.caller, { id: f.row.id, credentialId: f.selected }, async () => {
      throw Object.assign(new Error("synthetic private provider detail"), { code: "not_found" });
    }),
  ).rejects.toMatchObject({
    code: "credential_binding_unsafe",
    message: expect.stringContaining("account is unchanged"),
  });
  expect(f.writes).toHaveLength(0);
});
