import {
  DEFAULT_LAUNCH_TTL_SECONDS,
  HARNESS_KINDS,
  HARNESSES,
  type LaunchProviderCapabilities,
  type LaunchProviderOption,
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

/** Normal-control support, not authorization or provider account health. Docker's
 * normal operations remain dark until their handler is actually supplied.
 */
export function launchProviderOptions(
  docker: {
    hosts?: boolean;
    placement?: boolean;
    normalApi?: boolean;
    normalLaunch?: boolean;
    normalSend?: boolean;
    normalResume?: boolean;
  } = {},
): LaunchProviderOption[] {
  const supported: LaunchProviderCapabilities = {
    launch: true,
    status: true,
    logs: true,
    followupPrompts: true,
    stop: true,
    delete: true,
    resume: true,
    goldens: true,
    repositories: true,
    machineSizes: true,
    github: true,
    mcp: true,
    skills: true,
    exec: true,
    steer: true,
    interrupt: true,
  };
  const hosts = docker.hosts === true;
  const normal = hosts && docker.normalApi === true;
  const capabilities: LaunchProviderCapabilities = {
    launch: normal && docker.normalLaunch === true && docker.placement === true,
    status: normal,
    logs: normal,
    followupPrompts: normal && docker.normalSend === true && docker.placement === true,
    stop: normal,
    delete: normal,
    resume: normal && docker.normalResume === true && docker.placement === true,
    goldens: false,
    repositories: false,
    machineSizes: false,
    github: false,
    mcp: normal && docker.normalLaunch === true && docker.placement === true,
    skills: normal && docker.normalLaunch === true && docker.placement === true,
    exec: false,
    steer: false,
    interrupt: false,
  };
  const unsupportedReasons: LaunchProviderOption["unsupportedReasons"] = {};
  const reasons: Record<keyof LaunchProviderCapabilities, string> = {
    launch: "New Docker placement is disabled or not installed on this server.",
    status: "Normal Docker status is not available on this server.",
    logs: "Normal Docker conversation logs are not available on this server.",
    followupPrompts: "Docker follow-up prompts are not available through normal sandbox control yet.",
    stop: "Normal Docker stop is not available on this server.",
    delete: "Normal Docker delete is not available on this server.",
    resume: "Docker resume is not available yet.",
    goldens: "Docker currently launches from a plain image, not a golden.",
    repositories: "Docker plain-image launches do not select a repository.",
    machineSizes: "Docker host machine sizing is not available yet.",
    github: "Docker GitHub setup is not available yet.",
    mcp: "Docker MCP connections are not available yet.",
    skills: "Docker skill installation is not available yet.",
    exec: "Docker exec is not available yet.",
    steer: "Docker steering is not available yet.",
    interrupt: "Docker turn interruption is not available yet.",
  };
  for (const name of Object.keys(capabilities) as (keyof typeof capabilities)[]) {
    if (!capabilities[name])
      unsupportedReasons[name] = !hosts
        ? "Docker hosts are not enabled on this server."
        : name === "launch" || name === "stop" || name === "delete"
          ? normal
            ? "Normal Docker launch is disabled or not installed on this server."
            : "Normal Docker sandbox control is not available on this server."
          : reasons[name];
  }
  return [
    {
      id: "boat",
      enabled: true,
      launchSources: ["golden"],
      harnesses: ["claude", "codex"],
      capabilities: { ...supported },
      unsupportedReasons: {},
    },
    {
      id: "modal",
      enabled: true,
      launchSources: ["golden"],
      harnesses: [...HARNESSES],
      capabilities: { ...supported },
      unsupportedReasons: {},
    },
    {
      id: "docker",
      enabled: hosts,
      launchSources: ["image"],
      harnesses: ["codex", "claude", "opencode"],
      capabilities,
      unsupportedReasons,
    },
  ];
}
