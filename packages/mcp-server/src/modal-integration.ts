import { hkdfSync } from "node:crypto";
import {
  type CredentialReader,
  decryptSecret,
  EncryptionKeyError,
  type ModalBinding,
  type Provider,
  type ProviderTarget,
  parseModalTokenPair,
  resolveModalTokens,
  type Sql,
  VaultError,
} from "@armada/core/server";
import {
  type ComposedModalOptions,
  createComposedModalProvider,
  createGenerationGrants,
  createModalIngestHandler,
  MODAL_IMAGE_LOCK,
  type ModalManagementAuthority,
  type ResolvedModalManagementCredentials,
  type Scope,
  scopeKey,
} from "@armada/provider-modal";
import { loadEmbeddedRunnerArtifact } from "@armada/provider-modal/embedded";
import { ModalClient } from "modal";
import type { HandlerOptions } from "./http.ts";
import type { GitHubLaunchOptions } from "./launch-credentials.ts";
import { modalLaunchEnvironment } from "./modal-launch-environment.ts";
import { createModelAuthOwnership } from "./model-auth.ts";

export type { ModalManagementAuthority } from "@armada/provider-modal";
export const MODAL_INGEST_PATH = "/api/internal/modal/events";

/** Stable across deployments; distinct from encryption and every other signing purpose. */
function runnerKey(value: string | undefined): Uint8Array {
  const raw = Buffer.from(value ?? "", "base64");
  if (raw.length !== 32) throw new EncryptionKeyError("Modal requires ARMADA_ENCRYPTION_KEY (32 bytes, base64).");
  return new Uint8Array(hkdfSync("sha256", raw, "armada/modal/v1", "runner-generation-grants", 32));
}

