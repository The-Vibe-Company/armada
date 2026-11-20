import { controlRouteKey, skillDefaultOperations } from "@armada/core/contract";
import { VaultError } from "@armada/core/server";
import { type ControlRouteContext, defineRoutes } from "./routes.ts";

function command(operation: string) {
  return ({ caller, body, options }: ControlRouteContext) => {
    if (!options.skillDefaults) throw new VaultError("unavailable", "Skill defaults unavailable.");
    return options.skillDefaults.command(caller, operation, body);
  };
}

const { readSkillDefaults: read, setSkillDefaults: set } = skillDefaultOperations;

export const skillDefaultsRoutes = defineRoutes("skill-defaults-control", {
  [controlRouteKey(read.route)]: { methods: [read.route.method], handler: command("get") },
  [controlRouteKey(set.route)]: { methods: [set.route.method], handler: command("set") },
});
