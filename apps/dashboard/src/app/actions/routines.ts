"use server";

import { revalidatePath } from "next/cache";
import { type ActionResult, done, fail, formString, isUuid } from "@/lib/action";
import { ControlError } from "@/lib/control";
import { viewerRoutines } from "@/lib/data/routines";
import { selectedOrganization } from "@/lib/data/selected-org";
import { viewerTemplates } from "@/lib/data/templates";
import type { RoutineSchedulePreview } from "@/lib/routine-schedule";
import { type RoutineRun, routineFailure, routineRequest } from "@/lib/routines";

async function scoped(data: FormData) {
  const org = formString(data, "org"),
    selected = await selectedOrganization();
  if (!isUuid(org) || selected?.org.id !== org) return null;
  const control = await viewerRoutines();
  return control ? { org, control, admin: selected.role === "admin" } : null;
}
export async function createRoutine(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const context = await scoped(data);
  if (!context) return fail("Select an organization with a configured Armada server first.");
  const scope = formString(data, "scope");
  if (scope === "org" && !context.admin) return fail("Only an admin creates organization routines.");
  const id = formString(data, "template"),
    revision = Number(formString(data, "revision"));
  if (!isUuid(id) || !Number.isSafeInteger(revision) || revision < 1)
    return fail("Choose a template and its published revision.");
  try {
    const templates = await viewerTemplates();
    if (!templates) return fail("Templates are unavailable.");
    const { item } = await templates.get({ org: context.org, id, revision });
    const fields = Object.fromEntries(
      ["name", "scope", "template", "revision", "prompt", "cron", "timezone", "ttl", "cap"].map((key) => [
        key,
        formString(data, key),
      ]),
    );
    // HTML form encoding normalizes textarea line breaks to CRLF. Restore its
    // browser-entered LF text without trimming indentation or trailing whitespace.
    fields.prompt = formString(data, "prompt").replace(/\r\n/g, "\n");
    const parsed = routineRequest(fields, [item]);
    if (!parsed.ok) return fail(parsed.error);
    await context.control.create({ org: context.org, ...parsed.value });
    revalidatePath("/routines");
    return done("Routine created paused. Enable it when you are ready.");
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return fail(routineFailure(error.status));
  }
}
export async function setRoutineState(_previous: ActionResult | null, data: FormData): Promise<ActionResult> {
  const context = await scoped(data);
  if (!context) return fail("Switch to that organization before changing its routine.");
  const id = formString(data, "id"),
    expectedVersion = Number(formString(data, "version")),
    operation = formString(data, "operation");
  if (
    !isUuid(id) ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1 ||
    !["enable", "pause"].includes(operation)
  )
    return fail("That routine request is not valid.");
  try {
    await context.control[operation as "enable" | "pause"]({ org: context.org, id, expectedVersion });
    revalidatePath("/routines");
    return done(
      operation === "enable"
        ? "Routine enabled. It will run at its next scheduled time."
        : "Routine paused. Already admitted runs may still finish.",
    );
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return fail(routineFailure(error.status));
  }
}
export async function routineHistory(
  org: string,
  id: string,
): Promise<{ ok: true; items: RoutineRun[] } | { ok: false; error: string }> {
  if (!isUuid(org) || !isUuid(id) || (await selectedOrganization())?.org.id !== org)
    return { ok: false, error: "Switch to that organization to read its run history." };
  const control = await viewerRoutines();
  if (!control) return { ok: false, error: "Run history is unavailable." };
  try {
    return { ok: true, items: await control.history(org, id) };
  } catch (error) {
    if (!(error instanceof ControlError)) throw error;
    return { ok: false, error: routineFailure(error.status) };
  }
}

export async function previewRoutineSchedule(
  org: string,
  cron: string,
  timezone: string,
): Promise<{ ok: true; preview: RoutineSchedulePreview } | { ok: false; error: string }> {
  if (!isUuid(org) || (await selectedOrganization())?.org.id !== org)
    return { ok: false, error: "Switch to that organization to preview its schedule." };
  if (
    typeof cron !== "string" ||
    !cron.trim() ||
    cron.length > 200 ||
    cron.includes("\0") ||
    typeof timezone !== "string" ||
    !timezone.trim() ||
    timezone.length > 100 ||
    timezone.includes("\0")
  )
    return { ok: false, error: "Choose a cron schedule and an IANA time zone." };
  const control = await viewerRoutines();
  if (!control) return { ok: false, error: "Schedule preview is unavailable. Try again." };
  try {
    return { ok: true, preview: await control.preview({ org, cron, timezone }) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof ControlError && error.status === 400
          ? "Check the five-field cron and IANA time zone. Runs must be at least one hour apart."
          : "Schedule preview is unavailable. Try again.",
    };
  }
}
