import { expect, test } from "bun:test";
import { probeRoutine, type RoutineProbeIo } from "./provider-parity-routine.ts";

const templateId = "10000000-0000-4000-8000-000000000001";
const routineId = "20000000-0000-4000-8000-000000000001";
const sandboxId = "30000000-0000-4000-8000-000000000001";
const secondId = "30000000-0000-4000-8000-000000000002";
const runId = "40000000-0000-4000-8000-000000000001";
const requestId = "50000000-0000-4000-8000-000000000001";
type Row = Record<string, unknown>;
function fixture(mode: string, provider: "modal" | "docker" | "boat" = "modal") {
  let clock = Date.parse("2026-11-14T08:59:20Z");
  let due = Number.POSITIVE_INFINITY;
  let routine: Row | undefined;
  let cleanupReads = 0;
  const calls: Array<{ path: string; body: Row }> = [];
  const claims = new Set<string>();
  const output: string[] = [];
  const item = {
    provider,
    harness: "codex",
    model: "gpt-test",
    modelAccountId: "account",
    hostId: "host",
    golden: "golden",
    template: { id: templateId, revision: 2 },
  };
  const io: RoutineProbeIo = {
    now: () => clock,
    deadline: clock + 300_000,
    claim: async (id) => {
      claims.add(id);
    },
    out: (line) => output.push(line),
    poll: async (read, done, attempts, until) => {
      for (let n = 0; n < attempts && clock < until; n++) {
        const result = await read();
        if (done(result)) return result;
        clock += Math.min(1000, until - clock);
      }
      throw new Error("poll exhausted");
    },
    request: async <T>(path: string, input: object, until: number): Promise<T> => {
      expect(until).toBeGreaterThanOrEqual(clock);
      const body = input as Row;
      calls.push({ path, body });
      let result: unknown;
      switch (path) {
        case "templates/get":
          expect(body).toEqual(item.template);
          result = {
            revision: {
              revision: 2,
              definition: {
                provider,
                harness: "codex",
                model: "gpt-test",
                hostId: "host",
                goldenId: mode === "source_golden" ? "wrong" : "70000000-0000-4000-8000-000000000001",
                modelAccount: { id: mode === "source_account" ? "wrong" : "account" },
              },
            },
          };
          break;
        case "golden/list":
          result = { goldens: [{ id: "70000000-0000-4000-8000-000000000001", name: "golden", provider }] };
          break;
        case "routines/create":
          expect(body.cron).toBe("0 * * * *"); // Next minute crosses the UTC hour.
          expect(body).toMatchObject({
            scope: "personal",
            templateId,
            templateRevision: 2,
            timezone: "UTC",
            maxRunsPerDay: 1,
            ttlSeconds: 900,
          });
          routine = { ...body, id: routineId, version: 1, status: "paused", nextDueAt: null };
          if (mode === "create_lost") throw new Error("sensitive transport details");
          result = { item: routine };
          break;
        case "routines/list":
          result = { items: routine ? [routine] : [] };
          break;
        case "routines/get":
          result = { item: routine };
          break;
        case "routines/enable": {
          expect(body).toEqual({ id: routineId, expectedVersion: 1 });
          due = Date.parse("2026-11-14T09:00:00Z") + (mode === "window" ? 3600_000 : 0);
          routine = { ...routine, status: "enabled", version: 2, nextDueAt: new Date(due).toISOString() };
          if (mode === "enable_lost") throw new Error("sensitive transport details");
          result = { item: routine };
          break;
        }
        case "routines/delete":
          expect(body.id).toBe(routineId);
          expect(body.expectedVersion).toBe(routine?.version);
          routine = { ...routine, status: "deleted", version: Number(routine?.version) + 1, nextDueAt: null };
          if (mode === "delete_lost") throw new Error("sensitive transport details");
          result = { item: routine };
          break;
        case "routines/history": {
          expect(body.id).toBe(routineId);
          const deleting = routine?.status === "deleted";
          if (deleting) cleanupReads++;
          if ((clock < due && mode !== "early") || !Number.isFinite(due)) result = { items: [] };
          else {
            const state =
              mode === "failed"
                ? "failed"
                : mode === "late_claim"
                  ? deleting
                    ? cleanupReads > 1
                      ? "succeeded"
                      : "reconciling"
                    : "admitted"
                  : "succeeded";
            const row = {
              id: runId,
              state,
              sandboxId: mode === "null_success" || (mode === "late_claim" && !deleting) ? null : sandboxId,
              configurationVersion: mode === "version" ? 999 : 2,
              scheduledDueAt: new Date(due).toISOString(),
              templateRequestId: requestId,
              reason: null,
            };
            result = {
              items:
                mode === "multiple" || mode === "malformed_history"
                  ? [
                      { ...row, state: mode === "malformed_history" ? "invalid" : row.state },
                      { ...row, id: requestId, sandboxId: secondId },
                    ]
                  : [row],
            };
          }
          break;
        }
        case "sandbox/detail":
          expect(body.id).toBe(sandboxId);
          result = {
            id: sandboxId,
            provider,
            harness: "codex",
            model: "gpt-test",
            hostId: "host",
            golden: "golden",
            billingAccount: { id: mode === "runtime_account" ? "wrong" : "account" },
          };
          break;
        case "logs/read": {
          const prompt = String(routine?.prompt);
          const marker = prompt.match(/ROUTINE_[a-z0-9]+/)?.[0];
          result = {
            events: [
              ...(mode === "unrelated_failure"
                ? [{ kind: "prompt", promptId: "old", text: "unrelated", status: "failed" }]
                : []),
              {
                kind: "prompt",
                promptId: "initial",
                text: mode === "wrong_prompt" ? "unrelated" : prompt,
                status: mode === "initial_failed" ? "failed" : "finished",
              },
              {
                kind: "message",
                promptId: "initial",
                text: marker,
                partial: false,
                responseKind: mode === "echo" ? "tool_result" : "assistant",
              },
            ],
          };
          break;
        }
        default:
          throw new Error(`Unexpected route ${path}`);
      }
      return structuredClone(result) as T;
    },
  };
  return { item, io, calls, claims, output, status: () => routine?.status };
}

