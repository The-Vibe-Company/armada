import { accountRoutes } from "./account-control.ts";
import { antigravityLoginRoutes } from "./antigravity-login-control.ts";
import { applicationVaultRoutes } from "./application-vault-control.ts";
import { logRoutes } from "./control-logs.ts";
import { sandboxToolRoutes } from "./control-tool-routes.ts";
import { credentialRoutes } from "./credential-control.ts";
import { deviceLoginRoutes } from "./device-login-control.ts";
import { eventStreamRoutes } from "./event-stream.ts";
import { githubAccountRoutes } from "./github-account.ts";
import { githubSandboxRoutes } from "./github-rest-controls.ts";
import { goldenRoutes } from "./golden-control.ts";
import { invitationRoutes } from "./invitation-control.ts";
import { launchRoutes } from "./launch-control.ts";
import { mcpRoutes } from "./mcp-control.ts";
import { orgRoutes } from "./org-control.ts";
import { publicAuthRoutes } from "./public-auth-control.ts";
import { relayRoutes } from "./relay-control.ts";
import { routineRoutes } from "./routine-control.ts";
import { sandboxRoutes } from "./sandbox-control.ts";
import { sandboxRestRoutes } from "./sandbox-rest-controls.ts";
import { controlMountModule, scriptedModelModule, triggerModule } from "./server-mounts.ts";
import { registerServer } from "./server-registration.ts";
import {
  delegatedAccessModule,
  dockerModule,
  invitationModule,
  jobsModule,
  mcpBackgroundModule,
  mcpModule,
  modalModule,
  outputModule,
  routineModule,
  runtimeModule,
} from "./server-worker-modules.ts";
import { skillDefaultsRoutes } from "./skill-defaults-control.ts";
import { skillpackRoutes } from "./skillpack-control.ts";
import { templateRoutes } from "./template-control.ts";
import { tokenRoutes } from "./token-control.ts";
import { viewerRoutes } from "./viewer-control.ts";

const controlModules = [
  launchRoutes,
  sandboxRoutes,
  sandboxRestRoutes,
  sandboxToolRoutes,
  orgRoutes,
  credentialRoutes,
  antigravityLoginRoutes,
  skillpackRoutes,
  publicAuthRoutes,
  deviceLoginRoutes,
  githubAccountRoutes,
  tokenRoutes,
  accountRoutes,
  invitationRoutes,
  routineRoutes,
  skillDefaultsRoutes,
  templateRoutes,
  mcpRoutes,
  goldenRoutes,
  githubSandboxRoutes,
  logRoutes,
  applicationVaultRoutes,
  viewerRoutes,
  relayRoutes,
  eventStreamRoutes,
];

export const { controlRoutes, assembleServer } = registerServer([
  ({ routes }) => routes.push(...controlModules),
  scriptedModelModule,
  triggerModule,
  jobsModule,
  outputModule,
  delegatedAccessModule,
  mcpBackgroundModule,
  dockerModule,
  runtimeModule,
  modalModule,
  mcpModule,
  controlMountModule,
  invitationModule,
  routineModule,
]);
