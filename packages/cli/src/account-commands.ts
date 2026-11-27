import { AuthError } from "@armada/auth";
import { GoldenError } from "@armada/core";
import { acceptedOptions, flag, type parseArgs, single } from "./args.ts";
import type { AuthIo } from "./auth-commands.ts";
import { logoutCommand } from "./auth-commands.ts";
import { authorizationUrl } from "./connection-authorization.ts";
import { control } from "./control.ts";
import { formatTable, stripControl } from "./table.ts";
import { modelAccountCommand, parseAccountArgs, type VaultIo } from "./vault-commands.ts";

interface GitHubInstallationSummary {
  id: number;
  app_id?: number;
  app_slug?: string;
  account: string;
  account_type: string;
  repository_selection?: string;
}

interface GitHubConnection {
  status: string;
  login?: string | null;
  name?: string | null;
  githubId?: number | null;
  installations: GitHubInstallationSummary[];
  installUrl?: string | null;
  configured?: boolean;
}

interface GitHubStatus {
  connection: GitHubConnection;
  flowStatus?: string;
}

interface InstallationDiff {
  added: GitHubInstallationSummary[];
  updated: GitHubInstallationSummary[];
}

export async function accountCommand(argv: readonly string[], io: VaultIo) {
  const args = parseAccountArgs(argv);
  const [verb, target, ...extra] = args.positionals;
  if (target !== "github" && verb !== "status" && verb !== "logout") {
    if (args.options.has("--no-wait"))
      throw new GoldenError("invalid_config", "Unsupported account option '--no-wait'.");
    return modelAccountCommand(verb, { ...args, positionals: args.positionals.slice(1) }, io);
  }
  const { auth } = io;
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
    case "ls": {
      acceptedOptions(args, "account ls github", ["--json"]);
      const result = await control<GitHubStatus>(auth, "github/status", {});
      if (!result?.connection) throw new AuthError("The server returned an invalid GitHub status.", "unavailable");
      auth.out(flag(args, "--json") ? `${JSON.stringify(result, null, 2)}\n` : formatGitHubStatus(result.connection));
      return 0;
    }
    case "rm": {
      acceptedOptions(args, "account rm github", ["--json"]);
      auth.out(`${JSON.stringify(await control(auth, "github/disconnect", {}), null, 2)}\n`);
      return 0;
    }
    case "login":
      acceptedOptions(args, "account login github", ["--json", "--no-browser", "--timeout"]);
      return authorizeGitHub(auth, "connect", args);
    case "add":
      acceptedOptions(args, "account add github", ["--json", "--no-browser", "--timeout", "--no-wait"]);
      return authorizeGitHub(auth, "install", args);
    default:
      throw new AuthError("See armada account --help for account commands.", "usage");
  }
}

function installationsOf(connection: GitHubConnection | undefined) {
  return Array.isArray(connection?.installations) ? connection.installations : [];
}

function formatScope(selection: string | undefined) {
  if (selection === "all") return "all repositories";
  if (selection === "selected") return "selected repositories";
  return "unknown";
}

function formatInstallationsTable(installations: readonly GitHubInstallationSummary[]) {
  return formatTable(
    ["ACCOUNT", "TYPE", "SCOPE", "ID"],
    installations.map((inst) => [
      stripControl(inst.account),
      stripControl(inst.account_type),
      formatScope(inst.repository_selection),
      String(inst.id),
    ]),
  );
}

function formatGitHubStatus(connection: GitHubConnection) {
  const installations = installationsOf(connection);
  const login = connection.login ? stripControl(connection.login) : null;
  if (connection.status === "connected") {
    const count = `${installations.length} ${installations.length === 1 ? "installation" : "installations"}`;
    const lines = [`GitHub: connected${login ? ` as ${login}` : ""} (${count})`];
    if (installations.length === 0) {
      lines.push(
        "Connected GitHub App installations: none",
        connection.installUrl === null
          ? "Note: GitHub App installation is not configured on this server."
          : "Next step: run `armada account add github` to install the Armada GitHub App on an account or organization.",
      );
      return `${lines.join("\n")}\n`;
    }
    lines.push(
      formatInstallationsTable(installations).trimEnd(),
      "",
      connection.installUrl === null
        ? "Note: GitHub App installation is not configured on this server."
        : "Next step: run `armada account add github` to connect another GitHub organization or update selected repositories.",
    );
    return `${lines.join("\n")}\n`;
  }
  if (connection.status === "not_connected") {
    return (
      "GitHub: not connected\n" +
      (connection.configured === false
        ? "GitHub App authorization is not configured on this server.\n"
        : "Next step: run `armada account login github` to connect your GitHub account.\n")
    );
  }
  if (connection.status === "needs_reconnect" || connection.status === "revoked") {
    return (
      `GitHub: needs reconnect${login ? ` (${login})` : ""}\n` +
      "Next step: run `armada account login github` to reconnect your GitHub account.\n"
    );
  }
  const lines = [`GitHub: ${stripControl(connection.status)}${login ? ` (${login})` : ""}`];
  if (connection.configured === false) {
    lines.push("GitHub App authorization is not configured on this server.");
    return `${lines.join("\n")}\n`;
  }
  if (installations.length > 0) {
    lines.push("Last known GitHub App installations:", formatInstallationsTable(installations).trimEnd());
  }
  lines.push("Next step: run `armada account ls github` again shortly.");
  return `${lines.join("\n")}\n`;
}

