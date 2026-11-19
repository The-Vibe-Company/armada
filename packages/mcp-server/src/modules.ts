import { sandboxToolRoutes } from "./control-tool-routes.ts";
import { launchRoutes } from "./launch-control.ts";
import { registerRoutes } from "./routes.ts";
import { sandboxRoutes } from "./sandbox-control.ts";
import { sandboxRestRoutes } from "./sandbox-rest-controls.ts";

export const controlRoutes = registerRoutes([launchRoutes, sandboxRoutes, sandboxRestRoutes, sandboxToolRoutes]);
