import { type ArmadaApiOptions, ControlError, controlPost } from "./control.ts";
import type { LaunchArgs } from "./model-choice.ts";

/** The canonical launch route of the Armada API. */
export const LAUNCH_PATH = "/api/v1/sandbox/launch";

/**
 * Launches a sandbox through `POST /api/v1/sandbox/launch` as the signed-in viewer. The body carries what the
 * person chose: golden, org, agent, model and effort, connections, the optional repository
 * context (`repo`, a golden `repos[].dir`) and the optional first prompt. Answers the new sandbox's id.
 */
export async function launchSandbox(options: ArmadaApiOptions, args: LaunchArgs): Promise<{ id: string }> {
  const payload = await controlPost(
    options,
    LAUNCH_PATH,
    {
      golden: args.golden,
      provider: args.provider,
      org: args.org,
      harness: args.harness,
      model: args.model,
      reasoningEffort: args.reasoning_effort,
      connections: args.connections,
      ...(args.repo === undefined ? {} : { repo: args.repo }),
      ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
    },
    "launching from the dashboard",
  );
  const sandbox = payload.sandbox;
  const id = typeof sandbox === "object" && sandbox !== null && "id" in sandbox ? sandbox.id : undefined;
  if (typeof id !== "string" || !id) throw new ControlError("The Armada server sent no sandbox id.");
  return { id };
}
