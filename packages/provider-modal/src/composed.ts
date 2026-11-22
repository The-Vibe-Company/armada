import type { ModalBinding, Sql } from "@armada/core";
import { HARNESS_CAPABILITIES } from "@armada/core";
import { chooseManagementAuthority } from "./authority.ts";
import { modalConnection } from "./client.ts";
import { createRunnerDistribution, type DistributionOptions, modalImage } from "./distribution.ts";
import { modalError, refusal } from "./errors.ts";
import { projectGitHubExecEnvironment, withTrustedHarnessPath } from "./exec-env.ts";
import { createGenerationGrants } from "./grants.ts";
import { createModalIngestHandler } from "./ingest.ts";
import { modalDeploymentId } from "./inventory.ts";
import type { ExecEnvironment, Machine, McpConfiguration, ModalManagementProvenance, Scope } from "./ports.ts";
import { captureProcessBaseline, sealProcessBaseline } from "./process-scope.ts";
import { assertSourceTargetScopes, createModalProvider, type ModalProviderOptions } from "./provider.ts";
import { prepareFilesystemSnapshot, prepareFreshFilesystem } from "./snapshot.ts";
import { createSqlModalStore, scopeKey } from "./store.ts";
import { createRunnerTransport } from "./transport.ts";

export type { McpConfiguration } from "./ports.ts";
export interface HarnessEnvironment {
  opencodeEnv?: Record<string, string>;
  claudeEnv: Record<string, string>;
  codexEnv: Record<string, string>;
  codexAuthJson?: string;
  subscription?: { url: string; capability: string };
  nativeAuthRevision?: number;
  nativeAuthSecrets?: string[];
  mcp?: McpConfiguration;
  execEnv?: ExecEnvironment;
}
export interface ModalManagementAuthority extends ModalManagementProvenance {
  orgId: string;
  sourceGoldenVisibility: "org" | "private";
  binding: ModalBinding;
}
export interface ResolvedModalManagementCredentials extends ModalManagementProvenance {
  tokenId: string;
  tokenSecret: string;
}
interface ModalCompositionOptions
  extends Pick<
    ModalProviderOptions,
    | "scope"
    | "commonRuntime"
    | "appName"
    | "client"
    | "tokenId"
    | "tokenSecret"
    | "managementAuthority"
    | "resumeRefused"
    | "beforeResume"
    | "beforePrompt"
    | "measure"
    | "detachCollection"
  > {
  storedReads?: boolean;
  sourceScope?: Scope;
  resolveManagementCredentials?(authority: ModalManagementAuthority): Promise<ResolvedModalManagementCredentials>;
  sql: Sql;
}
export interface ComposedModalOptions extends ModalCompositionOptions {
  fetcher?: typeof fetch;
  signingKey: Uint8Array;
  ingestUrl: string;
  artifact: Pick<DistributionOptions, "base" | "apt" | "bundle" | "sha256">;
  resolveHarnessEnvironment(machine: Machine, launchEnv: Readonly<Record<string, string>>): Promise<HarnessEnvironment>;
}
export async function createComposedModalProvider(options: ComposedModalOptions) {
  try {
    return await composeModalProvider(options);
  } catch (error) {
    throw modalError(error);
  }
}
async function composeModalProvider(options: ComposedModalOptions) {
  const { close, ...ports } = await modalComposition(options, options.ingestUrl);
  const { client, store } = ports;
  const grants = createGenerationGrants(options.signingKey, options.scope);
  const port = 8765;
  const runner = createRunnerTransport(async (row) => {
    const current = await store.get(row.info.id);
    if (current.generation !== row.generation || !row.physicalId)
      throw refusal("forbidden", "Runner generation is fenced.");
    const sb = await client.sandboxes.fromId(row.physicalId);
    const connect = await sb.createConnectToken({ port });
    if (new URL(connect.url).protocol !== "https:")
      throw refusal("unavailable", "Modal runner access is not protected HTTPS.");
    const grant = grants.issue(row);
    return { url: connect.url, connectToken: connect.token, grant: grant.token, expiresAt: grant.expiresAt };
  }, options.fetcher);
  const distribution = createRunnerDistribution({
    ...options.artifact,
    capabilities: HARNESS_CAPABILITIES,
    async bootstrap(row, env) {
      const harness = row.golden ? { claudeEnv: {}, codexEnv: {} } : await options.resolveHarnessEnvironment(row, env);
      return {
        root: "/home/user/.armada-runtime",
        cwd: "/home/user",
        port,
        grant: grants.issue(row),
        opencodeExecutable: "/opt/armada/opencode",
        opencodeEnv: withTrustedHarnessPath(harness.opencodeEnv ?? {}),
        claudeExecutable: "/usr/local/bin/claude",
        codexExecutable: "/usr/local/bin/codex",
        claudeEnv: withTrustedHarnessPath(harness.claudeEnv),
        codexEnv: withTrustedHarnessPath(harness.codexEnv),
        ...(harness.subscription ? { subscription: harness.subscription } : {}),
        ...("codexAuthJson" in harness && harness.codexAuthJson !== undefined
          ? { codexAuthJson: harness.codexAuthJson }
          : {}),
        ...("nativeAuthRevision" in harness && harness.nativeAuthRevision !== undefined
          ? { nativeAuthRevision: harness.nativeAuthRevision, nativeAuthSecrets: harness.nativeAuthSecrets }
          : {}),
        ...("mcp" in harness && harness.mcp !== undefined ? { mcp: harness.mcp } : {}),
        credentialFreeBuilder: row.golden,
        execEnv: row.golden ? projectGitHubExecEnvironment({}) : projectGitHubExecEnvironment(env, harness.execEnv),
        ingestUrl: options.ingestUrl,
      };
    },
    restoreEnv: async () => ({}),
    prepareSnapshot: prepareFilesystemSnapshot,
    prepareFreshMachine: prepareFreshFilesystem,
    captureProcessBaseline,
    sealProcessBaseline,
  });
  const connectionPorts = createModalProvider({
    ...options,
    ...ports,
    runner,
    distribution,
  });
  const ingest = createModalIngestHandler({ sql: options.sql, verifyGrant: grants.verifyGrant });
  return {
    ...connectionPorts,
    ingest,
    close,
  };
}