export async function createModalIntegration(options: {
  sql: Sql;
  vault: CredentialReader;
  encryptionKey: string | undefined;
  publicUrl: string;
  github?: GitHubLaunchOptions;
  /** Root523 lifecycle: called by the actual adapter after ready/restore, outside its lease. */
  beforeResume?: (provider: Provider, sandboxId: string, actor: { userId: string; orgId: string }) => Promise<void>;
  beforePrompt?: (provider: Provider, sandboxId: string, actor: { userId: string; orgId: string }) => Promise<void>;
  // MCP lifecycle belongs to #523 post-init/beforePrompt/beforeSnapshot, never bootstrap.
}) {
  const key = runnerKey(options.encryptionKey);
  const artifact = { ...MODAL_IMAGE_LOCK, ...(await loadEmbeddedRunnerArtifact()) };
  const ingestUrl = new URL(MODAL_INGEST_PATH, options.publicUrl).href;
  const modelAuth = createModelAuthOwnership(options.sql, options.encryptionKey);
  const ingest = createModalIngestHandler({
    publishNativeAuth: (scope, claims, raw, revision) => modelAuth.publishFromModal(scope, claims, raw, revision),
    sql: options.sql,
    async verifyGrant(token) {
      if (token.length > 4096) throw new Error("Invalid runner grant.");
      const body = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString());
      if (typeof body.binding !== "string" || !/^[a-f0-9]{64}$/.test(body.binding))
        throw new Error("Invalid runner scope.");
      const result = await options.sql.query<{ context: Scope }>(
        "select context from public.modal_server_scopes where scope=$1",
        [body.binding],
      );
      const scope = result.rows[0]?.context;
      if (!scope) throw new Error("Unknown runner scope.");
      const verified = await createGenerationGrants(key, scope).verifyGrant(token);
      // Org scope hashes deliberately omit userId. Its first registrant is not the event actor.
      // Resolve the owner only after authenticating the exact sandbox/generation grant.
      const machines = await options.sql.query<{
        org_id: string;
        owner_id: string;
        visibility: Scope["visibility"];
        record: { launchUserId?: string; generation: number };
      }>("select org_id,owner_id,visibility,record from public.modal_machines where scope=$1 and id=$2 and org_id=$3", [
        scopeKey(scope),
        verified.claims.sandboxId,
        scope.orgId,
      ]);
      const machine = machines.rows[0];
      if (
        !machine ||
        String(machine.record.generation) !== verified.claims.generation ||
        (machine.record.launchUserId !== undefined && machine.record.launchUserId !== machine.owner_id)
      )
        throw new VaultError("forbidden", "Runner machine ownership or generation does not match.");
      const actualScope: Scope = {
        ...scope,
        orgId: machine.org_id,
        userId: machine.owner_id,
        visibility: machine.visibility,
      };
      if (scopeKey(actualScope) !== scopeKey(scope))
        throw new VaultError("forbidden", "Runner machine scope does not match.");
      // appendModalEvents rechecks this actual owner's membership and generation under its SQL lock.
      return { claims: verified.claims, scope: actualScope };
    },
  });
  async function managementAuthority(
    target: ProviderTarget,
    caller: { userId: string },
  ): Promise<ModalManagementAuthority> {
    if (!target.modal) throw new VaultError("invalid", "Modal binding is missing.");
    const result = await options.sql.query<{ authority_scope: "org" | "user"; authority_owner_id: string }>(
      "select authority_scope,authority_owner_id from public.modal_server_apps where org_id=$1 and app_id=$2 and environment=$3",
      [target.orgId, target.modal.appId, target.modal.environment],
    );
    const saved = result.rows[0];
    if (!saved) throw new VaultError("unavailable", "Modal credential provenance is not registered.");
    const sourceVisibility = target.sourceGoldenVisibility ?? target.visibility;
    if (
      saved.authority_scope === "org"
        ? saved.authority_owner_id !== target.orgId
        : saved.authority_owner_id !== caller.userId || sourceVisibility !== "private"
    )
      throw new VaultError("forbidden", "Modal credential authority does not match this resource.");
    return {
      orgId: target.orgId,
      sourceGoldenVisibility: sourceVisibility,
      credentialScope: saved.authority_scope,
      credentialOwnerId: saved.authority_owner_id,
      binding: target.modal,
    };
  }
  async function resolveManagementCredentials(
    authority: ModalManagementAuthority,
  ): Promise<ResolvedModalManagementCredentials> {
    const row = (await options.vault.credentials(authority.credentialScope, authority.credentialOwnerId)).find(
      (candidate) => candidate.kind === "modal",
    );
    if (!row)
      throw new VaultError(
        "missing_credential",
        "The Modal credential bound to this resource was removed. Restore that credential slot.",
      );
    const value = await decryptSecret(new Uint8Array(row.valueEnc), options.encryptionKey);
    try {
      return {
        ...parseModalTokenPair(value),
        credentialScope: authority.credentialScope,
        credentialOwnerId: authority.credentialOwnerId,
      };
    } catch {
      throw new VaultError("unavailable", "The bound Modal credential is invalid. Replace that credential slot.");
    }
  }
  const modalTokensFor: NonNullable<HandlerOptions["modalTokensFor"]> = async (target, caller) => {
    const authority = await managementAuthority(target, caller);
    const pair = await resolveManagementCredentials(authority);
    return { tokenId: pair.tokenId, tokenSecret: pair.tokenSecret, scope: authority.credentialScope };
  };
  const modalProviderFor = async (
    tokens: Parameters<NonNullable<HandlerOptions["modalProviderFor"]>>[0],
    binding: Parameters<NonNullable<HandlerOptions["modalProviderFor"]>>[1],
    context: Parameters<NonNullable<HandlerOptions["modalProviderFor"]>>[2],
    storedReads = false,
  ): Promise<Provider> => {
    const authority = await options.sql.query<{ app_name: string }>(
      "select app_name from public.modal_server_apps where org_id=$1 and app_id=$2 and environment=$3",
      [context.target.orgId, binding.appId, binding.environment],
    );
    const appName = authority.rows[0]?.app_name;
    if (!appName) throw new Error("Modal App binding is not registered on this server.");
    const scope: Scope = {
      orgId: context.target.orgId,
      userId: context.caller.userId,
      visibility: context.target.visibility,
      binding,
      ...(context.caller.orchestratorCleanup ? { cleanup: context.caller.orchestratorCleanup } : {}),
    };
    if (!storedReads)
      await options.sql.query(
        "insert into public.modal_server_scopes(scope,context) values($1,$2::jsonb) on conflict(scope) do nothing",
        [scopeKey(scope), JSON.stringify({ ...scope, cleanup: undefined })],
      );
    const provenance = await managementAuthority(context.target, context.caller);
    const sourceScope: Scope = { ...scope, visibility: provenance.sourceGoldenVisibility };
    const composed: ComposedModalOptions = {
      storedReads,
      sql: options.sql,
      scope,
      sourceScope,
      managementAuthority: {
        credentialScope: provenance.credentialScope,
        credentialOwnerId: provenance.credentialOwnerId,
      },
      resolveManagementCredentials,
      ...tokens,
      appName,
      signingKey: key,
      ingestUrl,
      artifact,
      ...(options.beforeResume
        ? {
            beforeResume: (provider: Provider, sandboxId: string) =>
              options.beforeResume!(provider, sandboxId, {
                userId: context.caller.userId,
                orgId: context.target.orgId,
              }),
          }
        : {}),
      ...(options.beforePrompt
        ? {
            beforePrompt: (provider, sandboxId) =>
              options.beforePrompt!(provider, sandboxId, {
                userId: context.caller.userId,
                orgId: context.target.orgId,
              }),
          }
        : {}),
      resolveHarnessEnvironment: modalLaunchEnvironment({
        modelAuth,
        sql: options.sql,
        vault: options.vault,
        encryptionKey: options.encryptionKey,
        scope,
        scopeKey: scopeKey(scope),
        callerUserId: context.caller.userId,
        ...(options.github ? { github: options.github } : {}),
      }),
    };
    return (await createComposedModalProvider(composed)).provider;
  };
  async function goldenTarget(
    target: Omit<ProviderTarget, "modal">,
    caller: { userId: string },
  ): Promise<ProviderTarget> {
    if (target.provider === "boat") return { ...target, modal: null };
    const resolved = await resolveModalTokens(options.vault, options.encryptionKey, {
      ...caller,
      orgId: target.orgId,
      visibility: target.visibility,
    });
    const owner = resolved.scope === "org" ? target.orgId : caller.userId;
    const appName = `armada-${resolved.scope}-${owner.replaceAll("-", "")}`;
    const environment = "main";
    const client = new ModalClient({ tokenId: resolved.tokenId, tokenSecret: resolved.tokenSecret });
    try {
      const app = await client.apps.fromName(appName, { environment, createIfMissing: true });
      const modal: ModalBinding = { workspace: `app:${app.appId}`, environment, appId: app.appId };
      await options.sql.query(
        "insert into public.modal_server_apps(org_id,authority,app_name,app_id,environment,authority_scope,authority_owner_id) values($1,$2,$3,$4,$5,$6,$7) on conflict(org_id,authority,environment) do nothing",
        [target.orgId, `${resolved.scope}:${owner}`, appName, app.appId, environment, resolved.scope, owner],
      );
      const stored = await options.sql.query<{ app_id: string }>(
        "select app_id from public.modal_server_apps where org_id=$1 and authority=$2 and environment=$3",
        [target.orgId, `${resolved.scope}:${owner}`, environment],
      );
      if (stored.rows[0]?.app_id !== app.appId)
        throw new Error("Modal credentials cannot replace the immutable App binding.");
      return { ...target, modal };
    } finally {
      await client.close();
    }
  }
  return {
    modalProviderFor,
    storedProviderFor: async (target: ProviderTarget, caller: { userId: string }) => {
      if (target.provider !== "modal" || !target.modal) throw new VaultError("invalid", "Expected Modal binding.");
      const tokens = await modalTokensFor(target, caller);
      const provider = await modalProviderFor(
        // The resolver's scope label is not the structured machine Scope.
        // Pass only the token pair, exactly as the live registry does.
        { tokenId: tokens.tokenId, tokenSecret: tokens.tokenSecret },
        target.modal,
        { target, caller, credentialScope: tokens.scope },
        true,
      );
      // Do not let a stored observation adapter accidentally drive admission.
      const reads = new Set<PropertyKey>(["get", "getPrompt", "events"]);
      return new Proxy(provider, {
        get(object, property, receiver) {
          const value = Reflect.get(object, property, receiver);
          if (typeof value === "function" && !reads.has(property))
            return () => {
              throw new VaultError("forbidden", "Stored observations cannot perform live operations.");
            };
          return value;
        },
      });
    },
    modalTokensFor,
    goldenTarget,
    route: async (request: Request) => (new URL(request.url).pathname === MODAL_INGEST_PATH ? ingest(request) : null),
  };
}
