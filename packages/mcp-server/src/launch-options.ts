import {
  DEFAULT_LAUNCH_TTL_SECONDS,
  HARNESS_KINDS,
  HARNESSES,
  MACHINE_SIZES,
  MODEL_CATALOG,
  PROVIDER_LIMITS,
  SANDBOX_PROVIDERS,
} from "@armada/core";

/**
 * `POST /api/v1/launch/options`: what a launch may choose, read from the server's own catalogs so an API-only client
 * (the iOS app) offers exactly these and keeps no list of its own. Static: no database or provider call, nothing
 * secret. The goldens and the model accounts a person can use come from `golden/list` and `creds/list`; the launch
 * itself still validates every field.
 */
export const launchOptions = {
  harnesses: HARNESSES.map((id) => ({
    id,
    defaultModel: MODEL_CATALOG[id].defaultModel,
    defaultReasoningEffort: MODEL_CATALOG[id].defaultReasoningEffort,
    reasoningEfforts: MODEL_CATALOG[id].reasoningEfforts,
    models: MODEL_CATALOG[id].models,
    /** The credential kinds this harness runs on, to match `creds/list` rows to a harness. */
    credentialKinds: HARNESS_KINDS[id],
  })),
  machineSizes: MACHINE_SIZES,
  ttl: {
    defaultSeconds: DEFAULT_LAUNCH_TTL_SECONDS,
    maxSeconds: Object.fromEntries(
      SANDBOX_PROVIDERS.map((provider) => [provider, PROVIDER_LIMITS[provider].maxTtlSeconds]),
    ),
  },
} as const;
