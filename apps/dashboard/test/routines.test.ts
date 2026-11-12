import { expect, test } from "bun:test";
import { createRoutineControl } from "../src/lib/control.ts";
import {
  canManageRoutine,
  parseRoutine,
  parseRoutineRun,
  routineFailure,
  routineRequest,
  runDescription,
  scheduleLabel,
} from "../src/lib/routines.ts";

const ORG = "00000000-0000-4000-8000-000000000010",
  USER = "00000000-0000-4000-8000-000000000001",
  ID = "00000000-0000-4000-8000-000000002200",
  TEMPLATE = "00000000-0000-4000-8000-000000000090";
const item = {
  id: ID,
  orgId: ORG,
  ownerId: USER,
  scope: "personal",
  name: "Morning review",
  templateId: TEMPLATE,
  templateRevision: 2,
  prompt: "  Inspect\nexact bytes\n",
  intervalHours: 24,
  ttlSeconds: 3600,
  maxRunsPerDay: 24,
  status: "paused",
  version: 1,
  nextDueAt: null,
  consecutiveFailures: 0,
  pauseReason: null,
  createdAt: "2026-11-11T12:00:00.000Z",
  updatedAt: "2026-11-11T12:00:00.000Z",
};
const fields = {
  name: "Morning review",
  scope: "personal",
  template: TEMPLATE,
  revision: "2",
  prompt: "  Inspect\nexact bytes\n",
  interval: "1",
  ttl: "60",
  cap: "2",
};
const templates = [{ id: TEMPLATE, scope: "org" as const, currentRevision: 2 }];

// Form validation owns exact prompt/pin and cost bounds; server integration owns launch authorization.
test("routine form preserves exact prompt, pins its selected revision and validates schedule/reference limits", () => {
  expect(routineRequest(fields, templates)).toEqual({
    ok: true,
    value: {
      name: "Morning review",
      scope: "personal",
      templateId: TEMPLATE,
      templateRevision: 2,
      prompt: fields.prompt,
      intervalHours: 1,
      ttlSeconds: 3600,
      maxRunsPerDay: 2,
    },
  });
  for (const changed of [
    { interval: "0" },
    { interval: "1.5" },
    { interval: "721" },
    { ttl: "4" },
    { ttl: "1441" },
    { cap: "25" },
    { revision: "1" },
    { prompt: " " },
    { prompt: "x".repeat(32001) },
  ])
    expect(routineRequest({ ...fields, ...changed }, templates).ok).toBe(false);
  expect(routineRequest({ ...fields, scope: "org" }, [{ ...templates[0]!, scope: "personal" }])).toEqual({
    ok: false,
    error: "Organization routines require an organization template.",
  });
});

test("routine DTOs reject unsafe links and unknown states, and do not carry raw diagnostics", () => {
  expect(parseRoutine(item)).toMatchObject({ id: ID, prompt: item.prompt, templateRevision: 2 });
  const calendar = {
    ...item,
    intervalHours: null,
    cron: "0 9 * * MON-FRI",
    timezone: "Europe/Paris",
    scheduleDescription: "At 09:00, Monday through Friday, Europe/Paris",
  };
  const parsedCalendar = parseRoutine(calendar);
  expect(parsedCalendar).toMatchObject({ cron: calendar.cron, intervalHours: null });
  expect(parsedCalendar && scheduleLabel(parsedCalendar)).toBe(calendar.scheduleDescription);
  expect(parseRoutine({ ...calendar, timezone: null })).toBeNull();
  expect(parseRoutine({ ...item, intervalHours: 0 })).toBeNull();
  expect(parseRoutine({ ...item, scope: ["org"] })).toBeNull();
  expect(parseRoutine({ ...item, pauseReason: "credential-bearing provider message" })?.pauseReason).toBe("unknown");
  const run = {
    id: ID,
    scheduledDueAt: item.createdAt,
    configurationVersion: 2,
    state: "skipped",
    reason: "previous_run_alive",
    taskState: null,
    sandboxId: null,
    templateRequestId: null,
    missedIntervals: 0,
  };
  const parsed = parseRoutineRun({
    ...run,
    reasonHelp: "raw secret message",
    manifest: { token: "raw secret message" },
  })!;
  expect(runDescription(parsed)).toContain("previous sandbox is still alive");
  expect(parsed).not.toHaveProperty("reasonHelp");
  expect(parsed).not.toHaveProperty("manifest");
  expect(parseRoutineRun({ ...run, sandboxId: "https://unsafe.example" })).toBeNull();
  expect(parseRoutineRun({ ...run, state: "new-unknown-state" })).toBeNull();
  expect(runDescription({ ...parsed, reason: "unknown" })).not.toContain("credential-bearing");
});

test("routine UI management rules do not grant org mutation to a non-admin owner or private access to another admin", () => {
  expect(canManageRoutine({ scope: "personal", ownerId: USER }, { userId: USER, admin: false })).toBe(true);
  expect(canManageRoutine({ scope: "personal", ownerId: USER }, { userId: ID, admin: true })).toBe(false);
  expect(canManageRoutine({ scope: "org", ownerId: USER }, { userId: USER, admin: false })).toBe(false);
  expect(canManageRoutine({ scope: "org", ownerId: USER }, { userId: ID, admin: true })).toBe(true);
});

// Transport contract: exact route/org/version, viewer bearer only, bounded no-store request, no retries/echo.
test("routine control authenticates scoped commands, preserves CAS versions and refuses raw upstream errors", async () => {
  const calls: { path: string; body: unknown; init: RequestInit }[] = [];
  let conflict = false;
  const control = createRoutineControl({
    serverUrl: "https://armada.test/mcp",
    token: "synthetic-viewer-token",
    fetch: Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)), init: init! });
        if (conflict)
          return Response.json(
            { error: { code: "conflict", message: "raw private prompt/token must never appear" } },
            { status: 409 },
          );
        return Response.json(String(input).endsWith("/list") ? { items: [item] } : { item });
      },
      { preconnect: fetch.preconnect },
    ),
  });
  expect(await control.list(ORG)).toHaveLength(1);
  await control.enable({ org: ORG, id: ID, expectedVersion: 7 });
  expect(calls.map((x) => ({ path: x.path, body: x.body }))).toEqual([
    { path: "/api/v1/routines/list", body: { org: ORG } },
    { path: "/api/v1/routines/enable", body: { org: ORG, id: ID, expectedVersion: 7 } },
  ]);
  expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer synthetic-viewer-token");
  expect(calls[0]!.init.cache).toBe("no-store");
  expect(calls[0]!.init.redirect).toBe("error");
  expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  conflict = true;
  await expect(control.pause({ org: ORG, id: ID, expectedVersion: 7 })).rejects.toMatchObject({
    status: 409,
    message: routineFailure(409),
  });
  expect(calls).toHaveLength(3);
});
