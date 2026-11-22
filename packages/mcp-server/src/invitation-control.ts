import { VaultError } from "@armada/core/server";
import { required } from "./control-input.ts";
import { type ControlRouteContext, defineRoutes } from "./routes.ts";

function invitations(options: ControlRouteContext["options"]) {
  if (!options.invitations) throw new VaultError("unavailable", "Invitations unavailable.");
  return options.invitations;
}

function manage(action: "create" | "list" | "resend" | "revoke") {
  return ({ caller, body, options }: ControlRouteContext) =>
    invitations(options).manage(action, caller, required(body, "org"), body);
}

export const invitationRoutes = defineRoutes("invitation-control", {
  "org/invitations/create": manage("create"),
  "org/invitations/list": manage("list"),
  "org/invitations/resend": manage("resend"),
  "org/invitations/revoke": manage("revoke"),
  "org/invitations/preview": ({ caller, body, options }) => invitations(options).preview(caller, body.token),
  "org/invitations/accept": ({ caller, body, options }) => invitations(options).accept(caller, body.token),
});
