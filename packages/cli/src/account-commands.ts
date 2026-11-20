import { AuthError } from "@armada/auth";
import { acceptedOptions, flag, parseArgs, single } from "./args.ts";
import type { AuthIo } from "./auth-commands.ts";
import { logoutCommand } from "./auth-commands.ts";
import { authorizationUrl } from "./connection-authorization.ts";
import { control } from "./control.ts";

interface GitHubStatus {
  connection: { status: string; installations: { id: number; account: string; account_type: string }[] };
  flowStatus?: string;
}
export async function accountCommand(argv: readonly string[], auth: AuthIo) {
  const args = parseArgs(argv);
  const [verb, target, ...extra] = args.positionals;
  const github = target === "github" && !extra.length;
  if (!target && (verb === "status" || verb === "logout")) {
    acceptedOptions(args, `account ${verb}`, ["--json"]);
    if (verb === "logout") {
      await control(auth, "account/logout", {});
      await logoutCommand(auth, flag(args, "--json"));
    } else auth.out(`${JSON.stringify(await control(auth, "account/status", {}), null, 2)}\n`);
    return 0;
  }

  if (!github) throw new AuthError("See armada account --help for account commands.", "usage");
  switch (verb) {
    case "ls":
    case "rm": {
      acceptedOptions(args, `account ${verb} github`, ["--json"]);
      const route = verb === "ls" ? "github/status" : "github/disconnect";
      auth.out(`${JSON.stringify(await control(auth, route, {}), null, 2)}\n`);
      return 0;
    }
    case "login":
    case "add":
      acceptedOptions(args, `account ${verb} github`, ["--json", "--no-browser", "--timeout"]);
      return authorizeGitHub(auth, verb === "add" ? "install" : "connect", args);
    default:
      throw new AuthError("See armada account --help for account commands.", "usage");
  }
}

async function authorizeGitHub(auth: AuthIo, action: "connect" | "install", args: ReturnType<typeof parseArgs>) {
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
      throw new AuthError("GitHub authorization failed or expired; retry armada account login github.", "unavailable");
    const remaining = deadline - auth.now().getTime();
    if (remaining <= 0)
      throw new AuthError(
        "GitHub authorization timed out. Run armada account ls github; no success was assumed.",
        "unavailable",
      );
    await (auth.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(Math.min(remaining, 1000));
  }
}