// This boundary owns routine scheduling/answer/cleanup proof, not scheduler implementation.
test.each(["modal", "docker", "boat"] as const)(
  "proves a new scheduled initial turn on %s and tombstones only its routine",
  async (provider) => {
    const f = fixture("success", provider);
    expect(await probeRoutine(f.item, f.io)).toEqual({ id: sandboxId, provider });
    expect(f.status()).toBe("deleted");
    expect([...f.claims]).toEqual([sandboxId]);
    expect(f.calls.filter((c) => c.path === "routines/create")).toHaveLength(1);
    expect(f.calls.filter((c) => c.path === "routines/enable")).toHaveLength(1);
    expect(f.calls.some((c) => c.path === "sandbox/send" || c.path === "templates/launch")).toBe(false);
    expect(JSON.parse(f.output[0] ?? "{}")).toMatchObject({ pass: true, routineId });
  },
);

test.each([
  "source_account",
  "source_golden",
  "null_success",
  "malformed_history",
  "version",
  "early",
  "failed",
  "initial_failed",
  "runtime_account",
  "wrong_prompt",
  "echo",
  "window",
  "create_lost",
  "enable_lost",
  "delete_lost",
  "late_claim",
  "multiple",
])("cannot pass false routine evidence and retains cleanup claims: %s", async (mode) => {
  const f = fixture(mode);
  const expected = ["create_lost", "enable_lost"].includes(mode)
    ? "sensitive transport details"
    : ["delete_lost", "multiple", "null_success", "malformed_history"].includes(mode)
      ? "routine_cleanup_unconfirmed"
      : mode === "window"
        ? "routine_due_outside_budget"
        : ["failed", "initial_failed"].includes(mode)
          ? "routine_occurrence_failed"
          : ["echo", "wrong_prompt", "late_claim"].includes(mode)
            ? "poll exhausted"
            : "invalid_routine_receipt";
  await expect(probeRoutine(f.item, f.io)).rejects.toThrow(expected);
  expect(f.status()).toBe(["source_account", "source_golden"].includes(mode) ? undefined : "deleted");
  if (["source_account", "source_golden", "null_success", "window", "create_lost", "enable_lost"].includes(mode))
    expect(f.claims.size).toBe(0);
  else expect(f.claims.has(sandboxId)).toBe(true);
  if (mode === "multiple" || mode === "malformed_history") expect(f.claims.has(secondId)).toBe(true);
  expect(f.output.join("\n")).not.toContain("sensitive");
  expect(JSON.parse(f.output[0] ?? "{}").pass).toBe(
    !["delete_lost", "multiple", "null_success", "malformed_history"].includes(mode),
  );
});

test("native golden UUID configuration resolves to its authorized name without weakening placement", async () => {
  const f = fixture("success");
  f.item.golden = "70000000-0000-4000-8000-000000000001";
  expect(await probeRoutine(f.item, f.io)).toEqual({ id: sandboxId, provider: "modal" });
  expect(f.status()).toBe("deleted");
});

test("unrelated historical prompt failure is not the scheduled initial turn outcome", async () => {
  const f = fixture("unrelated_failure");
  expect(await probeRoutine(f.item, f.io)).toEqual({ id: sandboxId, provider: "modal" });
  expect(f.status()).toBe("deleted");
});
