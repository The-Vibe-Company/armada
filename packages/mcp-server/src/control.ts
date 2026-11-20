import { LaunchError } from "@armada/core/server";
import type { DispatchTurn } from "./account-turn-dispatch.ts";
import { rejectUnknownVaultRoute } from "./application-vault-control.ts";
import type { Caller } from "./caller.ts";
import { readControlBody } from "./control-body.ts";
import { authenticatedCaller, scopedOrg } from "./control-caller.ts";
import { controlFailureResponse } from "./control-errors.ts";
import { optional } from "./control-input.ts";
import type { ControlOptions } from "./control-options.ts";
import { fail } from "./control-response.ts";
import { controlRoutes } from "./modules.ts";
import { recordOperatorFailure } from "./request-observability.ts";
import { RequestTiming, withRequestTiming } from "./request-timing.ts";
import { matchControlRoute } from "./routes.ts";
import { rejectUnroutedViewerRequest } from "./viewer-control.ts";

export const CONTROL_PREFIX = "/api/v1/";
export type { ConfiguredControlOptions, ControlOptions } from "./control-options.ts";

/**
 * Dispatches the control API using the registered HTTP methods and authentication policies.
 * Returns null for paths outside the control API. No request body, token or credential value is logged.
 */
export async function handleControlRequest(request: Request, options: ControlOptions): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(CONTROL_PREFIX)) return null;
  const route = url.pathname.slice(CONTROL_PREFIX.length);
  const registered = matchControlRoute(controlRoutes, route);
  const dispatch = (next: Request) => handleControlRequest(next, options);
  if (registered && "earlyRespond" in registered) return registered.earlyRespond(request, options, dispatch);
  const refusal = await rejectUnroutedViewerRequest(request, options, dispatch);
  if (refusal) return refusal;
  const timing = new RequestTiming();
  const response = await withRequestTiming(timing, () =>
    timing.measure("total", () => timedControlRequest(request, { ...options, timing }, route, registered)),
  );
  const headers = new Headers(response.headers);
  headers.set("server-timing", timing.header());
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function timedControlRequest(
  request: Request,
  options: ControlOptions & { timing: RequestTiming },
  route: string,
  registered: ReturnType<typeof controlRoutes.get>,
): Promise<Response> {
  const timing = options.timing;
  const methods: readonly string[] = registered?.methods ?? ["POST"];
  if (!methods.includes(request.method)) return fail(405, "invalid", `Use ${methods.join(" or ")}.`);
  if (registered && "respond" in registered) return registered.respond(request, options);
  try {
    const caller = await timing.measure("auth", () => authenticatedCaller(request, options));
    const command = registered && "handler" in registered ? registered : undefined;
    const body = await (command?.readBody?.(request) ?? readControlBody(request, route));
    const result = await timing.measure("dispatch", async () => {
      const context = { route, caller, body, options, request };
      return command ? command.handler(context) : unknownControlCommand(route, caller, body, options);
    });
    if (result === undefined) return fail(404, "unknown_route", "Unknown route.");
    return Response.json(result, {
      status: command?.responseStatus?.(result) ?? 200,
      headers: { "cache-control": "no-store", "server-timing": timing.header() },
    });
  } catch (error) {
    const response = controlFailureResponse(error);
    if (response.status >= 500)
      recordOperatorFailure("control.dispatch", error, {
        sandboxId: error instanceof LaunchError ? error.sandboxId : undefined,
      });
    return response;
  }
}

export async function dispatchControlCommand(
  route: string,
  caller: Caller,
  body: Record<string, unknown>,
  options: ControlOptions,
  request?: Request,
): Promise<unknown> {
  const registered = controlRoutes.get(route);
  if (registered && !registered.pattern && "handler" in registered)
    return registered.handler({ route, caller, body, options, request });
  return unknownControlCommand(route, caller, body, options);
}

export function createQueuedSandboxDispatch(options: ControlOptions) {
  const { accountTurns: _queue, runtimeSend, ...unqueued } = options;
  const dispatch: DispatchTurn = (caller, input, claim) =>
    dispatchControlCommand(
      "sandbox/send",
      caller,
      { ...input },
      {
        ...unqueued,
        ...(runtimeSend ? { runtimeSend: (actor, request) => runtimeSend(actor, request, claim) } : {}),
      },
    );
  return dispatch;
}

function unknownControlCommand(route: string, caller: Caller, body: Record<string, unknown>, options: ControlOptions) {
  rejectUnknownVaultRoute(route, options);
  scopedOrg(caller, optional(body, "org"));
  return undefined;
}

export { authenticatedControlCaller } from "./control-caller.ts";
export { controlOptionsFromEnv } from "./control-config.ts";

export type { GoldenJson } from "./golden-control.ts";

export { templateRuntime } from "./launch-control.ts";
