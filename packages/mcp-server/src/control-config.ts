import { createSqlAuthStore } from "@armada/auth";
import {
  createApplicationVault,
  createGoldenAdoption,
  createRoutineService,
  createSkillDefaultsService,
  createSqlMcpLaunchPort,
  createSqlMcpRegistry,
  createSqlVaultStore,
  createTemplateService,
  ENCRYPTION_KEY_ENV,
  GoldenBuildJobs,
  githubAppFromEnv,
  githubInstallationAppFromEnv,
} from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { databasePoolMax } from "./config.ts";
import type { ConfiguredControlOptions } from "./control.ts";
import { createCredentialBindingRecovery } from "./credential-binding-recovery.ts";
import { createSqlData } from "./data.ts";
import { providerRegistry } from "./http.ts";
import { invitationsFromEnv } from "./invitations.ts";
import { launchCredentials } from "./launch-credentials.ts";
import { catalogAuthenticationFromEnv } from "./mcp-catalog-client.ts";
import { createMcpLifecycle } from "./mcp-lifecycle.ts";
import { createHistoricalSandboxProviderResolver } from "./mcp-sandbox-provider.ts";
import { createModalIntegration } from "./modal-integration.ts";
import { createModelAuthOwnership } from "./model-auth.ts";
import { createModelUsageApi } from "./model-usage.ts";
import { createProviderMetadata } from "./provider-metadata.ts";
import { createSandboxAccountChange } from "./sandbox-account-change.ts";
import { createSandboxBillingAccount } from "./sandbox-billing-account.ts";
import { bunSql } from "./sql.ts";
import { createSubscriptionMigration } from "./subscription-migration.ts";

/**
 * Wires the control API from the environment: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
 * `ARMADA_DATABASE_URL` (a privileged Postgres connection string, the Supabase `postgres` role)
 * and `ARMADA_ENCRYPTION_KEY`.
 */
export function controlOptionsFromEnv(env: Record<string, string | undefined>): ConfiguredControlOptions {
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Set ${name}.`);
    return value;
  };
  // Share the server adapter and its validated pool budget, including transaction support.
  const sql = bunSql(need("ARMADA_DATABASE_URL"), databasePoolMax(env.ARMADA_DATABASE_POOL_MAX));
  const encryptionKey = need(ENCRYPTION_KEY_ENV);
  const githubApp = githubAppFromEnv(env);
  const store = createSqlVaultStore(sql);
  const authStore = createSqlAuthStore(sql);
  const supabaseUrl = need("SUPABASE_URL");
  const anonKey = need("SUPABASE_ANON_KEY");
  const registry = createSqlMcpRegistry(sql, encryptionKey, {
    catalogAuthentication: catalogAuthenticationFromEnv(
      env,
      encryptionKey,
      env.ARMADA_DASHBOARD_URL,
      env.NODE_ENV === "development",
    ),
  });
  const templates = createTemplateService(sql, encryptionKey);
  const lifecycle = () =>
    createMcpLifecycle({
      sql,
      registry,
      encryptionKey,
      origin: need("ARMADA_PUBLIC_URL"),
      prepareReadableVariables: templates.prepare,
    });
  const providerFor = (apiKey: string, caller?: { userId: string; orgId: string }) =>
    createBoatProvider({
      apiKey,
      beforePrompt: async (provider, id) => {
        if (caller) await lifecycle().beforePrompt(provider, id, caller);
      },
    });
  let modal: ReturnType<typeof createModalIntegration> | undefined;
  const modalIntegration = () =>
    (modal ??= createModalIntegration({
      sql,
      vault: store,
      encryptionKey,
      publicUrl: need("ARMADA_PUBLIC_URL"),
      github: { store, app: githubApp },
      beforePrompt: async (provider, id, caller) => {
        await lifecycle().beforePrompt(provider, id, caller);
      },
    }));
  const providers = providerRegistry({
    vault: store,
    encryptionKey,
    providerFor,
    modalTokensFor: async (target, caller) => (await modalIntegration()).modalTokensFor(target, caller),
    modalProviderFor: async (tokens, binding, context) =>
      (await modalIntegration()).modalProviderFor(tokens, binding, context),
  });
  let subscriptionMigration: ReturnType<typeof createSubscriptionMigration>;
  const modelAuth = createModelAuthOwnership(
    sql,
    encryptionKey,
    undefined,
    undefined,
    env.ARMADA_PUBLIC_URL
      ? {
          origin: env.ARMADA_PUBLIC_URL,
          prepareAccount: (actor, id, version) => subscriptionMigration.prepareAccount(actor, id, version),
          prepareTurn: (provider, id, caller) => subscriptionMigration.prepareTurn(provider, id, caller),
        }
      : undefined,
  );
  if (modelAuth.broker)
    subscriptionMigration = createSubscriptionMigration(
      sql,
      createHistoricalSandboxProviderResolver(providers),
      (provider, id, caller, quiesced) => modelAuth.capture(provider, id, caller, quiesced),
      modelAuth.broker,
    );
  return {
    ...(env.ARMADA_PUBLIC_URL ? { publicUrl: env.ARMADA_PUBLIC_URL } : {}),
    sandboxBillingAccount: createSandboxBillingAccount(sql),
    credentialBindingRecovery: createSandboxAccountChange(
      sql,
      launchCredentials(store, encryptionKey, undefined, modelAuth),
      createCredentialBindingRecovery(sql, encryptionKey),
    ),
    invitations: invitationsFromEnv(sql, env),
    templates,
    skillDefaults: createSkillDefaultsService(sql),
    routines: createRoutineService(sql),
    applicationVault: createApplicationVault(sql, encryptionKey),
    mcp: { registry },
    connections: createSqlMcpLaunchPort(sql, registry),
    authStore,
    supabase: { supabaseUrl, anonKey },
    encryptionKey,
    github: { app: githubApp },
    store,
    modelAuth,
    providerFor,
    modelUsage: createModelUsageApi(sql),
    goldenAdoption: createGoldenAdoption(sql),
    providers,
    storedProviderFor: async (target, caller) => (await modalIntegration()).storedProviderFor(target, caller),
    data: createSqlData(sql),
    providerMetadata: createProviderMetadata({ sql, vault: store, encryptionKey, providerFor }),
    goldenTarget: async (target, caller) =>
      target.provider === "boat" ? { ...target, modal: null } : (await modalIntegration()).goldenTarget(target, caller),
    goldenBuilds: new GoldenBuildJobs({
      sql,
      encryptionKey,
      service: {
        github: { store, encryptionKey, app: githubApp },
        installationApp: githubInstallationAppFromEnv(env),
      },
      provider: (actor, _visibility, target) => providers.resolve(target, { userId: actor.userId }),
    }),
  };
}
