import { SIZED_LAUNCH_ROUTE_V1 } from "@armada/core";
import { isUuid } from "./action.ts";
import { type ArmadaApiOptions, ControlError, controlPost } from "./control.ts";
import type { LaunchArgs } from "./model-choice.ts";

/**
 * How long the dashboard waits for a launch: the CLI's own launch deadline. The server forks the golden's snapshot,
 * starts the agent and sends the first prompt inside the request, which takes about 15 seconds on Modal today, so the
 * short control default (`CONTROL_TIMEOUT_MS`) would report a launch that succeeds as a failure. The routes that run
 * the launch action keep `maxDuration` above it.
 */
export const LAUNCH_TIMEOUT_MS = 10 * 60_000;

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
    { ...options, timeoutMs: options.timeoutMs ?? LAUNCH_TIMEOUT_MS },
    args.armadaAccess ? "/api/v1/sandbox/launch-access-v1" : sized ? SIZED_LAUNCH_ROUTE_V1 : LAUNCH_PATH,
    {
      ...(args.armadaAccess ? { armadaAccessVersion: 1, armadaAccess: { maxActiveChildren: 3 } } : {}),
      golden: args.golden,
      provider: args.provider,
      org: args.org,
      harness: args.harness,
      model: args.model,
      reasoningEffort: args.reasoning_effort,
      ...(args.skills?.length ? { skills: args.skills } : {}),
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

/** One launch submission the dashboard already sent: its request key and when the server action first sent it. */
export type LaunchAttempt = { key: string; since: number };

export type FollowedLaunch = { state: "started"; id: string } | { state: "unknown"; since: number };

/**
 * Launches once per request key and follows the launch when its outcome is unknown. The server's launch route has
 * no idempotency key, so the identity is the viewer's own live sandboxes created from the chosen golden and agent
 * since the key's first attempt (`created`, read under row level security):
 *
 * - a repeated submission of the same key goes to the sandbox its earlier attempt created instead of launching again;
 * - a launch that got no answer (deadline, connection lost) is looked up the same way, so the person lands on the
 *   sandbox it started; only when none exists yet is the outcome reported as unknown.
 *
 * `remember` keeps the attempt before anything is sent; `forget` drops it once the server answered with a refusal,
 * so the next submission of the same choices is a new launch, not a visit to what the refused one left behind. A key
 * that is not a UUID is not followed: the launch is sent once, as before.
 */
export async function followLaunch(deps: {
  key: string;
  previous: LaunchAttempt | null;
  now: () => number;
  remember: (attempt: LaunchAttempt) => Promise<void> | void;
  forget: () => Promise<void> | void;
  created: (since: number) => Promise<string | null>;
  launch: () => Promise<{ id: string }>;
}): Promise<FollowedLaunch> {
  const keyed = isUuid(deps.key);
  let since = deps.now();
  if (keyed && deps.previous?.key === deps.key) {
    since = deps.previous.since;
    const id = await deps.created(since);
    if (id) return { state: "started", id };
  } else if (keyed) await deps.remember({ key: deps.key, since });
  try {
    return { state: "started", id: (await deps.launch()).id };
  } catch (error) {
    if (!keyed) throw error;
    if (!(error instanceof ControlError) || !error.outcomeUnknown) {
      await deps.forget();
      throw error;
    }
    const id = await deps.created(since);
    return id ? { state: "started", id } : { state: "unknown", since };
  }
}

/** The cookie holding one request key's attempt: one per key, so launches from two tabs do not overwrite each other. */
export function launchAttemptCookie(key: string): string {
  return `armada_launch_${key}`;
}

/** The cookie value of a {@link LaunchAttempt}, and back; anything else reads as no attempt. */
export function encodeLaunchAttempt(attempt: LaunchAttempt): string {
  return `${attempt.key}.${attempt.since}`;
}

export function decodeLaunchAttempt(value: string | undefined): LaunchAttempt | null {
  const [key, since, ...rest] = (value ?? "").split(".");
  const at = Number(since);
  return rest.length === 0 && isUuid(key) && Number.isSafeInteger(at) && at > 0 ? { key, since: at } : null;
}
