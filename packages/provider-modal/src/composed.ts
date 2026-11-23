import type { ModalBinding, Sql } from "@armada/core";
import { HARNESS_CAPABILITIES } from "@armada/core";
import { chooseManagementAuthority } from "./authority.ts";
import { modalConnection } from "./client.ts";
import { type DistributionOptions, modalImage } from "./distribution.ts";
import { modalError, refusal } from "./errors.ts";
import { modalDeploymentId } from "./inventory.ts";
import type { ModalManagementProvenance, Scope } from "./ports.ts";
import { captureProcessBaseline } from "./process-scope.ts";
import { assertSourceTargetScopes, createModalProvider, type ModalProviderOptions } from "./provider.ts";
import { prepareFilesystemSnapshot, prepareFreshFilesystem } from "./snapshot.ts";
import { createSqlModalStore, scopeKey } from "./store.ts";

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
    "scope" | "appName" | "client" | "tokenId" | "tokenSecret" | "managementAuthority" | "measure" | "detachCollection"
  > {
  storedReads?: boolean;
  sourceScope?: Scope;
  resolveManagementCredentials?(authority: ModalManagementAuthority): Promise<ResolvedModalManagementCredentials>;
  sql: Sql;
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
          distribution: {
            image: buildImage,
            capabilities: HARNESS_CAPABILITIES,
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
