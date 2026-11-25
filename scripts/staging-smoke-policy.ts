import { isSandboxPlacementProvider, type SandboxPlacementProviderId } from "../packages/core/src/sandbox-provider.ts";

export const BOAT_STAGING_NOTICE = "boat: not part of the release gate";

const stagingProviders: ReadonlySet<unknown> = new Set(["modal", "docker"]);
const coordinatorOnlyProviders: ReadonlySet<unknown> = new Set(["boat"]);

export function isStagingSmokeProvider(value: unknown): value is "modal" | "docker" {
  return stagingProviders.has(value);
}

export function isCoordinatorSmokeProvider(value: unknown): value is "boat" {
  return coordinatorOnlyProviders.has(value);
}

const smokeWirePolicy = {
  boat: { requestIds: "mcp", mcpRuntimeEpoch: true, reconcileTemplateByExternalRef: false },
  modal: { requestIds: "none", mcpRuntimeEpoch: false, reconcileTemplateByExternalRef: true },
  docker: { requestIds: "all", mcpRuntimeEpoch: false, reconcileTemplateByExternalRef: false },
} as const satisfies Record<
  SandboxPlacementProviderId,
  {
    requestIds: "mcp" | "none" | "all";
    mcpRuntimeEpoch: boolean;
    reconcileTemplateByExternalRef: boolean;
  }
>;

export function requiresMcpRuntimeEpoch(provider: SandboxPlacementProviderId) {
  return smokeWirePolicy[provider].mcpRuntimeEpoch;
}

export function reconcilesTemplateByExternalRef(provider: unknown) {
  return isSandboxPlacementProvider(provider) && smokeWirePolicy[provider].reconcileTemplateByExternalRef;
}

export function smokeRequestId(provider: unknown, probe?: "mcp") {
  if (!isSandboxPlacementProvider(provider)) return {};
  const policy = smokeWirePolicy[provider].requestIds;
  return policy === "all" || (probe === "mcp" && policy === "mcp") ? { request_id: crypto.randomUUID() } : {};
}

/** Filter before validating unused Boat account/model/golden fields. Never infer provider from text. */
export function stagingSmokeCases(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("invalid_smoke_cases");
  return value.filter(
    (row) =>
      !(typeof row === "object" && row !== null && "provider" in row && isCoordinatorSmokeProvider(row.provider)),
  );
}

/** Conflicting or absent provider evidence cannot authorize automatic cleanup. */
export function smokeReceiptProvider(value: unknown): "boat" | "modal" | "docker" | undefined {
  const result = value as {
    sandbox?: { provider?: unknown };
    provider?: unknown;
    manifest?: { definition?: { provider?: unknown } };
  } | null;
  const providers = [result?.sandbox?.provider, result?.provider, result?.manifest?.definition?.provider].filter(
    (provider) => provider !== undefined,
  );
  const provider = providers[0];
  if (isSandboxPlacementProvider(provider) && providers.every((candidate) => candidate === provider)) return provider;
}
