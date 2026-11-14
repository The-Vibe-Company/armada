/** Coordinator-only scheduled execution proof; helper for the single --parity entrypoint. */
export interface RoutineProbeCase {
  provider: "boat" | "modal" | "docker";
  harness: string;
  model: string;
  modelAccountId: string;
  hostId?: string;
  golden?: string;
  template: { id: string; revision: number };
}
export interface RoutineProbeIo {
  now(): number;
  deadline: number;
  request<T>(path: string, body: object, until: number): Promise<T>;
  poll<T>(read: () => Promise<T>, done: (value: T) => boolean, attempts: number, until: number): Promise<T>;
  claim(id: string): Promise<void>;
  out(line: string): void;
}
export class RoutineProbeError extends Error {
  constructor(
    readonly code:
      | "invalid_routine_receipt"
      | "routine_occurrence_failed"
      | "routine_due_outside_budget"
      | "routine_cleanup_unconfirmed",
  ) {
    super(code);
  }
}
const uuid = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
function fail(): never {
  throw new RoutineProbeError("invalid_routine_receipt");
}

type Routine = {
  id: string;
  name: string;
  version: number;
  scope: string;
  status: string;
  templateId: string;
  templateRevision: number;
  prompt: string;
  cron: string;
  timezone: string;
  maxRunsPerDay: number;
  ttlSeconds: number;
  nextDueAt: string | null;
};
type Occurrence = {
  id: string;
  state: string;
  sandboxId: string | null;
  configurationVersion: number;
  scheduledDueAt: string;
  templateRequestId: string | null;
  reason: string | null;
};

