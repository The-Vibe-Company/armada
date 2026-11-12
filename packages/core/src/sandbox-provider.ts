import type { Visibility } from "./contract.ts";
import type { Provider } from "./provider.ts";

/**
 * The sandbox providers a golden can be built on. A golden belongs to exactly one, for good: its snapshot
 * only exists there. Changing provider means building another golden, which may keep the same name.
 */
export const SANDBOX_PROVIDERS = ["boat", "modal"] as const;
export type SandboxProviderId = (typeof SANDBOX_PROVIDERS)[number];

export function isSandboxProvider(value: unknown): value is SandboxProviderId {
  return typeof value === "string" && (SANDBOX_PROVIDERS as readonly string[]).includes(value);
}

/** What a provider's infrastructure allows, independent of any agent capability. */
export interface ProviderLimits {
  /** The longest a sandbox may run before the provider stops it. A longer TTL is refused, never clamped. */
  maxTtlSeconds: number;
  /** In words, for error messages. */
  maxTtlLabel: string;
  /** Default independent golden capacity when the adapter declares no override. Omitted means unlimited. */
  defaultGoldenCapacity?: number;
}

export const PROVIDER_LIMITS: Readonly<Record<SandboxProviderId, ProviderLimits>> = {
  /** boat.dev's documented TTL maximum. */
  boat: { maxTtlSeconds: 2_592_000, maxTtlLabel: "30 days", defaultGoldenCapacity: 1 },
  /** Modal's documented maximum lifetime of one sandbox machine. */
  modal: { maxTtlSeconds: 86_400, maxTtlLabel: "24 hours" },
};

/**
 * Host lifecycle semantics, independent of harness features and credential routing.
 * A shared-source restore is idempotent: a losing publisher does not own the source
 * and must never dispose of it. A fresh fork belongs to that restore attempt.
 */
export interface HostCapabilities {
  readonly goldenRestore: "fresh-fork" | "shared-source";
  /** Dispose a completed disposable builder without creating an unwanted stop checkpoint. */
  readonly goldenBuilderCleanup: "stop" | "delete";
  /**
   * Abandoned builds either stop their recorded builder, or reconcile a durable
   * reservation and dispose only through its ownership-checked provider port.
   * Reservation-backed sources must be retained once snapshot/publication starts.
   */
  readonly goldenBuilderRecovery: "stop-recorded" | "dispose-reservation";
  /** Snapshot metadata must attest the immutable management credential authority before retirement. */
  readonly snapshotManagementAuthority: boolean;
}

export const HOST_CAPABILITIES: Readonly<Record<SandboxProviderId, HostCapabilities>> = {
  boat: {
    goldenRestore: "fresh-fork",
    goldenBuilderCleanup: "stop",
    goldenBuilderRecovery: "stop-recorded",
    snapshotManagementAuthority: false,
  },
  modal: {
    goldenRestore: "shared-source",
    goldenBuilderCleanup: "delete",
    goldenBuilderRecovery: "dispose-reservation",
    snapshotManagementAuthority: true,
  },
};

/**
 * Where a Modal golden's images live, pinned when it is created: the workspace, the environment and the
 * App by its id (a name can be reused for another App). None of them is a secret, and none changes: a
 * different local profile or a token of another workspace does not move an existing golden.
 */
export interface ModalBinding {
  workspace: string;
  environment: string;
  appId: string;
}

/** What routing needs to know about a golden or a sandbox. It never holds a credential. */
export interface ProviderTarget {
  provider: SandboxProviderId;
  orgId: string;
  visibility: Visibility;
  /** Immutable source-golden credential authority, independent of target-machine visibility. */
  readonly sourceGoldenVisibility?: Visibility;
  /** Set exactly when `provider` is modal. */
  modal: ModalBinding | null;
}

/** Trusted service-only cleanup identity, never parsed from a public request. */
export interface OrchestratorCleanupScope {
  orchestratorId: string;
  sandboxId: string;
  providerSandboxId: string;
  generation: string;
  physicalGeneration?: string | null;
  operationId?: string;
}

/** Builds the provider for one target, for one caller. It resolves that caller's management credential itself. */
export type ProviderFactory = (
  target: ProviderTarget,
  caller: { userId: string; orchestratorCleanup?: OrchestratorCleanupScope },
) => Promise<Provider>;

export interface ProviderRegistry {
  /** The provider of the target's own backend, never another one. */
  resolve(
    target: ProviderTarget,
    caller: { userId: string; orchestratorCleanup?: OrchestratorCleanupScope },
  ): Promise<Provider>;
}

export type ProviderRoutingErrorCode =
  /** This server has no adapter for the provider (Modal before #513). */
  | "provider_not_configured"
  /** The record and the provider disagree: refused rather than sent to the wrong backend. */
  | "provider_mismatch";

export class ProviderRoutingError extends Error {
  override readonly name = "ProviderRoutingError";
  readonly code: ProviderRoutingErrorCode;
  readonly provider: SandboxProviderId;
  constructor(code: ProviderRoutingErrorCode, provider: SandboxProviderId, message: string) {
    super(message);
    this.code = code;
    this.provider = provider;
  }
}

/**
 * Routes each target to the factory of its own provider. A provider with no factory is an honest
 * `provider_not_configured`, and a factory that answers with another provider is refused: a Modal
 * record never falls back to Boat.
 */
export function createProviderRegistry(
  factories: Partial<Record<SandboxProviderId, ProviderFactory>>,
): ProviderRegistry {
  return {
    async resolve(target, caller) {
      assertProviderTarget(target);
      const factory = factories[target.provider];
      if (!factory) {
        throw new ProviderRoutingError(
          "provider_not_configured",
          target.provider,
          `This Armada server cannot run ${target.provider} sandboxes yet: no ${target.provider} provider is configured.`,
        );
      }
      const provider = await factory(target, caller);
      assertProviderOf(provider, target.provider);
      return provider;
    },
  };
}

/** Refuses a provider instance that is not the record's own backend. */
export function assertProviderOf(provider: Provider, expected: SandboxProviderId): void {
  if (provider.id !== expected) {
    throw new ProviderRoutingError(
      "provider_mismatch",
      expected,
      `This ${expected} resource cannot be reached through the ${provider.id} provider.`,
    );
  }
}

function assertProviderTarget(target: ProviderTarget): void {
  if (!isSandboxProvider(target.provider)) {
    throw new Error("The record names no known sandbox provider.");
  }
  if ((target.provider === "modal") !== (target.modal !== null)) {
    throw new ProviderRoutingError(
      "provider_mismatch",
      target.provider,
      target.provider === "modal"
        ? "This Modal golden has no pinned Modal App binding."
        : "Only a Modal golden carries a Modal binding.",
    );
  }
}
