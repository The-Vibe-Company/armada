import {
  LaunchError,
  MACHINE_SIZE_CATALOG,
  MACHINE_SIZES,
  type MachineSize,
  type MachineSizeEvidence,
  type MachineSizePolicy,
  type MachineSizePolicyResult,
  machineCapacity,
  parseMachineSizePolicy,
  resolveMachineSize,
  type SandboxProviderId,
} from "@armada/core";
import { PROVIDER_LABELS } from "./golden-form.ts";

/**
 * Presentation of `@armada/core`'s machine size contract (`machine-size.ts`, version 1). Every number shown comes
 * from `machineCapacity`, so the units are the provider's own: Boat machine types in vCPU, Modal requests and limits
 * in physical cores. The same label on two providers promises neither the same performance nor the same price.
 */

export const MACHINE_SIZE_LABELS: Readonly<Record<MachineSize, string>> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  xlarge: "Extra large",
};

/** The launch form's value for "no override": the resolved default applies. */
export const DEFAULT_SIZE = "";

function gib(mib: number): string {
  return `${Number((mib / 1024).toFixed(1))} GiB`;
}

function cores(count: number): string {
  return `${count} physical ${count === 1 ? "core" : "cores"}`;
}

/** One line of what a size asks the provider for, in that provider's units. */
export function sizeSpec(provider: SandboxProviderId, size: MachineSize): string {
  const capacity = machineCapacity(provider, size);
  if (provider === "modal") {
    // A Modal physical core is two vCPU. "Capped" only when the contract sets the limits equal to the request.
    const capped =
      capacity.cpuLimitPhysicalCores === capacity.cpuPhysicalCores && capacity.memoryLimitMiB === capacity.memoryMiB;
    return `${cores(capacity.cpuPhysicalCores ?? capacity.vcpus / 2)} (${capacity.vcpus} vCPU) · ${gib(capacity.memoryMiB)}${capped ? ", capped" : ""}`;
  }
  return `${capacity.vcpus} vCPU · ${gib(capacity.memoryMiB)} · ${MACHINE_SIZE_CATALOG[size].boatDiskGB} GB disk`;
}

/** An option of the size select, short enough for a phone: CPU in the provider's unit and memory. The hint has the rest. */
export function sizeOptionLabel(provider: SandboxProviderId, size: MachineSize): string {
  const capacity = machineCapacity(provider, size);
  const cpu = provider === "modal" ? cores(capacity.cpuPhysicalCores ?? capacity.vcpus / 2) : `${capacity.vcpus} vCPU`;
  return `${MACHINE_SIZE_LABELS[size]} · ${cpu} · ${gib(capacity.memoryMiB)}`;
}

export function sizeOptions(provider: SandboxProviderId): { value: MachineSize; label: string }[] {
  return MACHINE_SIZES.map((value) => ({ value, label: sizeOptionLabel(provider, value) }));
}

/**
 * The default a launch would get without an override, by the contract's own resolution: the selected repository's
 * default, then the golden's, then the legacy path that sends no size. An empty working directory is no repository.
 */
export function launchDefault(
  provider: SandboxProviderId,
  policy: MachineSizePolicy | null,
  repositoryDir: string,
): MachineSizeEvidence {
  // A policy parsed from JSON is a plain object: a directory named like a prototype key must find no default.
  const own = policy && { ...policy, repositories: Object.assign(Object.create(null), policy.repositories) };
  return resolveMachineSize(provider, undefined, repositoryDir || null, own);
}

/** Where the default comes from, said plainly. A legacy default has no recorded size, so none is invented. */
export function describeDefault(provider: SandboxProviderId, evidence: MachineSizeEvidence): string {
  const size = evidence.effective ? MACHINE_SIZE_LABELS[evidence.effective] : null;
  if (evidence.source === "repository" && size) return `${size}, the default for ${evidence.repositoryDir}`;
  if (evidence.source === "golden" && size) return `${size}, the golden's default`;
  return `No default set: ${PROVIDER_LABELS[provider]} uses its own size, which Armada does not record`;
}

/** The first option of the select, which keeps the default. */
export function defaultOptionLabel(provider: SandboxProviderId, evidence: MachineSizeEvidence): string {
  if (!evidence.effective) return `Default (${PROVIDER_LABELS[provider]} decides)`;
  return `Default · ${MACHINE_SIZE_LABELS[evidence.effective]} (${evidence.source === "repository" ? "repository" : "golden"})`;
}

/**
 * What the person should know before launching with this size, whether chosen or the default. Boat may refuse a size its plan does not include
 * or whose disk cannot hold the golden; neither is upgraded or replaced silently, so the launch fails and says why.
 */
export function sizeCaveat(provider: SandboxProviderId, chosen: MachineSize | null): string | null {
  if (!chosen) return null;
  if (provider === "modal") return "Modal requests and limits; the same label on Boat is a different machine.";
  if (chosen === "xlarge") return "Extra large needs a Boat plan that includes it.";
  return "Boat refuses a size whose disk cannot hold the golden.";
}

/**
 * The server's codes for a provider refusing a fork before anything is allocated (`ProviderError` in the control
 * API): a plan-gated or too-small size arrives as one of these, never as `start_failed`.
 */
