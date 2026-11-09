import {
  MACHINE_SIZE_CATALOG,
  MACHINE_SIZES,
  type MachineSize,
  type MachineSizeEvidence,
  type MachineSizePolicy,
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
    // A Modal physical core is two vCPU; the request and the limit are the same, so there is no burst above them.
    return `${cores(capacity.cpuPhysicalCores ?? capacity.vcpus / 2)} (${capacity.vcpus} vCPU) · ${gib(capacity.memoryMiB)}, capped`;
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
  return resolveMachineSize(provider, undefined, repositoryDir || null, policy);
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
 * What the person should know before launching with this choice. Boat may refuse a size its plan does not include
 * or whose disk cannot hold the golden; neither is upgraded or replaced silently, so the launch fails and says why.
 */
export function sizeCaveat(provider: SandboxProviderId, chosen: MachineSize | null): string | null {
  if (!chosen) return null;
  if (provider === "modal") return "Modal requests and limits; the same label on Boat is a different machine.";
  if (chosen === "xlarge") return "Extra large needs a Boat plan that includes it.";
  return "Boat refuses a size whose disk cannot hold the golden.";
}

/** A policy with no default, the starting point of an edit. */
export function emptyPolicy(): MachineSizePolicy {
  return { version: 1, golden: null, repositories: {} };
}

/**
 * The policy with one default changed (`null` removes it), validated by the contract's parser against the golden's
 * configured directories. Throws the contract's `LaunchError` for a directory the golden does not configure.
 */
export function withDefault(
  policy: MachineSizePolicy | null,
  target: { golden: true } | { repositoryDir: string },
  size: MachineSize | null,
  directories: readonly string[],
): MachineSizePolicy {
  const base = policy ?? emptyPolicy();
  if ("golden" in target) return parseMachineSizePolicy({ ...base, golden: size }, directories);
  const repositories = Object.fromEntries(
    Object.entries(base.repositories).filter(([dir]) => dir !== target.repositoryDir),
  );
  if (size) repositories[target.repositoryDir] = size;
  return parseMachineSizePolicy({ ...base, repositories }, directories);
}
