import { accountRoutes } from "./account-control.ts";
import { sandboxToolRoutes } from "./control-tool-routes.ts";
import { credentialRoutes } from "./credential-control.ts";
import { githubCallbackRoutes } from "./github-account.ts";
import { invitationRoutes } from "./invitation-control.ts";
import { launchRoutes } from "./launch-control.ts";
import { orgRoutes } from "./org-control.ts";
import { publicAuthRoutes } from "./public-auth-control.ts";
import { registerRoutes } from "./routes.ts";
import { routineRoutes } from "./routine-control.ts";
import { sandboxRoutes } from "./sandbox-control.ts";
import { sandboxRestRoutes } from "./sandbox-rest-controls.ts";
import { skillDefaultsRoutes } from "./skill-defaults-control.ts";
import { skillpackRoutes } from "./skillpack-control.ts";
import { templateRoutes } from "./template-control.ts";
import { tokenRoutes } from "./token-control.ts";

export const controlRoutes = registerRoutes([
  launchRoutes,
  sandboxRoutes,
  sandboxRestRoutes,
  sandboxToolRoutes,
  orgRoutes,
  credentialRoutes,
  skillpackRoutes,
  publicAuthRoutes,
  githubCallbackRoutes,
  tokenRoutes,
  accountRoutes,
  invitationRoutes,
  routineRoutes,
  skillDefaultsRoutes,
  templateRoutes,
]);