export interface RuntimeModalOptions extends ModalCompositionOptions {
  publicUrl: string;
  image: Pick<DistributionOptions, "base" | "apt">;
}

export async function createRuntimeModalProvider(options: RuntimeModalOptions) {
  const { publicUrl, image, ...providerOptions } = options;
  try {
    const buildImage = modalImage(image);
    const { close, ...ports } = await modalComposition(providerOptions, publicUrl);
    try {
      return {
        ...createModalProvider({
          ...providerOptions,
          ...ports,
          commonRuntime: true,
          distribution: {
            image: buildImage,
            capabilities: HARNESS_CAPABILITIES,
            restoreEnv: async () => ({}),
            prepareSnapshot: prepareFilesystemSnapshot,
            prepareFreshMachine: prepareFreshFilesystem,
            captureProcessBaseline,
          },
        }),
        close,
      };
    } catch (error) {
      close();
      throw error;
    }
  } catch (error) {
    throw modalError(error);
  }
}

async function modalComposition(options: ModalCompositionOptions, publicUrl: string) {
  const sourceScope = options.sourceScope ?? options.scope;
  assertSourceTargetScopes(sourceScope, options.scope);
  const provenance = chooseManagementAuthority(sourceScope, options.managementAuthority);
  const authority: ModalManagementAuthority = Object.freeze({
    orgId: sourceScope.orgId,
    sourceGoldenVisibility: sourceScope.visibility,
    ...provenance,
    binding: Object.freeze({ ...sourceScope.binding }),
  });
  const credentials = await options.resolveManagementCredentials?.(authority);
  if (
    credentials &&
    (credentials.credentialScope !== provenance.credentialScope ||
      credentials.credentialOwnerId !== provenance.credentialOwnerId)
  )
    throw refusal("forbidden", "Management credential provenance does not match immutable source golden authority.");
  const connection = {
    ...(options.client ? { client: options.client } : {}),
    ...(credentials
      ? { tokenId: credentials.tokenId, tokenSecret: credentials.tokenSecret }
      : {
          ...(options.tokenId !== undefined ? { tokenId: options.tokenId } : {}),
          ...(options.tokenSecret !== undefined ? { tokenSecret: options.tokenSecret } : {}),
        }),
  };
  const endpoint = new URL(publicUrl);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw refusal("invalid_request", "Public Modal URL must use HTTPS.");
  const client = modalConnection(connection);
  if (!options.storedReads) {
    const app = await client.apps.fromName(options.appName, {
      environment: sourceScope.binding.environment,
      createIfMissing: false,
    });
    if (app.appId !== sourceScope.binding.appId)
      throw refusal("forbidden", "Modal App does not match immutable source binding.");
  }
  const store = createSqlModalStore(options.sql, options.scope);
  const sourceStore =
    scopeKey(sourceScope) === scopeKey(options.scope) ? store : createSqlModalStore(options.sql, sourceScope);
  return {
    deploymentId: modalDeploymentId(options.scope.binding.environment, endpoint.origin),
    managementAuthority: provenance,
    source: { scope: sourceScope, store: sourceStore },
    store,
    client,
    close: () => {
      if (!options.client) client.close();
    },
  };
}
