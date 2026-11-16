import { expect, test } from "bun:test";
import { mapSandboxRow, type SandboxRow } from "@armada/core";

const fixture: SandboxRow = {
  id: "row",
  provider: "boat",
  provider_sandbox_id: "bx_driver",
  golden_id: "golden",
  org_id: "org",
  owner_id: "owner",
  harness: "claude",
  status: "ready",
  conversation_ids: [],
  created_at: "2026-11-09T00:00:00Z",
  stopped_at: null,
  deleted_at: null,
  status_reason: null,
  model: null,
  reasoning_effort: null,
  repository_dir: null,
  expires_at: "2026-11-10T00:00:00Z",
};
test("SQL row decoding normalizes exact safe lifecycle integers and refuses invalid/lossy values", () => {
  for (const value of [
    1,
    "2",
    3n,
    Number.MAX_SAFE_INTEGER,
    String(Number.MAX_SAFE_INTEGER),
    BigInt(Number.MAX_SAFE_INTEGER),
  ]) {
    const row = mapSandboxRow({ ...fixture, lifecycle_generation: value });
    expect(typeof row.lifecycleGeneration).toBe("number");
    expect(row.lifecycleGeneration).toBe(Number(value));
  }
  for (const value of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "",
    " 2",
    "2.0",
    "2e1",
    "+2",
    "02",
    "0",
    "-1",
    "9007199254740993",
    9007199254740993n,
    null,
    true,
  ])
    expect(() => mapSandboxRow({ ...fixture, lifecycle_generation: value } as SandboxRow)).toThrow(
      "lifecycle generation",
    );
  expect(mapSandboxRow(fixture).lifecycleGeneration).toBe(1);
});
