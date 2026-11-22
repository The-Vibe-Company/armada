import { VaultError } from "@armada/core/server";
import { type ControlRouteContext, defineRoutes } from "./routes.ts";

function command(operation: string) {
  return ({ caller, body, options }: ControlRouteContext) => {
    if (!options.routines) throw new VaultError("unavailable", "Routines unavailable.");
    return options.routines.command(caller, operation, body);
  };
}

export const routineRoutes = defineRoutes("routine-control", {
  "routines/create": command("create"),
  "routines/list": command("list"),
  "routines/get": command("get"),
  "routines/update": command("update"),
  "routines/delete": command("delete"),
  "routines/enable": command("enable"),
  "routines/pause": command("pause"),
  "routines/history": command("history"),
  "routines/preview": command("preview"),
});
