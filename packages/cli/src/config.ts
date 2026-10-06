import { type ArmadaConfig, deployEnvName, machinePaths, updateDeployEnv } from "@armada/core";
import { type Io, UsageError } from "./io.ts";

export async function configCommand(
  io: Io,
  config: ArmadaConfig,
  args: { rest: string[]; json: boolean },
): Promise<number> {
  const [action, key, value, ...extra] = args.rest;
  const name = key?.startsWith("deploy.env.") ? key.slice("deploy.env.".length) : "";
  if (
    !deployEnvName(name) ||
    extra.length ||
    (action === "set" ? value === undefined : action !== "unset" || value !== undefined)
  )
    throw new UsageError("use armada config set deploy.env.<VAR> <value> or armada config unset deploy.env.<VAR>");
  const paths = machinePaths(io.env);
  if (!paths) throw new UsageError("machine settings need HOME or XDG_CONFIG_HOME");
  await updateDeployEnv(paths, config.project.slug, name, action === "set" ? (value as string) : null);
  io.stdout(
    args.json
      ? `${JSON.stringify({ project: config.project.slug, key, action })}\n`
      : `${key} ${action === "set" ? "set" : "unset"} for ${config.project.slug} on this machine.\n`,
  );
  return 0;
}
