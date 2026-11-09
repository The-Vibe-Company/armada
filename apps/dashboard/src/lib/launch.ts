import { type ArmadaApiOptions, ControlError, controlPost } from "./control.ts";
import type { LaunchArgs } from "./model-choice.ts";

/** The canonical launch route of the Armada API. */
export const LAUNCH_PATH = "/api/v1/sandbox/launch";

/**
 * Launches a sandbox through `POST /api/v1/sandbox/launch` as the signed-in viewer. The body carries what the
 * person chose: golden, org, agent, model and effort, visibility and connections, the optional repository
 * context (`repo`, a golden `repos[].dir`), the optional machine size override (`size`, absent to use the
 * repository then golden default) and the optional first prompt. Answers the new sandbox's id.
 */
export async function launchSandbox(
  options: ArmadaApiOptions,
  args: LaunchArgs,
): Promise<{ id: string; sizeRecorded: boolean; sizeConfirmed: boolean }> {
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
      visibility: args.visibility,
      connections: args.connections,
      ...(args.repo === undefined ? {} : { repo: args.repo }),
      ...(args.size === undefined ? {} : { size: args.size }),
      ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
    },
    "launching from the dashboard",
  );
  const sandbox = payload.sandbox;
  const id = typeof sandbox === "object" && sandbox !== null && "id" in sandbox ? sandbox.id : undefined;
  if (typeof id !== "string" || !id) throw new ControlError("The Armada server sent no sandbox id.");
  // A server before #653 ignores `size` and answers no `machineSize` key at all; a newer one always answers it.
  const recorded = typeof sandbox === "object" && sandbox !== null && "machineSize" in sandbox;
  const evidence = (sandbox as { machineSize?: { requested?: unknown } | null }).machineSize;
  return { id, sizeRecorded: recorded, sizeConfirmed: args.size === undefined || evidence?.requested === args.size };
}
