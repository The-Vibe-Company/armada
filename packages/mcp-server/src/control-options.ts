import type { AuthStore } from "@armada/auth";
import type {
  ApplicationVault,
  createSkillCatalog,
  GitHubApp,
  GoldenBuildJobs,
  GoldenRecord,
  LaunchOptions,
  LaunchStores,
  mutateCredentialAccount,
  Provider,
  ProviderRegistry,
  ProviderTarget,
  RoutineService,
  SkillDefaultsService,
  TemplateService,
  VaultStore,
} from "@armada/core/server";
import type { Caller, SupabaseProject } from "./caller.ts";
import type { createSqlCredentialList } from "./credential-list-sql.ts";
import type { DataSource, SandboxView, ScopedData } from "./data.ts";
import type { GitHubAccountApi } from "./github-account.ts";
import type { Invitations } from "./invitations.ts";
import type { McpControlOptions } from "./mcp-control.ts";
import type { ModelAuthOwnership } from "./model-auth.ts";
import type { ModelUsageApi } from "./model-usage.ts";
import type { ProviderValidator } from "./org-provider.ts";
import type { ProviderMetadataFor } from "./provider-metadata.ts";
import type { RequestTiming } from "./request-timing.ts";
import type { RuntimeCheckpoint } from "./runtime-checkpoint.ts";
import type { RuntimeFollowup } from "./runtime-followup.ts";
import type { RuntimeGitHub } from "./runtime-github.ts";
import type { SandboxLogReader } from "./runtime-history.ts";
import type { RuntimeMcp } from "./runtime-mcp.ts";
import type { RuntimeResume } from "./runtime-resume.ts";
import type { CredentialBindingRecovery } from "./sandbox-account-change.ts";
import type { createSandboxArmadaAccess } from "./sandbox-armada-access.ts";

export interface ControlOptions {
  antigravityLogin?: ReturnType<typeof import("./antigravity-login.ts").createAntigravityLogin>;
  configureAntigravityLoginRequest?: (request: Request) => void;
  listCredentialMetadata?: ReturnType<typeof createSqlCredentialList>;
  eventStreamShutdown?: AbortSignal;
  eventFeed?: import("./event-feed.ts").EventFeed;
  relayHub?: import("./relay-hub.ts").RelayHub;
  configureStopRequest?: (request: Request) => void;
  stopAdmissionShutdown?: AbortSignal;
  configureScopedMutationRequest?: (request: Request) => void;
  configureEventStreamRequest?: (request: Request) => void;
  scopedSandboxData?: (caller: Caller, ref: string) => ScopedData;
  listGoldenRecords?: (caller: Caller, ref: string | undefined) => Promise<GoldenRecord[]>;
  sandboxListTurns?: ReturnType<typeof import("./sandbox-list-turns.ts").createSandboxListTurns>;
  sandboxBillingAccount?: (
    caller: Caller,
    id: string,
  ) => Promise<import("./sandbox-billing-account.ts").SandboxBillingAccount | null>;
  admitHostLaunch?: import("./docker-launch-placement.ts").AdmitHostLaunch;
  dockerControls?: import("./docker-sandbox-controls.ts").DockerSandboxControls;
  docker?: {
    hosts?: boolean;
    placement?: boolean;
    normalApi?: boolean;
    normalLaunch?: boolean;
    normalSend?: boolean;
    normalResume?: boolean;
  };
  runtimeMcp?: Pick<RuntimeMcp, "prepare" | "preflight" | "connections">;
  runtimeGitHub?: RuntimeGitHub;
  runtimeResume?: RuntimeResume;
  runtimeCheckpoint?: RuntimeCheckpoint;
  runtimeStopCheckpoint?: import("./tools.ts").ToolContext["runtimeStopCheckpoint"];
  runtimeSend?: RuntimeFollowup;
  accountTurns?: import("./account-turn-queue.ts").AccountTurnQueue;
  modalRuntimeHostFor?: (target: import("@armada/core").ProviderTarget, caller: Caller) => Promise<Provider>;
  modalRuntimeLaunch?: NonNullable<LaunchOptions["runtime"]>;
  boatLaunchEnabled?: boolean;
  skillCatalog?: ReturnType<typeof createSkillCatalog>;
  timing?: RequestTiming;
  modalJobReader?: ReturnType<typeof import("./runtime-history.ts").createModalJobReader>;
  storedProviderFor?: (target: ProviderTarget, caller: { userId: string }) => Promise<Provider>;
  sandboxArmadaAccess?: ReturnType<typeof createSandboxArmadaAccess>;
  templates?: TemplateService;
  skillDefaults?: SkillDefaultsService;
  routines?: RoutineService;
  applicationVault?: ApplicationVault;
  publicUrl?: string;
  modelAuth?: ModelAuthOwnership;
  credentialBindingRecovery?: CredentialBindingRecovery;
  modelUsage?: ModelUsageApi;
  invitations?: Invitations;
  providerValidator?: ProviderValidator;
  modelAccountValidator?: NonNullable<Parameters<typeof mutateCredentialAccount>[4]>;
  githubAccount?: GitHubAccountApi;
  goldenRetirements?: import("@armada/core/server").GoldenSnapshotRetirements;
  mcp?: NonNullable<McpControlOptions["mcp"]>;
  connections?: LaunchStores["connections"];
  authStore: AuthStore;
  deviceLogin?: NonNullable<ReturnType<typeof import("./device-login-control.ts").deviceLoginFromConfig>>;
  supabase: SupabaseProject;
  now?: () => Date;
  data?: DataSource;
  vault?: VaultStore;
  launch?: LaunchOptions;
  admitModalLaunch?: import("./modal-launch-admission.ts").AdmitModalLaunch;
  store: VaultStore;
  encryptionKey: string | undefined;
  github?: { app: GitHubApp | null; fetch?: typeof fetch; now?: () => Date };
  logs?: (
    caller: Caller,
    sandboxId: string,
  ) => Promise<{ provider: SandboxLogReader; providerSandboxId: string; sandbox?: SandboxView }>;
  goldenBuilds?: GoldenBuildJobs;
  goldenAdoption?: import("@armada/core/server").GoldenAdoption;
  providers?: ProviderRegistry;
  providerMetadata?: ProviderMetadataFor;
  goldenTarget?: (target: Omit<ProviderTarget, "modal">, caller: { userId: string }) => Promise<ProviderTarget>;
  providerFor?: (apiKey: string, caller?: { userId: string; orgId: string }) => Provider;
  refreshNative?: (refreshToken: string) => Promise<{ accessToken: string; refreshToken: string; expiresAt: string }>;
  exchangeNative?: (
    code: string,
    verifier: string,
  ) => Promise<{ accessToken: string; refreshToken: string; expiresAt: string }>;
}

export type ConfiguredControlOptions = ControlOptions & { credentialBindingRecovery: CredentialBindingRecovery };
