import { HARNESSES, MACHINE_SIZES, type MachineSize, type SandboxListMetadata } from "@armada/core";
import { LISTED_PROVIDERS } from "./listed-provider.ts";
import { MACHINE_SIZE_LABELS } from "./machine-size.ts";
import { parseTaskOutcome } from "./outcome.ts";
import { SANDBOX_STATUSES } from "./sandbox-filters.ts";

export { LISTED_PROVIDER_LABELS, LISTED_PROVIDERS, type ListedProvider } from "./listed-provider.ts";

export type ListedSandbox = SandboxListMetadata;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A listed row left out of the page: its id when it is a UUID, and the first contract check it failed. No value. */
export type SkippedSandboxRow = { id: string | null; reason: string };

/**
 * Reads the rows of `public.sandbox_list_metadata()` (#680, `docs/contracts/sandbox-access-v1.md`). Only the
 * contract's allowlisted fields are kept, so an interior field a producer might add never reaches a page. A row that
 * does not match the contract is left out, never guessed, and reported in `skipped` (#1398): one unexpected row must
 * not make the whole organization's list unreadable. A response that is not a list still fails the read.
 */
export function parseSandboxListMetadata(value: unknown): { rows: ListedSandbox[]; skipped: SkippedSandboxRow[] } {
  if (!Array.isArray(value)) throw new Error("The sandbox list did not match its contract.");
  const rows: ListedSandbox[] = [];
  const skipped: SkippedSandboxRow[] = [];
  for (const item of value) {
    const parsed = parseRow(item);
    if (typeof parsed !== "string") rows.push(parsed);
    else {
      const id = item && typeof item === "object" ? (item as Record<string, unknown>).id : undefined;
      skipped.push({ id: typeof id === "string" && UUID.test(id) ? id : null, reason: parsed });
    }
  }
  return { rows, skipped };
}

/** The one line a list says when it left rows out, or null when it showed every row the server listed. */
export function skippedRowsNote(skipped: number): string | null {
  if (skipped <= 0) return null;
  return `${skipped} ${skipped === 1 ? "sandbox" : "sandboxes"} could not be shown.`;
}

/** The row, or the name of the first contract check it failed. */
function parseRow(value: unknown): ListedSandbox | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "not an object";
  const row = value as Record<string, unknown>;
  const { id, orgId, ownerId, provider, harness, status, createdAt, displayLabel, canOpen, canManage } = row;
  const created = instant(createdAt);
  if (!text(id) || !text(orgId) || !text(ownerId) || !created || !text(displayLabel)) return "identity";
  if (!oneOf(LISTED_PROVIDERS, provider)) return "provider";
  if (!oneOf(HARNESSES, harness)) return "harness";
  if (!oneOf(SANDBOX_STATUSES, status)) return "status";
  if (typeof canOpen !== "boolean" || typeof canManage !== "boolean") return "permissions";
  const providerSandboxId = nullable(row.providerSandboxId, text);
  const boatId = nullable(row.boatId, text);
  const model = nullable(row.model, text);
  const reasoningEffort = nullable(row.reasoningEffort, text);
  const stoppedAt = timestamp(row.stoppedAt);
  const expiresAt = timestamp(row.expiresAt);
  const effectiveTtlSeconds = nullable(row.effectiveTtlSeconds, seconds);
  const machineSize = nullable(row.machineSize, size);
  const preservationNote = nullable(row.preservationNote, text);
  if (
    providerSandboxId === undefined ||
    boatId === undefined ||
    model === undefined ||
    reasoningEffort === undefined ||
    stoppedAt === undefined ||
    expiresAt === undefined ||
    effectiveTtlSeconds === undefined ||
    machineSize === undefined ||
    (row.preservationNote !== undefined && preservationNote === undefined)
  )
    return "optional fields";
  return {
    id,
    orgId,
    ownerId,
    provider,
    providerSandboxId,
    boatId,
    harness,
    model,
    reasoningEffort,
    status,
    createdAt: created,
    stoppedAt,
    expiresAt,
    effectiveTtlSeconds,
    machineSize,
    // Null for a viewer who may not open the sandbox; a value the contract does not allow is shown as no outcome.
    taskOutcome: parseTaskOutcome(row.taskOutcome),
    preservationNote: preservationNote ?? null,
    displayLabel,
    canOpen,
    canManage,
  };
}

/** How a listed sandbox is named: its provider's display ID (bx_ on Boat) when there is one, else its logical label. */
export function sandboxName(sandbox: Pick<ListedSandbox, "providerSandboxId" | "displayLabel">): string {
  return sandbox.providerSandboxId ?? sandbox.displayLabel;
}

export function machineSizeLabel(size: MachineSize): string {
  return MACHINE_SIZE_LABELS[size];
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A timestamp as PostgREST sends it (`…+00:00`), as the canonical ISO string; null when it is not a date. */
function instant(value: unknown): string | null {
  if (!text(value)) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** A nullable timestamp: the ISO string, null for an explicit null, undefined when it is missing or not a date. */
function timestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  return instant(value) ?? undefined;
}

function size(value: unknown): value is MachineSize {
  return oneOf(MACHINE_SIZES, value);
}

function seconds(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** The value, null for an explicit null, undefined when it is missing or malformed. */
function nullable<T>(value: unknown, valid: (value: unknown) => value is T): T | null | undefined;
function nullable(value: unknown, valid: (value: unknown) => boolean): unknown {
  if (value === null) return null;
  return valid(value) ? value : undefined;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return (values as readonly unknown[]).includes(value);
}
