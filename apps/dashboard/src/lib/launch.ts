import { SIZED_LAUNCH_ROUTE_V1 } from "@armada/core";
import { isUuid } from "./action.ts";
import { type ArmadaApiOptions, ControlError, controlPost } from "./control.ts";
import type { LaunchArgs } from "./model-choice.ts";

/** The legacy launch route of the Armada API: no sizing semantics are promised on it. */
export const LAUNCH_PATH = "/api/v1/sandbox/launch";

/**
 * Launches a sandbox as the signed-in viewer. The body carries what the person chose: golden, org, agent, model and
 * effort, the connections when the person chose them (absent: the server applies the defaults), the optional
 * repository context (`repo`, a golden `repos[].dir`), the optional machine size override (`size`), the model account
 * (`credentialId`) and the optional first prompt. Answers the new sandbox's id.
 *
 * Whenever sizing matters (an explicit size, or a golden whose size defaults the server must resolve) it goes only
 * to #653's fail-closed `SIZED_LAUNCH_ROUTE_V1` with `sizePolicyVersion: 1`. A server that does not know that route
 * answers 404 before allocating anything, and the launch is never retried on the legacy route: a replica that ignores
 * `size` must not start a machine of another size.
 */
export async function launchSandbox(options: ArmadaApiOptions, args: LaunchArgs): Promise<{ id: string }> {
  if (args.armadaAccess && (args.harness !== "codex" || !isUuid(args.credentialId)))
    throw new ControlError("Armada access requires an explicit named Codex account.");
  const sized = args.size !== undefined || args.sizePolicy === true;
  const payload = await controlPost(
    options,
    args.armadaAccess ? "/api/v1/sandbox/launch-access-v1" : sized ? SIZED_LAUNCH_ROUTE_V1 : LAUNCH_PATH,
    {
      ...(args.armadaAccess ? { armadaAccessVersion: 1, armadaAccess: { maxActiveChildren: 3 } } : {}),
      golden: args.golden,
      provider: args.provider,
      org: args.org,
      harness: args.harness,
      model: args.model,
      reasoningEffort: args.reasoning_effort,
      ...(args.connections === undefined ? {} : { connections: args.connections }),
      ...(args.repo === undefined ? {} : { repo: args.repo }),
      ...(args.credentialId === undefined ? {} : { credentialId: args.credentialId }),
      ...(args.size === undefined ? {} : { size: args.size }),
      ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
      ...(sized ? { sizePolicyVersion: 1 } : {}),
    },
    args.armadaAccess
      ? "launching with Armada access"
      : sized
        ? "launching with machine sizes"
        : "launching from the dashboard",
  );
  const sandbox = payload.sandbox;
  const id = typeof sandbox === "object" && sandbox !== null && "id" in sandbox ? sandbox.id : undefined;
  if (typeof id !== "string" || !id) throw new ControlError("The Armada server sent no sandbox id.");
  return { id };
}
