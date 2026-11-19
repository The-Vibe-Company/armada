import { type ApplicationVault, VaultError } from "@armada/core/server";
import { type ControlRouteContext, defineRoutes } from "./routes.ts";

function vaultCommand(
  kind: Parameters<ApplicationVault["command"]>[1],
  operation: Parameters<ApplicationVault["command"]>[2],
) {
  return ({ caller, body, options }: ControlRouteContext) => {
    if (!options.applicationVault) throw new VaultError("unavailable", "Application vault unavailable.");
    return options.applicationVault.command(caller, kind, operation, body);
  };
}

export const applicationVaultRoutes = defineRoutes("application-vault", {
  "variables/list": vaultCommand("variable", "list"),
  "variables/read": vaultCommand("variable", "read"),
  "variables/set": vaultCommand("variable", "set"),
  "variables/update": vaultCommand("variable", "update"),
  "variables/revoke": vaultCommand("variable", "revoke"),
  "variables/delete": vaultCommand("variable", "delete"),
  "secrets/list": vaultCommand("secret", "list"),
  "secrets/set": vaultCommand("secret", "set"),
  "secrets/rotate": vaultCommand("secret", "rotate"),
  "secrets/revoke": vaultCommand("secret", "revoke"),
  "secrets/delete": vaultCommand("secret", "delete"),
  "secrets/upload": vaultCommand("secret", "upload"),
  "secrets/commit": vaultCommand("secret", "commit"),
});
