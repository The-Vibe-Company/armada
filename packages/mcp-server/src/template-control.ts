import { VaultError } from "@armada/core/server";
import { templateRuntime } from "./launch-control.ts";
import { type ControlRouteContext, defineRoutes } from "./routes.ts";

function command(operation: string) {
  return ({ caller, body, options }: ControlRouteContext) => {
    if (!options.templates) throw new VaultError("unavailable", "Templates unavailable.");
    return options.templates.command(caller, operation, body, templateRuntime(options, caller));
  };
}

export const templateRoutes = defineRoutes("template-control", {
  "templates/create": command("create"),
  "templates/list": command("list"),
  "templates/get": command("get"),
  "templates/publish": command("publish"),
  "templates/delete": command("delete"),
});