export async function probeRoutine(
  item: RoutineProbeCase,
  io: RoutineProbeIo,
): Promise<{ id: string; provider: RoutineProbeCase["provider"] }> {
  const until = Math.min(io.deadline, io.now() + 110_000);
  const name = `parity-routine-${crypto.randomUUID()}`;
  const marker = `ROUTINE_${crypto.randomUUID().replaceAll("-", "")}`;
  const prompt = `Reply with exactly ${marker} and nothing else. Do not use tools or modify files.`;
  // Hourly frequency, first due 15-75 seconds ahead. No scheduler/test override.
  const cron = `${new Date(io.now() + 75_000).getUTCMinutes()} * * * *`;
  let routine: Routine | undefined;
  let attempted = false;
  const request = <T>(path: string, body: object, end = until) => io.request<T>(path, body, end);
  const owned = (r: Routine | undefined): Routine => {
    if (
      !r ||
      !uuid(r.id) ||
      r.name !== name ||
      r.scope !== "personal" ||
      !positive(r.version) ||
      r.templateId !== item.template.id ||
      r.templateRevision !== item.template.revision ||
      r.prompt !== prompt ||
      r.cron !== cron ||
      r.timezone !== "UTC" ||
      r.maxRunsPerDay !== 1 ||
      r.ttlSeconds !== 900
    )
      fail();
    return r;
  };
  async function history(end: number) {
    if (!routine) return fail();
    const result = await request<{ items: Occurrence[] }>("routines/history", { id: routine.id }, end);
    if (!Array.isArray(result?.items)) fail();
    let malformed = false,
      claimFailed = false;
    let claimError: unknown;
    // Adopt all individually attributable allocations before rejecting any row.
    for (const occurrence of result.items) {
      if (!occurrence || typeof occurrence !== "object") {
        malformed = true;
        continue;
      }
      if (occurrence.sandboxId !== null) {
        if (!uuid(occurrence.sandboxId)) {
          malformed = true;
          continue;
        }
        try {
          await io.claim(occurrence.sandboxId);
        } catch (error) {
          claimFailed = true;
          claimError ??= error;
        }
      }
    }
    if (claimFailed) throw claimError;
    if (malformed) fail();
    for (const occurrence of result.items) {
      if (
        !uuid(occurrence.id) ||
        !["admitted", "reconciling", "succeeded", "failed", "skipped"].includes(occurrence.state) ||
        (occurrence.state === "succeeded" && occurrence.sandboxId === null)
      )
        fail();
    }
    return result.items;
  }
  const work = async () => {
    const source = await request<{
      revision: {
        revision: number;
        definition: {
          provider: string;
          harness: string;
          model: string;
          hostId?: string;
          goldenId?: string | null;
          modelAccount?: { id: string };
        };
      };
    }>("templates/get", item.template);
    const definition = source?.revision?.definition;
    if (
      source?.revision?.revision !== item.template.revision ||
      !definition ||
      definition.provider !== item.provider ||
      definition.harness !== item.harness ||
      definition.model !== item.model ||
      (definition.modelAccount && definition.modelAccount.id !== item.modelAccountId) ||
      (item.provider === "docker" && definition.hostId !== item.hostId)
    )
      fail();
    let goldenName: string | undefined;
    if (item.provider !== "docker") {
      const listed = await request<{ goldens: Array<{ id: string; name: string; provider: string }> }>(
        "golden/list",
        {},
      );
      if (!Array.isArray(listed?.goldens)) fail();
      const matches = listed.goldens.filter(
        (golden) =>
          golden.provider === item.provider &&
          golden.id === definition.goldenId &&
          (golden.id === item.golden || golden.name === item.golden),
      );
      if (matches.length !== 1 || !matches[0]?.name) fail();
      goldenName = matches[0].name;
    }
    attempted = true;
    routine = owned(
      (
        await request<{ item: Routine }>("routines/create", {
          name,
          scope: "personal",
          templateId: item.template.id,
          templateRevision: item.template.revision,
          prompt,
          cron,
          timezone: "UTC",
          maxRunsPerDay: 1,
          ttlSeconds: 900,
        })
      ).item,
    );
    if (routine.status !== "paused") fail();
    routine = owned(
      (await request<{ item: Routine }>("routines/enable", { id: routine.id, expectedVersion: routine.version })).item,
    );
    const due = Date.parse(routine.nextDueAt ?? "");
    if (
      routine.status !== "enabled" ||
      !Number.isFinite(due) ||
      new Date(due).getUTCMinutes() !== Number(cron.split(" ")[0]) ||
      new Date(due).getUTCSeconds() !== 0
    )
      fail();
    if (due < io.now() || due >= until) throw new RoutineProbeError("routine_due_outside_budget");
    const version = routine.version;
    const occurrence = await io.poll(
      () => history(until),
      (rows) => {
        if (rows.length > 1) fail();
        const run = rows[0];
        if (!run) return false;
        if (run.configurationVersion !== version || Date.parse(run.scheduledDueAt) !== due || io.now() < due) fail();
        if (["failed", "skipped"].includes(run.state)) throw new RoutineProbeError("routine_occurrence_failed");
        return run.state === "succeeded";
      },
      110,
      until,
    );
    const run = occurrence[0];
    if (!run || !uuid(run.sandboxId) || !uuid(run.templateRequestId) || run.reason !== null) fail();
    const state = await request<{
      id: string;
      provider?: string;
      harness: string;
      model: string;
      hostId?: string;
      golden: string | null;
      billingAccount?: { id: string };
    }>("sandbox/detail", { id: run.sandboxId });
    if (
      !state ||
      state.id !== run.sandboxId ||
      (state.provider !== undefined && state.provider !== item.provider) ||
      state.harness !== item.harness ||
      state.model !== item.model ||
      state.billingAccount?.id !== item.modelAccountId ||
      (item.provider === "docker" ? state.hostId !== item.hostId : state.golden !== goldenName)
    )
      fail();
    const instructed = new Set<string>(),
      answered = new Set<string>(),
      finished = new Set<string>(),
      failedPrompts = new Set<string>();
    let cursor: string | undefined;
    await io.poll(
      () =>
        request<{
          cursor?: string;
          events: Array<{
            kind: string;
            promptId?: string;
            status?: string;
            text?: string;
            partial?: boolean;
            parentToolUseId?: string;
            responseKind?: string;
            retracted?: boolean;
          }>;
        }>("logs/read", {
          id: run.sandboxId,
          coalesce: true,
          ...(cursor ? { cursor } : {}),
        }),
      (page) => {
        if (!Array.isArray(page?.events)) fail();
        cursor = page.cursor;
        for (const event of page.events) {
          if (!event.promptId) continue;
          if (event.kind === "prompt" && event.text === prompt) instructed.add(event.promptId);
          if (event.kind === "prompt" && ["failed", "interrupted"].includes(event.status ?? ""))
            failedPrompts.add(event.promptId);
          if (event.kind === "prompt" && event.status === "finished") finished.add(event.promptId);
          if (
            event.kind === "message" &&
            event.text === marker &&
            event.partial === false &&
            !event.parentToolUseId &&
            event.responseKind !== "tool_result" &&
            !event.retracted
          )
            answered.add(event.promptId);
        }
        if ([...instructed].some((id) => failedPrompts.has(id)))
          throw new RoutineProbeError("routine_occurrence_failed");
        return [...instructed].some((id) => answered.has(id) && finished.has(id));
      },
      110,
      until,
    );
    return { id: run.sandboxId, provider: item.provider };
  };
  let outcome: { id: string; provider: RoutineProbeCase["provider"] } | undefined;
  let failure: unknown;
  let failed = false;
  try {
    outcome = await work();
  } catch (error) {
    failed = true;
    failure = error;
  }
  {
    const end = io.now() + 300_000;
    let clean = true;
    try {
      if (attempted && !routine) {
        const listed = await request<{ items: Routine[] }>("routines/list", {}, end);
        if (!Array.isArray(listed?.items)) fail();
        const found = listed.items.filter((r) => r.name === name);
        if (found.length !== 1) fail();
        routine = owned(found[0]);
      }
      if (routine) {
        routine = owned((await request<{ item: Routine }>("routines/get", { id: routine.id }, end)).item);
        if (!["paused", "enabled"].includes(routine.status)) fail();
        const deleted = await request<{ item: Routine }>(
          "routines/delete",
          { id: routine.id, expectedVersion: routine.version },
          end,
        );
        if (deleted.item?.id !== routine.id || deleted.item.status !== "deleted") fail();
      }
    } catch {
      clean = false;
    }
    // History remains authorized after tombstoning. Adopt late admitted allocations too.
    if (routine)
      try {
        await io.poll(
          () => history(end),
          (rows) => {
            if (rows.length > 1) fail();
            return !rows.some((r) => r.state === "admitted" || r.state === "reconciling");
          },
          300,
          end,
        );
      } catch {
        clean = false;
      }
    io.out(JSON.stringify({ step: "parity_routine_cleanup", pass: clean, routineId: routine?.id ?? null, name }));
    if (!clean) throw new RoutineProbeError("routine_cleanup_unconfirmed");
  }
  if (failed) throw failure;
  if (!outcome) return fail();
  return outcome;
}
