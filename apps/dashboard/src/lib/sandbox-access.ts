import { HARNESSES, MACHINE_SIZES, type MachineSize, SANDBOX_PROVIDERS, type SandboxListMetadata } from "@armada/core";
import { SANDBOX_STATUSES } from "./sandbox-filters.ts";

/**
 * Reads the rows of `public.sandbox_list_metadata()` (#680, `docs/contracts/sandbox-access-v1.md`). Only the
 * contract's allowlisted fields are kept, so an interior field a producer might add never reaches a page. A row that
 * does not match the contract fails the whole read: the list is never shown from a guess.
 */
export function parseSandboxListMetadata(value: unknown): SandboxListMetadata[] {
  if (!Array.isArray(value)) throw new Error("The sandbox list did not match its contract.");
  return value.map((row) => {
    const parsed = parseRow(row);
    if (!parsed) throw new Error("The sandbox list did not match its contract.");
    return parsed;
  });
}

function parseRow(value: unknown): SandboxListMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const { id, orgId, ownerId, provider, harness, status, createdAt, displayLabel, canOpen, canManage } = row;
  const created = instant(createdAt);
  if (!text(id) || !text(orgId) || !text(ownerId) || !created || !text(displayLabel)) return null;
  if (!oneOf(SANDBOX_PROVIDERS, provider) || !oneOf(HARNESSES, harness) || !oneOf(SANDBOX_STATUSES, status))
    return null;
  if (typeof canOpen !== "boolean" || typeof canManage !== "boolean") return null;
  const providerSandboxId = nullable(row.providerSandboxId, text);
  const boatId = nullable(row.boatId, text);
  const model = nullable(row.model, text);
  const reasoningEffort = nullable(row.reasoningEffort, text);
  const stoppedAt = timestamp(row.stoppedAt);
  const expiresAt = timestamp(row.expiresAt);
  const effectiveTtlSeconds = nullable(row.effectiveTtlSeconds, seconds);
  const machineSize = nullable(row.machineSize, size);
  if (
    providerSandboxId === undefined ||
    boatId === undefined ||
    model === undefined ||
    reasoningEffort === undefined ||
    stoppedAt === undefined ||
    expiresAt === undefined ||
    effectiveTtlSeconds === undefined ||
    machineSize === undefined
  )
    return null;
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
    displayLabel,
    canOpen,
    canManage,
  };
}

/** How a listed sandbox is named: its provider's display ID (bx_ on Boat) when there is one, else its logical label. */
export function sandboxName(sandbox: Pick<SandboxListMetadata, "providerSandboxId" | "displayLabel">): string {
  return sandbox.providerSandboxId ?? sandbox.displayLabel;
}

const SIZE_LABELS: Record<MachineSize, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  xlarge: "Extra large",
};

export function machineSizeLabel(size: MachineSize): string {
  return SIZE_LABELS[size];
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
