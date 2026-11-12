import type { ModalBinding, Sql } from "@armada/core";
import { HARNESS_CAPABILITIES } from "@armada/core";
import { chooseManagementAuthority } from "./authority.ts";
import { modalConnection } from "./client.ts";
import { createRunnerDistribution, type DistributionOptions } from "./distribution.ts";
import { modalError, refusal } from "./errors.ts";
import { projectGitHubExecEnvironment, withTrustedHarnessPath } from "./exec-env.ts";
import { createGenerationGrants } from "./grants.ts";
import { createModalIngestHandler } from "./ingest.ts";
import type { ExecEnvironment, Machine, McpConfiguration, ModalManagementProvenance, Scope } from "./ports.ts";
import { captureProcessBaseline, sealProcessBaseline } from "./process-scope.ts";
import { assertSourceTargetScopes, createModalProvider, type ModalProviderOptions } from "./provider.ts";
import { prepareFilesystemSnapshot, prepareFreshFilesystem } from "./snapshot.ts";
import { createSqlModalStore, scopeKey } from "./store.ts";
import { createRunnerTransport } from "./transport.ts";

export type { McpConfiguration } from "./ports.ts";
export interface HarnessEnvironment {
  claudeEnv: Record<string, string>;
  codexEnv: Record<string, string>;
  codexAuthJson?: string;
  credentialRepoint?: string;
  nativeAuthRevision?: number;
  nativeAuthSecrets?: string[];
  mcp?: McpConfiguration;
  /** Fresh exec-only credentials/options. Explicit {} disables launch-env fallback on restore/init. */
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
export interface ComposedModalOptions
  extends Pick<
    ModalProviderOptions,
    | "scope"
    | "appName"
    | "client"
    | "tokenId"
    | "tokenSecret"
    | "managementAuthority"
    | "beforeResume"
    | "beforePrompt"
    | "measure"
  > {
  storedReads?: boolean;
  /** Immutable golden visibility/binding, with userId set to the authenticated caller. */
  sourceScope?: Scope;
  resolveManagementCredentials?(authority: ModalManagementAuthority): Promise<ResolvedModalManagementCredentials>;
  /** Production operator/client injection and HTTP dependency port. */
  fetcher?: typeof fetch;
  sql: Sql;
  signingKey: Uint8Array;
  ingestUrl: string;
  artifact: Pick<DistributionOptions, "base" | "apt" | "bundle" | "sha256">;
  /** Server credential resolver. Called on fork/recovery only, never for a golden builder. */
  resolveHarnessEnvironment(machine: Machine, launchEnv: Readonly<Record<string, string>>): Promise<HarnessEnvironment>;
}
/** Actual composition: no caller needs to invent runner tokens, bootstrap JSON or SDK transport. */
export async function createComposedModalProvider(options: ComposedModalOptions) {
  try {
    return await composeModalProvider(options);
  } catch (error) {
    throw modalError(error);
  }
}
async function composeModalProvider(options: ComposedModalOptions) {
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
  const ingestUrl = new URL(options.ingestUrl);
  if (ingestUrl.protocol !== "https:" || ingestUrl.username || ingestUrl.password || ingestUrl.search || ingestUrl.hash)
    throw refusal("invalid_request", "Public ingest URL must use HTTPS.");
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
        claudeExecutable: "/usr/local/bin/claude",
        codexExecutable: "/usr/local/bin/codex",
        claudeEnv: withTrustedHarnessPath(harness.claudeEnv),
        codexEnv: withTrustedHarnessPath(harness.codexEnv),
        ...("credentialRepoint" in harness && harness.credentialRepoint !== undefined
          ? { credentialRepoint: harness.credentialRepoint }
          : {}),
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
    restoreEnv: async () => ({}), // Harness resolver receives persisted launch identity, never cached secret env.
    prepareSnapshot: prepareFilesystemSnapshot,
    prepareFreshMachine: prepareFreshFilesystem,
    captureProcessBaseline,
    sealProcessBaseline,
  });
  const provider = createModalProvider({
    ...options,
    ...connection,
    managementAuthority: provenance,
    source: { scope: sourceScope, store: sourceStore },
    store,
    client,
    runner,
    distribution,
  });
  const ingest = createModalIngestHandler({ sql: options.sql, verifyGrant: grants.verifyGrant });
  return {
    provider: options.scope.cleanup
      ? new Proxy(provider, {
          get(target, key) {
            const allowed = new Set([
              "id",
              "get",
              "events",
              "observeOrchestrator",
              ...(options.scope.cleanup?.operationId
                ? [
                    "quiesceOrchestrator",
                    "scrubOrchestratorEpoch",
                    "checkpointOrchestrator",
                    "readOrchestratorCheckpoint",
                  ]
                : []),
            ]);
            const value = Reflect.get(target, key, target);
            if (typeof value === "function") {
              if (!allowed.has(String(key)))
                return () => {
                  throw refusal("forbidden", "Cleanup cannot admit native work.");
                };
              return value.bind(target);
            }
            return value;
          },
        })
      : provider,
    ingest,
    close: () => {
      if (!options.client) client.close();
    },
  };
}