function diffInstallations(before: readonly GitHubInstallationSummary[], after: readonly GitHubInstallationSummary[]) {
  const prior = new Map(before.map((inst) => [inst.id, inst]));
  const added: GitHubInstallationSummary[] = [];
  const updated: GitHubInstallationSummary[] = [];
  for (const inst of after) {
    const prev = prior.get(inst.id);
    if (!prev) added.push(inst);
    else if (
      prev.repository_selection !== inst.repository_selection ||
      prev.account !== inst.account ||
      prev.account_type !== inst.account_type
    )
      updated.push(inst);
  }
  return { added, updated } satisfies InstallationDiff;
}

function formatAccountNames(list: readonly GitHubInstallationSummary[]) {
  return list.map((inst) => `${stripControl(inst.account)} (${formatScope(inst.repository_selection)})`).join(", ");
}

function formatGitHubInstallResult(connection: GitHubConnection, change: InstallationDiff) {
  const header: string[] = [];
  if (change.added.length > 0 && change.updated.length > 0) {
    header.push(`Connected ${formatAccountNames(change.added)} and updated ${formatAccountNames(change.updated)}.`);
  } else if (change.added.length > 0) {
    header.push(`Connected GitHub App installation: ${formatAccountNames(change.added)}.`);
  } else if (change.updated.length > 0) {
    header.push(`Updated GitHub App installation: ${formatAccountNames(change.updated)}.`);
  } else {
    header.push(
      "GitHub App installation flow completed.",
      "If you requested access to an organization that requires admin approval, it will appear once an org owner approves the request.",
    );
  }
  return `${header.join("\n")}\n\n${formatGitHubStatus(connection)}`;
}

async function authorizeGitHub(auth: AuthIo, action: "connect" | "install", args: ReturnType<typeof parseArgs>) {
  const noWait = action === "install" && flag(args, "--no-wait");
  const rawTimeout = single(args, "--timeout");
  if (noWait && rawTimeout !== undefined) throw new AuthError("Cannot combine --no-wait with --timeout.", "usage");
  const timeout = rawTimeout === undefined ? 300 : Number(rawTimeout);
  if (
    (rawTimeout !== undefined && !/^\d+$/.test(rawTimeout)) ||
    !Number.isInteger(timeout) ||
    timeout < 0 ||
    timeout > 600
  )
    throw new AuthError("--timeout is 0–600 seconds.", "usage");

  const json = flag(args, "--json");
  const noBrowser = flag(args, "--no-browser");
  const before = action === "install" && !noWait ? await control<GitHubStatus>(auth, "github/status", {}) : undefined;
  const started = await control<{ authorizationUrl: string; flowId?: string }>(auth, `github/${action}`, {});
  const url = authorizationUrl(started.authorizationUrl);

  let opened = false;
  if (noBrowser) {
    auth.err(
      action === "install"
        ? `Open this URL in your browser to install or update the Armada GitHub App: ${url}\n`
        : `Complete authorization in your browser: ${url}\n`,
    );
  } else {
    try {
      auth.open(url);
      opened = true;
    } catch {
      auth.err(`Could not open a browser automatically. Open this URL in your browser: ${url}\n`);
    }
  }

  if (noWait) {
    if (json) {
      auth.out(
        `${JSON.stringify(
          {
            status: "pending",
            waiting: false,
            authorizationUrl: url,
            ...(started.flowId ? { flowId: started.flowId } : {}),
          },
          null,
          2,
        )}\n`,
      );
    } else {
      auth.out(
        `${opened ? "Opened GitHub App installation in your browser" : "Started GitHub App installation"} (not waiting for completion).\n` +
          "If your organization requires admin approval, ask an org owner to approve the request.\n" +
          "Next step: run `armada account ls github` once installation or approval finishes.\n",
      );
    }
    return 0;
  }

  if (action === "install" && !json) {
    if (opened) auth.err(`Opened GitHub App installation in your browser: ${url}\n`);
    auth.err(
      "Waiting for installation or repository access update... If your organization requires admin approval, press Ctrl-C (or use --no-wait) and run `armada account ls github` after approval.\n",
    );
  }

  const beforeInstallations = installationsOf(before?.connection);
  const canDiffBefore = before?.connection?.status === "connected" || !started.flowId;
  const deadline = auth.now().getTime() + timeout * 1000;
  for (;;) {
    const result = await control<GitHubStatus>(auth, "github/status", started.flowId ? { flowId: started.flowId } : {});
    if (result?.flowStatus === "failed" || result?.flowStatus === "expired") {
      const retry = action === "install" ? "armada account add github" : "armada account login github";
      throw new AuthError(`GitHub authorization ${result.flowStatus}; retry ${retry}.`, "unavailable");
    }
    if (result?.connection?.status === "connected") {
      if (action === "connect") {
        if (result.flowStatus === "connected") {
          auth.out(`${JSON.stringify(result, null, 2)}\n`);
          return 0;
        }
      } else {
        const afterInstallations = installationsOf(result.connection);
        const change = canDiffBefore
          ? diffInstallations(beforeInstallations, afterInstallations)
          : { added: [], updated: [] };
        const flowCompleted = Boolean(started.flowId) && result.flowStatus === "connected";
        if (flowCompleted || change.added.length > 0 || change.updated.length > 0) {
          auth.out(
            json ? `${JSON.stringify(result, null, 2)}\n` : formatGitHubInstallResult(result.connection, change),
          );
          return 0;
        }
      }
    }
    const remaining = deadline - auth.now().getTime();
    if (remaining <= 0) {
      throw new AuthError(
        action === "install"
          ? "GitHub App installation timed out before completion. If your organization requires admin approval, wait for an org owner to approve the request, then run armada account ls github (use --no-wait to skip waiting)."
          : "GitHub authorization timed out. Run armada account ls github; no success was assumed.",
        "unavailable",
      );
    }
    await (auth.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(Math.min(remaining, 1000));
  }
}
