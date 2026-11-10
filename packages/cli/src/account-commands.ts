import { AuthError } from "@armada/auth";
import { flag, parseArgs, single } from "./args.ts";
import type { AuthIo } from "./auth-commands.ts";
import { logoutCommand } from "./auth-commands.ts";
import { authorizationUrl } from "./connection-authorization.ts";
import { control } from "./control.ts";

interface GitHubStatus {
  connection: { status: string; installations: { id: number; account: string; account_type: string }[] };
  flowStatus?: string;
}
export async function accountCommand(command: "github" | "account", argv: readonly string[], auth: AuthIo) {
  const args = parseArgs(argv);
  const [action, id, ...extra] = args.positionals;
  if (command === "account") {
    if (id || extra.length) throw new AuthError("Run armada account status or logout.", "usage");
    if (action === "logout") {
      await control(auth, "account/logout", {});
      await logoutCommand(auth);
      return 0;
    }
    if (action !== "status") throw new AuthError("Run armada account status or logout.", "usage");
    auth.out(`${JSON.stringify(await control(auth, "account/status", {}), null, 2)}\n`);
    return 0;
  }
  if (
    !action ||
    !["status", "connect", "reconnect", "disconnect", "install", "manage", "refresh"].includes(action) ||
    extra.length ||
    (id && action !== "manage" && action !== "refresh")
  )
    throw new AuthError(
      "Run armada github status|connect|reconnect|disconnect|install|manage [installation-id], or armada github refresh <sandbox>.",
      "usage",
    );
  if (action === "refresh") {
    if (!id) throw new AuthError("Run armada github refresh <sandbox>.", "usage");
    auth.out(`${JSON.stringify(await control(auth, "github/refresh", { id }), null, 2)}\n`);
    return 0;
  }
  if (action === "status" || action === "disconnect") {
    auth.out(`${JSON.stringify(await control(auth, `github/${action}`, {}), null, 2)}\n`);
    return 0;
  }
  if (action === "manage") {
    const result = await control<GitHubStatus>(auth, "github/status", {});
    const installation = result.connection.installations.find((i) => String(i.id) === id);
    if (
      !installation ||
      !/^[A-Za-z0-9-]+$/.test(installation.account) ||
      !Number.isSafeInteger(installation.id) ||
      installation.id <= 0
    )
      throw new AuthError("Choose one of your installation IDs from github status.", "usage");
    const url =
      installation.account_type === "Organization"
        ? `https://github.com/organizations/${installation.account}/settings/installations/${installation.id}`
        : `https://github.com/settings/installations/${installation.id}`;
    if (flag(args, "--no-browser")) auth.out(`${url}\n`);
    else auth.open(url);
    return 0;
  }
  const timeout = Number(single(args, "--timeout") ?? "300");
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 600)
    throw new AuthError("--timeout is 0–600 seconds.", "usage");
  const before = action === "install" ? await control<GitHubStatus>(auth, "github/status", {}) : undefined;
  const started = await control<{ authorizationUrl: string; flowId?: string }>(auth, `github/${action}`, {});
  const url = authorizationUrl(started.authorizationUrl);
  if (flag(args, "--no-browser")) auth.err(`Complete authorization in your browser: ${url}\n`);
  else auth.open(url);
  const deadline = auth.now().getTime() + timeout * 1000;
  for (;;) {
    const result = await control<GitHubStatus>(auth, "github/status", started.flowId ? { flowId: started.flowId } : {});
    const installed =
      before &&
      result.connection.installations.some((i) => !before.connection.installations.some((old) => old.id === i.id));
    if (
      result.connection.status === "connected" &&
      (action === "install" ? installed : result.flowStatus === "connected")
    ) {
      auth.out(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    if (result.flowStatus === "failed" || result.flowStatus === "expired")
      throw new AuthError("GitHub authorization failed or expired; retry connect.", "unavailable");
    const remaining = deadline - auth.now().getTime();
    if (remaining <= 0)
      throw new AuthError(
        "GitHub authorization timed out. Check github status; no success was assumed.",
        "unavailable",
      );
    await (auth.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(Math.min(remaining, 1000));
  }
}