export const PROVIDER_REFUSALS: ReadonlySet<string> = new Set(["forbidden", "invalid_request", "payment_required"]);

/**
 * A sandbox's recorded `machine_size` evidence in words, or null when the database has no such column. Rows from
 * before #653 hold null: their size was never recorded, and none is inferred.
 */
export function describeEvidence(provider: SandboxProviderId, row: { machine_size?: unknown }): string | null {
  if (!("machine_size" in row) || row.machine_size === undefined) return null;
  const evidence = row.machine_size as Partial<MachineSizeEvidence> | null;
  if (!evidence || evidence.version !== 1) return "Not recorded";
  const size = evidence.effective;
  if (!size || !(MACHINE_SIZES as readonly unknown[]).includes(size))
    return `${PROVIDER_LABELS[provider]} default, not recorded`;
  const source =
    evidence.source === "override"
      ? "chosen at launch"
      : evidence.source === "repository"
        ? `default for ${evidence.repositoryDir}`
        : "golden default";
  return `${MACHINE_SIZE_LABELS[size]} (${source}) · ${sizeSpec(provider, size)}`;
}

/** Whether a stored `size_policy` sets any default (a cleared policy is `{version:1, golden:null, repositories:{}}`). */
export function policyHasDefaults(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const policy = value as { golden?: unknown; repositories?: unknown };
  return (
    policy.golden != null ||
    (typeof policy.repositories === "object" &&
      policy.repositories !== null &&
      Object.keys(policy.repositories).length > 0)
  );
}

/** A golden's stored size policy as the dashboard can use it. */
export type GoldenSizing =
  /** The server predates size policies (#653): no size is offered or sent. */
  | { kind: "unsupported" }
  | { kind: "ready"; policy: MachineSizePolicy | null }
  /** Stored but not valid against the golden's directories: shown, never guessed around. */
  | { kind: "unreadable"; reason: string };

/**
 * Reads the golden row's `size_policy` with the contract's parser against its configured directories. A row read
 * before the column existed has no `size_policy` key at all, which is how the dashboard knows not to offer sizes.
 */
export function goldenSizing(golden: { size_policy?: unknown }, directories: readonly string[]): GoldenSizing {
  if (!("size_policy" in golden) || golden.size_policy === undefined) return { kind: "unsupported" };
  if (golden.size_policy === null) return { kind: "ready", policy: null };
  try {
    const policy = parseMachineSizePolicy(golden.size_policy, directories);
    // The parser's null-prototype map cannot cross into a client component; a plain copy can.
    return { kind: "ready", policy: { ...policy, repositories: { ...policy.repositories } } };
  } catch (error) {
    if (error instanceof LaunchError) return { kind: "unreadable", reason: error.message };
    throw error;
  }
}

/** One line for the golden card: which defaults are set, or that the provider decides. */
export function policySummary(provider: SandboxProviderId, policy: MachineSizePolicy | null): string {
  const parts = [
    ...(policy?.golden ? [`Golden: ${MACHINE_SIZE_LABELS[policy.golden]}`] : []),
    ...Object.entries(policy?.repositories ?? {}).map(([dir, size]) => `${dir}: ${MACHINE_SIZE_LABELS[size]}`),
  ];
  return parts.length > 0 ? parts.join(" · ") : `No defaults: ${PROVIDER_LABELS[provider]} decides`;
}

/**
 * Why the viewer may not change this golden's size defaults, or null when they may. The same rule the server's
 * `golden/size-policy` applies: the owner of a private golden, an org admin for an org golden.
 */
export function sizePolicyBlocker(
  golden: { visibility: "private" | "org"; owner_id: string },
  viewer: { id: string; isAdmin: boolean },
): string | null {
  if (golden.visibility === "private")
    return golden.owner_id === viewer.id ? null : "Only its owner changes its size defaults.";
  return viewer.isAdmin ? null : "Only an org admin changes an org golden's size defaults.";
}

/**
 * The full policy from the defaults form: `golden` and one `size:<dir>` field per configured directory, empty for
 * no default. Validated by the contract's parser, so an unknown size or directory is refused, never dropped.
 */
export function policyFromForm(
  read: (field: string) => string,
  directories: readonly string[],
): { ok: true; policy: MachineSizePolicy } | { ok: false; error: string } {
  const golden = read("golden_size").trim();
  const repositories: Record<string, string> = {};
  for (const dir of directories) {
    const size = read(`size:${dir}`).trim();
    if (size) repositories[dir] = size;
  }
  try {
    return {
      ok: true,
      policy: parseMachineSizePolicy({ version: 1, golden: golden || null, repositories }, directories),
    };
  } catch (error) {
    if (error instanceof LaunchError) return { ok: false, error: error.message };
    throw error;
  }
}

/** The answer of `POST /api/v1/golden/size-policy` (`MachineSizePolicyResult` in `@armada/core`). */
export function isSizePolicyResult(value: unknown): value is MachineSizePolicyResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.goldenId === "string" &&
    (result.provider === "boat" || result.provider === "modal") &&
    Array.isArray(result.repositories) &&
    (result.policy === null ||
      (typeof result.policy === "object" && (result.policy as { version?: unknown }).version === 1))
  );
}
