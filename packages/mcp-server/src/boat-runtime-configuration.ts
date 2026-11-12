import {
  CODEX_AUTH_ENV,
  CODEX_ENDPOINT_ENV,
  type GoldenActor,
  type HarnessCredentials,
  parseCodexEndpoint,
  type SandboxRecord,
} from "@armada/core";
import { VaultError } from "@armada/core/server";
import type { ModelAuthOwnership } from "./model-auth.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const allowed = new Set(["OPENAI_API_KEY", CODEX_ENDPOINT_ENV, CODEX_AUTH_ENV, "ARMADA_SERVER_CODEX"]);

/** Project an ALREADY authorized launch/account pin. Not an account resolver or public DTO.
 * The caller holds launch admission and must send configuration only via encrypted enrolment.
 */
export async function boatRuntimeConfiguration(input: {
  actor: GoldenActor;
  sandbox: SandboxRecord;
  credentials: HarnessCredentials;
  manifest: unknown;
  architecture: "x64" | "arm64";
  modelAuth?: { state: Pick<ModelAuthOwnership["state"], "read"> };
}) {
  try {
    const actor = { ...input.actor };
    const sandbox = { ...input.sandbox };
    const credentials = { ...input.credentials, env: { ...input.credentials.env } };
    const modelAuth = input.modelAuth;
    const binding = input.credentials.binding ? { ...input.credentials.binding } : undefined;
    const expiresAt = Date.parse(sandbox.expiresAt ?? "");
    if (
      sandbox.provider !== "boat" ||
      sandbox.harness !== "codex" ||
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
      Object.keys(credentials.env).some((key) => !allowed.has(key))
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
      !record(manifest.harnesses.codex) ||
      !Array.isArray(manifest.harnesses.codex.files) ||
      !manifest.harnesses.codex.files.length
    )
      throw Error();
    const codexEnv: Record<string, string> = { HOME: "/home/user", PATH: "/usr/local/bin:/usr/bin:/bin" };
    let auth: {
      codexAuthJson?: string;
      nativeAuthRevision?: number;
      nativeAuthSecrets?: string[];
    } = {};
    const key = credentials.env.OPENAI_API_KEY;
    const endpoint = credentials.env[CODEX_ENDPOINT_ENV];
    const rawAuth = credentials.env[CODEX_AUTH_ENV];
    const serverAuth = credentials.env.ARMADA_SERVER_CODEX;
    if (credentials.codexAuthJson) {
      if (key || endpoint || !modelAuth) throw Error();
      // Read canonical ownership even when no broker is configured: server-owned
      // state must never be downgraded to a raw refresh-token file.
      if (serverAuth || !rawAuth) throw Error();
      const native = await modelAuth.state.read(actor, binding.credentialId, binding.credentialVersion, sandbox.id);
      if (native?.sourceGeneration.startsWith("server:")) throw Error();
      auth = {
        codexAuthJson: native?.authJson ?? rawAuth,
        nativeAuthRevision: native?.revision ?? 0,
        nativeAuthSecrets: [...(native?.secrets ?? [])],
      };
    } else {
      if (!key || rawAuth || serverAuth) throw Error();
      codexEnv.OPENAI_API_KEY = key;
      if (endpoint) codexEnv[CODEX_ENDPOINT_ENV] = JSON.stringify(parseCodexEndpoint(JSON.parse(endpoint)));
    }
    return {
      artifact: { sha256: manifest.runtime.sha256, bytes: manifest.runtime.bytes as number },
      cacheDir: "/home/user/.armada-runtime-bootstrap",
      configuration: {
        selectedHarness: "codex" as const,
        artifactManifest: manifest,
        root: `/home/user/.armada-runtime/${sandbox.id}`,
        cwd: repo === null ? "/home/user" : `/home/user/${repo}`,
        // Enrolment replaces the token/identity/epoch. Only logical expiry is supplied here.
        grant: { expiresAt },
        claudeExecutable: "",
        codexExecutable: "",
        claudeEnv: {},
        codexEnv,
        ...auth,
      },
    };
  } catch {
    // Native-state/endpoint parsing errors must not expose decrypted credentials.
    throw new VaultError("unavailable", "Boat runtime configuration is unavailable.");
  }
}
