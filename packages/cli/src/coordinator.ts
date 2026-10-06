import { resolve } from "node:path";
import {
  type ArmadaConfig,
  COORDINATOR,
  type Credentials,
  machinePaths,
  Refusal,
  readCoordinatorName,
  writeCoordinatorName,
} from "@armada/core";
import { type Io, UsageError } from "./io.ts";
import { requireSignIn } from "./login.ts";
import { detectCoordinator } from "./presence.ts";
import { liveFleet } from "./worker.ts";

export function validCoordinator(name: string): string {
  if (!COORDINATOR.test(name))
    throw new UsageError(
      "a coordinator name needs 1 to 32 lowercase letters, digits or hyphens, starting with a letter or digit",
    );
  return name;
}

/** Environment, this project's checkout preference, then the backward-compatible default. */
export async function coordinatorName(io: Io, project: string, root = io.coordinatorRoot ?? io.cwd): Promise<string> {
  const env = io.env.ARMADA_COORDINATOR;
  if (env !== undefined) return validCoordinator(env);
  const paths = machinePaths(io.env);
  return (paths ? await readCoordinatorName(paths, project, resolve(root)) : null) ?? "default";
}

export async function coordinatorCommand(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials | null,
  args: {
    rest: string[];
    options: Record<string, string>;
    json: boolean;
  },
): Promise<number> {
  const [command, ...rest] = args.rest;
  const project = config.project.slug;
  if (command === "use") {
    if (rest.length !== 1 || args.options.from) throw new UsageError("coordinator use <name>");
    const name = validCoordinator(rest[0] as string);
    const paths = machinePaths(io.env);
    if (!paths) throw new UsageError("coordinator use needs a machine config directory (HOME or XDG_CONFIG_HOME)");
    await writeCoordinatorName(paths, project, resolve(io.coordinatorRoot ?? io.cwd), name);
    const effective = await coordinatorName(io, project);
    const line = `Coordinator ${name} selected for ${project}${effective !== name ? `; ARMADA_COORDINATOR selects ${effective} in this terminal` : ""}.`;
    io.stdout(args.json ? `${JSON.stringify({ project, name, effective })}\n` : `${line}\n`);
    return 0;
  }
  if (command !== "list" && command !== "take") throw new UsageError("coordinator needs a command: use, list or take");
  if (!credentials) throw new UsageError("armada coordinator needs a sign-in");
  const signIn = requireSignIn(credentials);
  if (signIn.kind === "worker") throw new UsageError("a worker cannot manage coordinators");
  const name = await coordinatorName(io, project);
  const { fleet, warning } = liveFleet(io, config, credentials);
  if (!fleet) throw new Refusal(warning ?? "Armada is unreachable", "armada login");
  await fleet.coordinator({ ...detectCoordinator(io), name });
  if (command === "list") {
    if (rest.length || args.options.from) throw new UsageError("coordinator list takes no argument");
    const roles = await fleet.coordinators();
    io.stdout(
      args.json
        ? `${JSON.stringify({ project, coordinators: roles }, null, 2)}\n`
        : `${roles
            .map((role) =>
              [
                `${role.name}${role.name === name ? " (you)" : ""} · last seen ${role.seenAt}`,
                ...role.sessions.map(
                  (session) =>
                    `  ${session.handle ?? "terminal"}${session.harness ? ` · ${session.harness}` : ""}${session.model ? ` · ${session.model}` : ""} · last seen ${session.seenAt}`,
                ),
                `  tickets: ${role.tickets.join(", ") || "none"}`,
              ].join("\n"),
            )
            .join("\n")}\n`,
    );
    return 0;
  }
  if (!rest.length || rest.length > 100 || !rest.every((ticket) => /^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/.test(ticket)))
    throw new UsageError("coordinator take <ticket...> [--from <name>] (at most 100 tickets)");
  const from = args.options.from === undefined ? undefined : validCoordinator(args.options.from);
  const tickets = [...new Set(rest.map((ticket) => ticket.toUpperCase()))];
  const transferred = await fleet.takeTickets({ tickets, ...(from ? { from } : {}) });
  if (!transferred) throw new Refusal("ticket ownership changed or --from does not match", "armada coordinator list");
  io.stdout(
    args.json
      ? `${JSON.stringify({ project, coordinator: name, tickets })}\n`
      : `Transferred ${tickets.join(", ")} to coordinator ${name}.\n`,
  );
  return 0;
}
