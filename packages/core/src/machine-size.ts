import type { LaunchRequest } from "./launch.ts";
import { LaunchError } from "./launch-error.ts";
import type { SandboxProviderId } from "./sandbox-provider.ts";

/** Versioned, browser-safe resource policy. Labels do not imply equal performance or billing. */
export const MACHINE_SIZE_VERSION = 1 as const;
export const MACHINE_SIZES = ["small", "medium", "large", "xlarge"] as const;
export type MachineSize = (typeof MACHINE_SIZES)[number];
export const MACHINE_SIZE_CATALOG = {
  small: { vcpus: 2, memoryMiB: 4096, boatType: "small", boatDiskGB: 51 },
  medium: { vcpus: 4, memoryMiB: 8192, boatType: "default", boatDiskGB: 51 },
  large: { vcpus: 8, memoryMiB: 16384, boatType: "large", boatDiskGB: 111 },
  xlarge: { vcpus: 16, memoryMiB: 32768, boatType: "xlarge", boatDiskGB: 251 },
} as const;
export interface MachineSizePolicy {
  version: 1;
  golden: MachineSize | null;
  /** Keys are configured repository directories, not arbitrary paths or repository aliases. */
  repositories: Record<string, MachineSize>;
}
export interface MachineCapacity {
  provider: SandboxProviderId;
  provenance: "requested-provider-resources";
  vcpus: number;
  memoryMiB: number;
  cpuPhysicalCores: number | null;
  cpuLimitPhysicalCores: number | null;
  memoryLimitMiB: number | null;
  boatType: "small" | "default" | "large" | "xlarge" | null;
}
export interface MachineSizeEvidence {
  version: 1;
  requested: MachineSize | null;
  effective: MachineSize | null;
  source: "override" | "repository" | "golden" | "legacy";
  repositoryDir: string | null;
  capacity: MachineCapacity | null;
}
export function parseMachineSize(value: unknown): MachineSize {
  if (!(MACHINE_SIZES as readonly unknown[]).includes(value))
    throw new LaunchError("invalid_request", "Size must be small, medium, large or xlarge.");
  return value as MachineSize;
}
export function parseMachineSizePolicy(value: unknown, directories: readonly string[]): MachineSizePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LaunchError("invalid_request", "A version 1 size policy is required.");
  const p = value as Record<string, unknown>;
  if (p.version !== 1 || Object.keys(p).some((key) => !["version", "golden", "repositories"].includes(key)))
    throw new LaunchError("invalid_request", "Unsupported size policy.");
  const golden = p.golden === null ? null : parseMachineSize(p.golden);
  if (!p.repositories || typeof p.repositories !== "object" || Array.isArray(p.repositories))
    throw new LaunchError("invalid_request", "Policy repositories must map configured directories to sizes.");
  const repositories: Record<string, MachineSize> = Object.create(null);
  for (const [dir, size] of Object.entries(p.repositories)) {
    if (!directories.includes(dir))
      throw new LaunchError("invalid_request", "Unknown configured repository directory.");
    repositories[dir] = parseMachineSize(size);
  }
  return { version: 1, golden, repositories };
}
export function machineCapacity(provider: SandboxProviderId, size: MachineSize): MachineCapacity {
  const c = MACHINE_SIZE_CATALOG[parseMachineSize(size)];
  return {
    provider,
    provenance: "requested-provider-resources",
    vcpus: c.vcpus,
    memoryMiB: c.memoryMiB,
    cpuPhysicalCores: provider === "modal" ? c.vcpus / 2 : null,
    cpuLimitPhysicalCores: provider === "modal" ? c.vcpus / 2 : null,
    memoryLimitMiB: provider === "modal" ? c.memoryMiB : null,
    boatType: provider === "boat" ? c.boatType : null,
  };
}
export function resolveMachineSize(
  provider: SandboxProviderId,
  requested: unknown,
  repositoryDir: string | null,
  policy?: MachineSizePolicy | null,
): MachineSizeEvidence {
  const override = requested === undefined ? null : parseMachineSize(requested);
  const repository = repositoryDir === null ? null : (policy?.repositories[repositoryDir] ?? null);
  const effective = override ?? repository ?? policy?.golden ?? null;
  return {
    version: 1,
    requested: override,
    effective,
    source: override ? "override" : repository ? "repository" : policy?.golden ? "golden" : "legacy",
    repositoryDir,
    capacity: effective ? machineCapacity(provider, effective) : null,
  };
}

/** POST /api/v1/golden/size-policy; omission of policy reads, a full policy replaces defaults. */
export interface MachineSizePolicyRequest {
  golden: string;
  org?: string;
  provider?: SandboxProviderId;
  policy?: MachineSizePolicy;
}
export interface MachineSizePolicyResult {
  goldenId: string;
  provider: SandboxProviderId;
  /** Actual configured identity; selectors may use dir or owner/repo via the launch resolver. */
  repositories: { url: string; branch: string; dir: string }[];
  policy: MachineSizePolicy | null;
}

/** Fail-closed launch transport: old replicas return 404. Never retry on the legacy route. */
export const SIZED_LAUNCH_ROUTE_V1 = "/api/v1/sandbox/launch-sized-v1" as const;
export const SIZED_LAUNCH_TOOL_V1 = "launch_sized_v1" as const;
/** Required even when size is omitted and repository/golden policy semantics are relied upon. */
export type SizedLaunchRequestV1 = LaunchRequest & { org?: string; sizePolicyVersion: 1 };
