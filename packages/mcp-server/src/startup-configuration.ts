import { readBoatRuntimeManifest } from "./boat-runtime-manifest.ts";
import { configFromEnv } from "./config.ts";
import { idlePauseDelayMs } from "./idle-pause-policy.ts";
import { invitationMailFromEnv } from "./invitations.ts";
import { catalogAuthenticationFromEnv } from "./mcp-catalog-client.ts";
import { runtimeArtifactSet } from "./runtime-artifacts.ts";
import { scriptedModelRoute } from "./scripted-model.ts";
import { ServerConfigError } from "./server-config-error.ts";
import { bunSql } from "./sql.ts";

async function readManifest(path: string | undefined, name: string) {
  if (!path?.trim()) throw new ServerConfigError(`Set ${name}.`);
  const manifest = await Bun.file(path)
    .json()
    .catch(() => undefined);
  if (
    manifest?.protocol !== 1 ||
    manifest.platform !== "linux" ||
    manifest.libc !== "glibc" ||
    !["x64", "arm64"].includes(manifest.architecture)
  )
    throw new ServerConfigError(`${name} must point to a valid installed runtime manifest.`);
  return manifest;
}

export async function readStartupConfiguration(env: Record<string, string | undefined>) {
  const config = configFromEnv(env);
  const scriptedModel = await scriptedModelRoute(env, config).catch(() => {
    throw new ServerConfigError("Check ARMADA_SCRIPTED_MODEL and ARMADA_SCRIPTED_MODEL_BEARER_ENC.");
  });
  const idleDelayMs = idlePauseDelayMs(env);
  const catalogAuthentication = catalogAuthenticationFromEnv(
    env,
    config.encryptionKey,
    config.dashboardUrl,
    config.development,
  );
  await catalogAuthentication("slack").catch(() => {
    throw new ServerConfigError("Invalid ARMADA_SLACK_MCP_CLIENT_ENC registration.");
  });

  const boat = await readBoatRuntimeManifest(
    env.ARMADA_BOAT_RUNTIME_MANIFEST ?? `/opt/armada/runtime-manifests/${process.arch}.json`,
    env.ARMADA_RUNTIME_ARTIFACT_DIR,
  );

  const manifest = await readManifest(env.ARMADA_MODAL_RUNTIME_MANIFEST, "ARMADA_MODAL_RUNTIME_MANIFEST");
  if (!runtimeArtifactSet(manifest))
    throw new ServerConfigError("ARMADA_MODAL_RUNTIME_MANIFEST must describe a valid runtime artifact set.");
  const artifactDir = env.ARMADA_RUNTIME_ARTIFACT_DIR;
  if (!artifactDir?.trim()) throw new ServerConfigError("Set ARMADA_RUNTIME_ARTIFACT_DIR.");
  const modalRuntime = { manifest, artifactDir };

  const dockerManifest =
    env.ARMADA_DOCKER_HOSTS === "1" && env.ARMADA_DOCKER_PLACEMENT === "1"
      ? await readManifest(env.ARMADA_DOCKER_RUNTIME_MANIFEST, "ARMADA_DOCKER_RUNTIME_MANIFEST")
      : undefined;
  const invitationMail = invitationMailFromEnv(env);
  let sql: ReturnType<typeof bunSql>;
  try {
    sql = bunSql(config.databaseUrl, config.databasePoolMax);
  } catch {
    throw new ServerConfigError("ARMADA_DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  return {
    config,
    sql,
    scriptedModel,
    idleDelayMs,
    catalogAuthentication,
    invitationMail,
    boat,
    modalRuntime,
    dockerManifest,
  };
}
