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
    provider_sandbox_id: "physical",
    runtime_transport: "dialout",
    boat_runtime: true,
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
  const machine = {
    phase: "stopped",
    golden: false,
    launchUserId: user,
    recoveryImageId: "retained-image",
    info: { state: "stopped", providerState: "stopped", labels: { credentialId: old, credentialVersion: "1" } },
  };
  const sql: Sql = {
    query: async (query, values = []) => {
      if (query.startsWith("update")) {
        writes.push({ sql: query, values: [...values] });
        return { rows: [{ id }] } as never;
      }
      if (query.includes("from public.sandboxes s")) return { rows: [{ ...row }] } as never;
      if (query.includes("from public.modal_machines"))
        return { rows: [{ scope: "scope", owner_id: user, leased: false, record: structuredClone(machine) }] } as never;
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
  const bind = createSandboxAccountChange(sql, credentials, async () => {
    throw Error("legacy must not run");
  });
  const quiesce = async () => {
    stops++;
    row.status = "stopped";
    row.stopped_at = "2026-11-13";
  };
  return { row, writes, caller, bind, selected, quiesce, stopped: () => stops };
}

test("owner account changes quiesce ready compute, replace stopped pins and replace stopped pins", async () => {
  for (const status of ["ready", "stopped"]) {
    const f = fixture(status);
    const result = await f.bind(f.caller, { id: f.row.id, credentialId: f.selected }, f.quiesce);
    expect(result).toMatchObject({ credentialId: f.selected, credentialVersion: 2, status: "bound" });
    expect(f.stopped()).toBe(status === "ready" ? 1 : 0);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.values).toEqual([f.row.id, f.selected, 2]);
  }
});

test("busy, leased and unauthorized sandboxes never stop compute or replace an account", async () => {
  for (const mode of ["running", "starting", "leased", "other-owner", "wrong-org"]) {
    const f = fixture();
    if (mode === "running" || mode === "starting") f.row.status = mode;
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

test("Modal account changes update the retained private pin and labels with the public pin", async () => {
  const f = fixture("stopped", "modal");
  f.row.runtime_transport = "native";
  await f.bind(f.caller, { id: f.row.id, credentialId: f.selected }, f.quiesce);
  expect(f.writes).toHaveLength(3);
  expect(f.writes[0]?.values).toEqual(["scope", "physical", f.selected, 2]);
  const record = JSON.parse(String(f.writes[1]?.values[2]));
  expect(record.info.labels).toEqual({ credentialId: f.selected, credentialVersion: "2" });
  expect(f.writes[2]?.values).toEqual([f.row.id, f.selected, 2]);
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
