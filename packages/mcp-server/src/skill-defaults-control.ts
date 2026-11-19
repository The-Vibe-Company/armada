import { VaultError } from "@armada/core/server";
import { type ControlRouteContext, defineRoutes } from "./routes.ts";

function command(operation: string) {
  return ({ caller, body, options }: ControlRouteContext) => {
    if (!options.skillDefaults) throw new VaultError("unavailable", "Skill defaults unavailable.");
    return options.skillDefaults.command(caller, operation, body);
  };
}

export const skillDefaultsRoutes = defineRoutes("skill-defaults-control", {
  "skills/defaults/get": command("get"),
  "skills/defaults/set": command("set"),
});
