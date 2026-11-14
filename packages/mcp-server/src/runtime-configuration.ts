import {
  CLAUDE_ENDPOINT_ENV,
  CODEX_AUTH_ENV,
  CODEX_ENDPOINT_ENV,
  type GoldenActor,
  type HarnessCredentials,
  OPENCODE_ENDPOINT_ENV,
  parseClaudeEndpoint,
  parseCodexEndpoint,
  parseOpenCodeEndpoint,
  isRecord as record,
  type SandboxRecord,
} from "@armada/core";
import { VaultError } from "@armada/core/server";
import type { ModelAuthOwnership } from "./model-auth.ts";

const claudeAllowed = new Set(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", CLAUDE_ENDPOINT_ENV]);
const opencodeAllowed = new Set(["OPENCODE_API_KEY", OPENCODE_ENDPOINT_ENV]);
const codexAllowed = new Set(["OPENAI_API_KEY", CODEX_ENDPOINT_ENV, CODEX_AUTH_ENV, "ARMADA_SERVER_CODEX"]);

/** Only metadata consumed by the private harness projection, without a provider DTO or golden. */
export type RuntimeConfigurationTarget = Pick<
  SandboxRecord,
  | "id"
  | "ownerId"
  | "orgId"
  | "harness"
  | "status"
  | "deletedAt"
  | "stopRequestedAt"
  | "expiresAt"
  | "credentialId"
  | "credentialVersion"
  | "repositoryDir"
  | "visibility"
> & { provider: string };

export interface RuntimeConfigurationInput {
  actor: GoldenActor;
  sandbox: RuntimeConfigurationTarget;
  credentials: HarnessCredentials;
  manifest: unknown;
  architecture: "x64" | "arm64";
  modelAuth?: {
    state: Pick<ModelAuthOwnership["state"], "read">;
    broker?: Pick<NonNullable<ModelAuthOwnership["broker"]>, "access"> | undefined;
  };
}

/** Project an ALREADY authorized launch/account pin. Not an account resolver or public DTO.
 * The caller holds launch admission and must send configuration only via encrypted enrolment.
 */
export async function runtimeConfiguration(
  input: RuntimeConfigurationInput,
  expectedProvider: "boat" | "docker" | "modal",
  emptyMcpRevision?: string,
) {
  try {
    if (expectedProvider !== "boat" && expectedProvider !== "docker" && expectedProvider !== "modal") throw Error();
    const actor = { ...input.actor };
    const sandbox = { ...input.sandbox };
    const credentials = { ...input.credentials, env: { ...input.credentials.env } };
    const modelAuth = input.modelAuth;
    const binding = input.credentials.binding ? { ...input.credentials.binding } : undefined;
    const expiresAt = Date.parse(sandbox.expiresAt ?? "");
    if (
      sandbox.provider !== expectedProvider ||
      (expectedProvider === "docker" && (sandbox.visibility !== "private" || sandbox.repositoryDir !== null)) ||
      (sandbox.harness !== "codex" &&
        sandbox.harness !== "claude" &&
        !(expectedProvider === "docker" && sandbox.harness === "opencode")) ||
      sandbox.ownerId !== actor.userId ||
      sandbox.orgId !== actor.orgId ||
      !["starting", "ready", "running"].includes(sandbox.status) ||
      sandbox.deletedAt ||
      sandbox.stopRequestedAt ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(sandbox.id) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() ||
      !binding ||
      !Number.isSafeInteger(binding.credentialVersion) ||
      binding.credentialVersion < 1 ||
      binding.credentialId !== sandbox.credentialId ||
      binding.credentialVersion !== sandbox.credentialVersion ||
      Object.keys(credentials.env).some(
        (key) =>
          !(
            sandbox.harness === "claude"
              ? claudeAllowed
              : sandbox.harness === "opencode"
                ? opencodeAllowed
                : codexAllowed
          ).has(key),
      )
    )
      throw Error();
    const repo = sandbox.repositoryDir;
    if (repo !== null && (!repo || repo === "." || repo === ".." || /[/\\\0]/.test(repo))) throw Error();
    const manifest: unknown = structuredClone(input.manifest);
    if (
      !record(manifest) ||
      manifest.protocol !== 1 ||
      manifest.platform !== "linux" ||
      manifest.libc !== "glibc" ||
      !["x64", "arm64"].includes(input.architecture) ||
      manifest.architecture !== input.architecture ||
      !record(manifest.runtime) ||
      typeof manifest.runtime.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(manifest.runtime.sha256) ||
      !Number.isSafeInteger(manifest.runtime.bytes) ||
      (manifest.runtime.bytes as number) < 1 ||
      (manifest.runtime.bytes as number) > 512 * 1024 * 1024 ||
      !record(manifest.harnesses) ||
      (sandbox.harness !== "opencode" && !record(manifest.harnesses[sandbox.harness]))
    )
      throw Error();
    const harnessArtifact = manifest.harnesses[sandbox.harness];
    if (
      sandbox.harness !== "opencode" &&
      (!record(harnessArtifact) || !Array.isArray(harnessArtifact.files) || !harnessArtifact.files.length)
    )
      throw Error();
    const codexEnv: Record<string, string> = { HOME: "/home/user", PATH: "/usr/local/bin:/usr/bin:/bin" };
    const opencodeEnv: Record<string, string> = { HOME: "/home/user", PATH: "/usr/local/bin:/usr/bin:/bin" };
    const claudeEnv: Record<string, string> = { HOME: "/home/user", PATH: "/usr/local/bin:/usr/bin:/bin" };
    let auth: {
      runtimeSubscription?: true;
      codexAuthJson?: string;
      nativeAuthRevision?: number;
      nativeAuthSecrets?: string[];
    } = {};
    const key = credentials.env.OPENAI_API_KEY;
    const endpoint = credentials.env[CODEX_ENDPOINT_ENV];
    const rawAuth = credentials.env[CODEX_AUTH_ENV];
    const serverAuth = credentials.env.ARMADA_SERVER_CODEX;
    if (sandbox.harness === "claude") {
      const apiKey = credentials.env.ANTHROPIC_API_KEY;
      const token = credentials.env.CLAUDE_CODE_OAUTH_TOKEN;
      const endpoint = credentials.env[CLAUDE_ENDPOINT_ENV];
      if (!apiKey === !token || credentials.codexAuthJson || (endpoint && !apiKey)) throw Error();
      if (apiKey) claudeEnv.ANTHROPIC_API_KEY = apiKey;
      if (token) claudeEnv.CLAUDE_CODE_OAUTH_TOKEN = token;
      if (endpoint) claudeEnv[CLAUDE_ENDPOINT_ENV] = JSON.stringify(parseClaudeEndpoint(JSON.parse(endpoint)));
    } else if (sandbox.harness === "opencode") {
      if (!credentials.env.OPENCODE_API_KEY || credentials.codexAuthJson) throw Error();
      opencodeEnv.OPENCODE_API_KEY = credentials.env.OPENCODE_API_KEY;
      const endpoint = credentials.env[OPENCODE_ENDPOINT_ENV];
      if (endpoint) opencodeEnv[OPENCODE_ENDPOINT_ENV] = JSON.stringify(parseOpenCodeEndpoint(JSON.parse(endpoint)));
    } else if (credentials.codexAuthJson) {
      if (key || endpoint || !modelAuth) throw Error();
      const native = await modelAuth.state.read(actor, binding.credentialId, binding.credentialVersion, sandbox.id);
      if (native?.sourceGeneration.startsWith("server:")) {
        if (!modelAuth.broker) throw Error();
        // Access-only material is fetched by the current runtime token/epoch,
        // never via a stable capability or a refresh-token auth.json export.
        auth = { runtimeSubscription: true };
      } else {
        if (serverAuth || !rawAuth) throw Error();
        auth = {
          codexAuthJson: native?.authJson ?? rawAuth,
          nativeAuthRevision: native?.revision ?? 0,
          nativeAuthSecrets: [...(native?.secrets ?? [])],
        };
      }
    } else {
      if (!key || rawAuth || serverAuth) throw Error();
      codexEnv.OPENAI_API_KEY = key;
      if (endpoint) codexEnv[CODEX_ENDPOINT_ENV] = JSON.stringify(parseCodexEndpoint(JSON.parse(endpoint)));
    }
    return {
      artifact: { sha256: manifest.runtime.sha256, bytes: manifest.runtime.bytes as number },
      cacheDir: "/home/user/.armada-runtime-bootstrap",
      configuration: {
        selectedHarness: sandbox.harness,
        execEnv: { HOME: "/home/user", PATH: "/usr/local/bin:/usr/bin:/bin" },
        artifactManifest: manifest,
        root: `/home/user/.armada-runtime/${sandbox.id}`,
        cwd: repo === null ? "/home/user" : `/home/user/${repo}`,
        // Enrolment replaces the token/identity/epoch. Only logical expiry is supplied here.
        grant: { expiresAt },
        claudeExecutable: "",
        codexExecutable: "",
        claudeEnv: sandbox.harness === "claude" ? claudeEnv : {},
        codexEnv,
        opencodeEnv: sandbox.harness === "opencode" ? opencodeEnv : {},
        // Retained sessions must not revive upstream defaults before current-epoch delivery.
        ...(emptyMcpRevision ? { mcp: { revision: emptyMcpRevision, servers: {} } } : {}),
        ...auth,
      },
    };
  } catch {
    // Native-state/endpoint parsing errors must not expose decrypted credentials.
    throw new VaultError(
      "unavailable",
      expectedProvider === "boat"
        ? "Boat runtime configuration is unavailable."
        : expectedProvider === "docker"
          ? "Docker runtime configuration is unavailable."
          : "Runtime configuration is unavailable.",
    );
  }
}
