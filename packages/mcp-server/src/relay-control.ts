import { BodyTooLargeError } from "@armada/auth";
import { controlRouteKey, type RelayTicketErrorCode, sandboxRelayOperations } from "@armada/core/contract";
import { VaultError } from "@armada/core/server";
import { AuthUnavailable } from "./caller.ts";
import { readBody } from "./control-body.ts";
import { authenticatedControlCaller, selectedCaller, Unauthorized } from "./control-caller.ts";
import type { ControlOptions } from "./control-options.ts";
import { fail } from "./control-response.ts";
import { defineRoutes } from "./routes.ts";

const op = sandboxRelayOperations.mintTicket;
const relayFail = (status: number, code: RelayTicketErrorCode, message: string) => fail(status, code, message);

async function handleMintRelayTicket(request: Request, options: ControlOptions) {
  if (!options.relayHub) return relayFail(503, "relay_unavailable", "Sandbox relay is unavailable.");
  try {
    const caller = await authenticatedControlCaller(request, options);
    if (!caller) return relayFail(401, "unauthorized", "Authentication is required.");
    const rawId = new URL(request.url).pathname.slice("/api/v1/sandboxes/".length, -"/relay-ticket".length);
    const parsedId = op.input.path.id.safeParse(rawId);
    if (!parsedId.success) return relayFail(400, "invalid_request", "Invalid sandbox ID.");
    const parsed = op.input.body.safeParse(await readBody(request, op.input.maxBodyBytes));
    if (!parsed.success)
      return relayFail(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid relay ticket request.");
    const scoped = await selectedCaller(options, caller, parsed.data.org);
    const res = await options.relayHub.mintTicket(scoped, parsedId.data.toLowerCase(), {
      mode: parsed.data.mode,
      ...(parsed.data.port !== undefined ? { port: parsed.data.port } : {}),
      ...(parsed.data.cwd !== undefined ? { cwd: parsed.data.cwd } : {}),
    });
    if (!res.ok) return relayFail(res.status, res.code, res.message);
    return Response.json(
      { ticket: res.ticket, wsUrl: res.wsUrl, expiresAt: res.expiresAt },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof Unauthorized) return relayFail(401, "unauthorized", error.message);
    if (error instanceof BodyTooLargeError) return relayFail(400, "invalid_request", error.message);
    if (error instanceof VaultError) {
      if (error.code === "forbidden") return relayFail(403, "forbidden", error.message);
      if (error.code === "not_found") return relayFail(404, "not_found", error.message);
      return relayFail(400, "invalid_request", error.message);
    }
    if (error instanceof AuthUnavailable) return relayFail(503, "relay_unavailable", "Authentication is unavailable.");
    return relayFail(503, "relay_unavailable", "Sandbox relay is temporarily unavailable.");
  }
}

export const relayRoutes = defineRoutes("relay", {
  [controlRouteKey(op.route)]: {
    methods: [op.route.method],
    pattern: /^sandboxes\/[^/]+\/relay-ticket$/,
    respond: handleMintRelayTicket,
  },
});
