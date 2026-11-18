import { AuthError, assertProvider } from "@armada/auth";
import {
  configFromFlags,
  type GoldenBuildStatus,
  type GoldenConfig,
  GoldenError,
  type GoldenRecord,
  goldenBuildFailureText,
  goldenResponse,
  HARNESSES,
  type Harness,
  isSandboxProvider,
  LaunchError,
  type LaunchResult,
  launchResponse,
  type Provider,
  ProviderError,
  ProviderRoutingError,
  parseMachineSize,
  parseSnapshotConfig,
  resolveModelChoice,
  type SandboxProviderId,
  SIZED_LAUNCH_ROUTE_V1,
  VaultError,
  VERSION,
} from "@armada/core";
import { accountCommand } from "./account-commands.ts";
import { applicationVaultCommand } from "./application-vault-commands.ts";
import { acceptedOptions, flag, parseArgs, providerFlag, single, values } from "./args.ts";
import { ArmadaApiError, createArmadaApiClient, resolveArmadaOrigin } from "./armada-api.ts";
import {
  type AuthIo,
  loginCommand,
  logoutCommand,
  productionAuthIo,
  tokenCreate,
  tokenList,
  tokenRevoke,
} from "./auth-commands.ts";
import { commandWords, HELP, LOGS_HELP } from "./command-catalog.ts";
import { completion, doctor, prepareLaunch } from "./devx.ts";
import { launchDocker } from "./docker-launch.ts";
import { dockerSnapshotCommand } from "./docker-snapshots.ts";
import { failureHint } from "./failure-hint.ts";
import { hostCommand } from "./host-commands.ts";
import { type LocalHostIo, localHostCommand, productionLocalHostIo } from "./local-host.ts";
import { onboardingHelp } from "./onboarding-help.ts";
import { operation, parseTtl } from "./operations.ts";
import { profileStores, selectProfile } from "./profiles.ts";
import { printOptionalResourceAdvice } from "./resource-advice.ts";
import { routineCommand } from "./routine-commands.ts";
import { promptSecret } from "./secret-input.ts";
import { sizePolicyCommand } from "./size-policy-command.ts";
import { skillCommand } from "./skill-install.ts";
import { snapshotText } from "./snapshot-text.ts";
import { templateCommand } from "./template-commands.ts";
import { credsCommand, orgCommand, type VaultIo } from "./vault-commands.ts";

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export interface Deps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  readFile?: (path: string) => Promise<string>;
  /** Values for credential/application vault writes. By default hidden terminal input, or stdin when piped. */
  readStdin?: () => Promise<string>;
  /** Separate native Docker host binary boundary; no Armada session required. */
  localHost?: LocalHostIo;
  /** Set by auth tests. Otherwise login stores an Armada API session on this machine. */
  auth?: AuthIo;
}

/** Runs one command line and returns the process exit code. */
export async function run(argv: readonly string[], io: Io, deps: Deps = {}): Promise<number> {
  let signingIn = false;
  let auth: AuthIo | undefined;
  const sessionFailure = (error: unknown) =>
    error instanceof AuthError &&
    (error.code === "unauthorized" || (error instanceof ArmadaApiError && error.status === 401));
  try {
    // Native host management is login-free, including when a global profile flag is present.
    const localArgs = selectProfile(argv, {}).args;
    if (localArgs[0] === "host" && ["install", "status", "uninstall"].includes(localArgs[1] ?? ""))
      return await localHostCommand(
        localArgs.slice(1),
        io,
        deps.localHost ??
          productionLocalHostIo({
            ...(deps.fetch ? { fetch: deps.fetch } : {}),
            ...(deps.readStdin ? { readStdin: deps.readStdin } : {}),
          }),
      );
    if (
      localArgs.length === 1 &&
      [
        "snapshot",
        "golden",
        "host",
        "template",
        "routine",
        "vars",
        "secrets",
        "mcp",
        "creds",
        "org",
        "account",
        "github",
        "token",
        "skill",
      ].includes(localArgs[0] ?? "")
    ) {
      const family = localArgs[0] === "golden" ? "snapshot" : (localArgs[0] ?? "");
      if (family === "skill") return skillCommand(["--help"], io);
      io.out(onboardingHelp([family, "--help"]) ?? HELP);
      return 0;
    }
    const focusedHelp = onboardingHelp(localArgs);
    if (focusedHelp) {
      io.out(focusedHelp);
      return 0;
    }
    const selected = selectProfile(argv, deps.env ?? deps.auth?.env ?? process.env);
    argv = selected.args;
    deps = { ...deps, env: selected.env };
    if (selected.env.ARMADA_PROFILE !== undefined) {
      const stores = profileStores(selected.env);
      const env: NodeJS.ProcessEnv = { ...selected.env };
      const discovery =
        (argv.length === 1 && ["--help", "-h", "help", "--version", "-v"].includes(argv[0] ?? "")) ||
        (argv.length === 2 && ["--help", "-h"].includes(argv[1] ?? "")) ||
        argv[0] === "completion";
      if (!env.ARMADA_TOKEN && !discovery && argv[0] !== "logout") {
        const login = argv[0] === "login";
        const explicitLoginOrigin = login && argv.some((arg) => arg === "--url" || arg.startsWith("--url="));
        const saved = explicitLoginOrigin ? null : await stores.session.read();
        if (login) env.ARMADA_URL ??= saved?.armadaUrl;
        else if (saved || env.ARMADA_URL)
          env.ARMADA_URL = await resolveArmadaOrigin({ env, session: stores.session }, undefined, saved);
        if (!env.ARMADA_URL && !(login && argv.some((arg) => arg === "--url" || arg.startsWith("--url="))))
          throw new AuthError(
            `Configure this profile first: armada --profile ${env.ARMADA_PROFILE} login --url <server-origin>.`,
            "usage",
          );
      }
      deps = { ...deps, env, auth: { ...(deps.auth ?? productionAuthIo(io, env)), env, ...stores } };
    }
    auth = authOf(io, deps);
    try {
      if (argv.length === 0) {
        const client = await createArmadaApiClient(auth);
        await client.request("/api/v1/account/status", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
      }
      return await dispatch(argv, io, deps);
    } catch (error) {
      if (
        !sessionFailure(error) ||
        argv[0] === "login" ||
        argv[0] === "logout" ||
        (argv[0] === "account" && argv[1] === "logout") ||
        auth.env.ARMADA_TOKEN
      )
        throw error;
      if (!argv.includes("--json") && auth.interactive && auth.confirmSignIn && (await auth.confirmSignIn())) {
        signingIn = true;
        await loginCommand(auth);
        signingIn = false;
        // Retry the original operation once; a failed retry never starts another login.
        return await dispatch(argv, io, { ...deps, auth });
      }
      if (argv.length === 0) {
        io.err("You are not signed in. Run armada login.\n");
        io.out(HELP);
        return 3;
      }
      throw new AuthError("You are not signed in. Run armada login.", "unauthorized");
    }
  } catch (caught) {
    const error =
      sessionFailure(caught) && argv[0] !== "login" && !signingIn && !auth?.env.ARMADA_TOKEN
        ? new AuthError("You are not signed in. Run armada login.", "unauthorized")
        : caught;
    if (
      argv.includes("--json") &&
      (error instanceof GoldenError ||
        error instanceof LaunchError ||
        error instanceof VaultError ||
        error instanceof ProviderRoutingError ||
        error instanceof ProviderError ||
        error instanceof AuthError)
    ) {
      io.err(
        `${JSON.stringify({ error: { code: error instanceof ArmadaApiError ? error.serverCode : error.code, message: snapshotText(error.message), ...(error instanceof ArmadaApiError && error.legacyCode ? { legacyCode: error.legacyCode } : {}) } })}\n`,
      );
      return failureExitCode(error);
    }
    const printFailure = (message: string) =>
      io.err(
        `armada: ${snapshotText(message)}\n${(error instanceof ArmadaApiError && argv[0] === "launch") || (argv[0] === "host" && ["install", "status", "uninstall"].includes(argv[1] ?? "")) ? "" : failureHint(error, argv, Boolean(auth?.env.ARMADA_TOKEN))}`,
      );
    if (error instanceof GoldenError) {
      printFailure(error.message);
      return error.code === "invalid_config" ? 2 : 1;
    }
    if (error instanceof LaunchError) {
      if (error.sandboxId) io.err(`Sandbox ${error.sandboxId} is recorded as failed and its machine is stopped.\n`);
      printFailure(error.message);
      return error.code === "invalid_request" || error.code === "no_credentials" ? 2 : 1;
    }
    if (error instanceof VaultError) {
      printFailure(error.message);
      return error.code === "invalid" ? 2 : 1;
    }
    if (error instanceof ProviderRoutingError) {
      printFailure(error.message);
      return 1;
    }
    if (error instanceof ProviderError) {
      printFailure(error.message);
      return 1;
    }
    if (error instanceof AuthError) {
      printFailure(error.message);
      return failureExitCode(error);
    }
    throw error;
  }
}

/** Stable script contract, shared by human and JSON diagnostics. */
function failureExitCode(error: { code: string }): number {
  if (["invalid_config", "invalid_request", "invalid", "usage", "no_credentials"].includes(error.code)) return 2;
  return error.code === "unauthorized" || (error instanceof ArmadaApiError && error.status === 401) ? 3 : 1;
}

async function dispatch(argv: readonly string[], io: Io, deps: Deps): Promise<number> {
  const [requestedCommand, ...original] = argv;
  const command = requestedCommand === "snapshot" ? "golden" : requestedCommand;
  if (command === "skill") return skillCommand(original, io);
  // Command discovery must work before login or organization selection.
  if (
    command &&
    commandWords.includes(command) &&
    original.length === 1 &&
    ["--help", "-h"].includes(original[0] ?? "")
  ) {
    io.out(command === "logs" ? LOGS_HELP : HELP);
    return 0;
  }
  let rest = original;
  const terminator = rest.indexOf("--");
  const optionArgs = terminator < 0 ? rest : rest.slice(0, terminator);
  const scoped = [
    "doctor",
    "host",
    "golden",
    "launch",
    "list",
    "bind-credential",
    "detail",
    "status",
    "advice",
    "send",
    "report",
    "steer",
    "interrupt",
    "exec",
    "stop",
    "extend",
    "rm",
    "wait",
    "logs",
    "mcp",
  ];
  if (
    command &&
    (scoped.includes(command) ||
      (command === "org" && ["members", "setup", "connect"].includes(rest[0] ?? "")) ||
      (command === "creds" && rest[0] === "list") ||
      (command === "token" && rest[0] === "create")) &&
    !optionArgs.some((arg) => arg === "--org" || arg.startsWith("--org="))
  ) {
    const auth = authOf(io, deps);
    const selected = await auth.preferences?.read(await resolveArmadaOrigin(auth));
    if (selected) {
      const split = rest.indexOf("--");
      rest =
        split < 0 ? [...rest, "--org", selected] : [...rest.slice(0, split), "--org", selected, ...rest.slice(split)];
    }
  }
  switch (command) {
    case "--version":
    case "-v":
      io.out(`${VERSION}\n`);
      return 0;
    case undefined:
    case "--help":
    case "-h":
    case "help":
      io.out(HELP);
      return 0;
    case "doctor":
      return doctor(rest, { ...authOf(io, deps), ...io });
    case "completion":
      return completion(rest, io);
    case "host":
      return hostCommand(rest, { ...authOf(io, deps), ...io });
    case "golden":
      return golden(rest, io, deps);
    case "launch":
      return launch(rest, io, deps);
    case "list":
    case "bind-credential":
    case "detail":
    case "recovery":
    case "status":
    case "advice":
    case "send":
    case "report":
    case "steer":
    case "interrupt":
    case "exec":
    case "stop":
    case "extend":
    case "rm":
    case "wait":
    case "mcp":
      return operation(
        command,
        rest,
        authOf(io, deps),
        (path) =>
          path
            ? (deps.readFile ?? ((p) => Bun.file(p).text()))(path)
            : (
                deps.readStdin ??
                (() => (process.stdin.isTTY ? Promise.reject(new Error("stdin required")) : Bun.stdin.text()))
              )(),
        () => (deps.readStdin ? deps.readStdin() : process.stdin.isTTY ? Promise.resolve("") : Bun.stdin.text()),
      );
    case "logs":
      return logs(rest, io, deps);
    case "github":
    case "account":
      return accountCommand(command, rest, authOf(io, deps));
    case "login":
      return login(rest, io, deps);
    case "logout":
      return logout(rest, io, deps);
    case "org":
      return orgCommand(rest, vaultIo(io, deps));
    case "routine":
      return routineCommand(rest, vaultIo(io, deps, true));
    case "template":
      return templateCommand(rest, vaultIo(io, deps, true));
    case "vars":
    case "secrets":
      return applicationVaultCommand(command, rest, vaultIo(io, deps, true));
    case "creds":
      return credsCommand(rest, vaultIo(io, deps));
    case "token":
      return tokenCommand(parseAuth(rest), authOf(io, deps));
    default:
      throw new AuthError(`unknown command '${command}'. Run 'armada --help'.`, "usage");
  }
}

async function golden(argv: readonly string[], io: Io, deps: Deps): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    io.out(HELP);
    return subcommand === undefined ? 2 : 0;
  }
  if (subcommand === "size-policy")
    return sizePolicyCommand(rest, authOf(io, deps), (path) =>
      path ? (deps.readFile ?? ((p) => Bun.file(p).text()))(path) : (deps.readStdin ?? (() => Bun.stdin.text()))(),
    );
  const args = parseArgs(
    rest,
    subcommand === "retirement" ? ["--limit"] : ["--host", "--request-id"],
    subcommand === "update" ? ["--replace"] : [],
  );
  if (args.options.has("--add-repo") && subcommand !== "update")
    throw new GoldenError("invalid_config", "--add-repo is only supported by snapshot update.");
  if (single(args, "--provider") === "docker") {
    const auth = authOf(io, deps);
    return dockerSnapshotCommand(
      subcommand,
      args,
      io,
      { ...auth, fetch: deps.fetch ?? auth.fetch },
      subcommand === "create" ? await readConfig(args, deps) : undefined,
    );
  }
  const snapshotOptions: Record<string, readonly string[]> = {
    capabilities: ["--provider"],
    retirement: ["--limit", ...(args.positionals[0] === "reconcile" ? ["--file"] : [])],
    remove: ["--provider"],
    visibility: ["--visibility"],
    "build-cancel": [],
    "build-find": ["--provider"],
    "build-status": ["--idempotency-key"],
    create: ["--provider", "--private", "--config", "--repo", "--init", "--setup", "--idempotency-key", "--timeout"],
    update: [
      "--provider",
      "--replace",
      "--add-repo",
      "--config",
      "--repo",
      "--init",
      "--setup",
      "--idempotency-key",
      "--timeout",
    ],
    connect: ["--provider"],
    snapshot: ["--provider"],
    list: ["--provider"],
  };
  acceptedOptions(args, `snapshot ${subcommand}`, ["--org", "--json", ...(snapshotOptions[subcommand] ?? [])]);
  const provider = providerFlag(args);
  switch (subcommand) {
    case "capabilities": {
      if (args.positionals.length) throw new GoldenError("invalid_config", "golden capabilities takes no name.");
      const auth = authOf(io, deps);
      const client = await createArmadaApiClient({
        env: auth.env,
        fetch: deps.fetch ?? auth.fetch,
        session: auth.session,
      });
      const payload = await client.request<unknown>("/api/v1/golden/capabilities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(provider === undefined ? {} : { provider }),
          ...(single(args, "--org") === undefined ? {} : { org: single(args, "--org") }),
        }),
      });
      const data =
        payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
      if (
        !isSandboxProvider(data.provider) ||
        (provider !== undefined && provider !== data.provider) ||
        (data.maxGoldens !== null &&
          (typeof data.maxGoldens !== "number" || !Number.isSafeInteger(data.maxGoldens) || data.maxGoldens < 0))
      ) {
        throw new VaultError("unavailable", "Armada returned invalid or mismatched snapshot capabilities.");
      }
      const capabilities: { provider: SandboxProviderId; maxGoldens: number | null } = {
        provider: data.provider,
        maxGoldens: data.maxGoldens as number | null,
      };
      io.out(
        flag(args, "--json")
          ? `${JSON.stringify(capabilities)}\n`
          : `${capabilities.provider}: max snapshots ${capabilities.maxGoldens === null ? "unbounded/unknown" : capabilities.maxGoldens}\n`,
      );
      return 0;
    }
    case "retirement": {
      const [action, id, ...extra] = args.positionals;
      if (!["dry-run", "reconcile"].includes(action ?? "") || !id || extra.length)
        throw new GoldenError("invalid_config", "Use snapshot retirement dry-run|reconcile SNAPSHOT_UUID.");
      const client = await createArmadaApiClient({
        env: authOf(io, deps).env,
        fetch: deps.fetch ?? authOf(io, deps).fetch,
        session: authOf(io, deps).session,
      });
      let receipts: string[] = [];
      if (action === "reconcile") {
        try {
          const path = single(args, "--file");
          const text = path
            ? await (deps.readFile ?? ((p: string) => Bun.file(p).text()))(path)
            : await (
                deps.readStdin ??
                (() => (process.stdin.isTTY ? Promise.reject(new Error("stdin required")) : Bun.stdin.text()))
              )();
          const review = JSON.parse(text) as { results?: { receipt?: unknown }[] };
          receipts = (review.results ?? []).flatMap((r) => (typeof r.receipt === "string" ? [r.receipt] : []));
          if (!receipts.length || receipts.length > 50 || receipts.some((r) => !/^[a-f0-9]{64}$/.test(r)))
            throw Error("missing receipts");
        } catch {
          throw new GoldenError("invalid_config", "Supply reviewed dry-run JSON on stdin or --file.");
        }
      }
      const result = await client.request(`/api/v1/golden/retirement/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id,
          org: single(args, "--org"),
          limit: Number(single(args, "--limit") ?? 20),
          ...(action === "reconcile" ? { receipts } : {}),
        }),
      });
      io.out(`${JSON.stringify(result)}\n`);
      return 0;
    }
    case "remove": {
      const auth = authOf(io, deps);
      const client = await createArmadaApiClient({
        env: auth.env,
        fetch: deps.fetch ?? auth.fetch,
        session: auth.session,
      });
      let id = oneName(args.positionals);
      let org = single(args, "--org");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        const { goldens } = await client.request<{ goldens: GoldenRecord[] }>("/api/v1/golden/list", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...(org === undefined ? {} : { org }) }),
        });
        const matches = goldens.filter(
          (row) => row.name === id && (provider === undefined || row.provider === provider),
        );
        const match = matches[0];
        if (matches.length !== 1 || !match) {
          throw new GoldenError(
            matches.length ? "conflict" : "not_found",
            matches.length
              ? "More than one visible snapshot has this name. Select --provider and --org, or use the exact id from armada snapshot list --json. Nothing was removed."
              : "No visible snapshot matches this name and provider. Run armada snapshot list --json to check its name, id and organization. Nothing was removed.",
          );
        }
        id = match.id;
        org ??= match.orgId;
      }
      const result = await client.request("/api/v1/golden/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, org }),
      });
      io.out(`${JSON.stringify(result)}
`);
      return 0;
    }
    case "visibility": {
      const visibility = single(args, "--visibility");
      if (visibility !== "org" && visibility !== "private")
        throw new GoldenError("invalid_config", "Pass --visibility private|org.");
      const auth = authOf(io, deps);
      const client = await createArmadaApiClient({
        env: auth.env,
        fetch: deps.fetch ?? auth.fetch,
        session: auth.session,
      });
      const result = await client.request("/api/v1/golden/visibility", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: oneName(args.positionals), visibility, org: single(args, "--org") }),
      });
      io.out(`${JSON.stringify(result)}\n`);
      return 0;
    }
    case "build-cancel": {
      const auth = authOf(io, deps);
      const client = await createArmadaApiClient({
        env: auth.env,
        fetch: deps.fetch ?? auth.fetch,
        session: auth.session,
      });
      const job = await client.request<GoldenBuildStatus>("/api/v1/golden/build/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: oneName(args.positionals), org: single(args, "--org") }),
        signal: AbortSignal.timeout(10_000),
      });
      if (flag(args, "--json")) io.out(JSON.stringify(job) + "\n");
      else io.out(`Build ${job.jobId}: ${snapshotText(goldenBuildFailureText(job))}\n`);
      return 0;
    }
    case "build-find": {
      const name = oneName(args.positionals);
      const auth = authOf(io, deps);
      const client = await createArmadaApiClient(
        { env: auth.env, fetch: deps.fetch ?? auth.fetch, session: auth.session },
        { preserveServerErrors: true },
      );
      const result = await client.request<{ build: GoldenBuildStatus | null }>("/api/v1/golden/build/find", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, provider, org: single(args, "--org") }),
        signal: AbortSignal.timeout(10_000),
      });
      if (flag(args, "--json")) io.out(JSON.stringify(result) + "\n");
      else if (result.build) {
        io.out(
          `Build ${result.build.jobId}: ${result.build.state} (${result.build.phase}).\nRead details with armada snapshot build-status ${result.build.jobId}. Only its owner can cancel a queued, never-started build with snapshot build-cancel.\n`,
        );
      } else io.out("No visible active build was found. A reservation may still need administrator investigation.\n");
      return 0;
    }
    case "build-status": {
      const auth = authOf(io, deps);
      const client = await createArmadaApiClient({
        env: auth.env,
        fetch: deps.fetch ?? auth.fetch,
        session: auth.session,
      });
      const job = await client.request<GoldenBuildStatus>("/api/v1/golden/build/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobId: args.positionals[0],
          idempotencyKey: single(args, "--idempotency-key"),
          org: single(args, "--org"),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!flag(args, "--json") && (job.state === "failed" || job.state === "recovery_required"))
        io.err(`Build ${job.jobId}: ${snapshotText(goldenBuildFailureText(job))}\n`);
      io.out(JSON.stringify(job) + "\n");
      return job.state === "failed" || job.state === "recovery_required" ? 1 : 0;
    }
    case "create":
      return create(args.positionals, args, io, deps);
    case "update":
      return update(args.positionals, args, io, deps);
    case "connect":
      return connect(args, io, deps);
    case "snapshot":
      return snapshot(args, io, deps);
    case "list":
      return list(args, io, deps);
    default:
      throw new AuthError(`unknown command 'snapshot ${subcommand}'. Run 'armada --help'.`, "usage");
  }
}

async function admitGoldenBuild(
  client: import("./armada-api.ts").ArmadaApiClient,
  args: ReturnType<typeof parseArgs>,
  io: Io,
  deps: Deps,
  path: string,
  init: RequestInit,
): Promise<NonNullable<GoldenBuildStatus["result"]> | undefined> {
  const key = single(args, "--idempotency-key") ?? crypto.randomUUID();
  const seconds = Number(single(args, "--timeout") ?? "60");
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 600)
    throw new GoldenError("invalid_config", "Build --timeout must be 0–600 seconds (local polling only).");
  io.err(`Build admission key: ${key}. Recover with snapshot build-status --idempotency-key ${key} --org <org>.\n`);
  const job = await client.request<GoldenBuildStatus>(path, {
    ...init,
    body: JSON.stringify({ ...JSON.parse(String(init.body)), idempotencyKey: key }),
  });
  if (
    !job ||
    typeof job.jobId !== "string" ||
    !job.jobId ||
    typeof job.phase !== "string" ||
    !["queued", "running", "failed", "recovery_required", "succeeded"].includes(job.state)
  )
    throw new GoldenError(
      "build_failed",
      "The server did not return a durable build receipt; the CLI/server may be out of date and the operation may already have completed. Upgrade them together and inspect snapshot list before retrying; do not resubmit blindly.",
    );
  if (!flag(args, "--json")) io.out(`Build job: ${job.jobId}\n`);
  const deadline = AbortSignal.timeout(Math.max(1, seconds * 1000));
  let current = job;
  try {
    for (let attempt = 0; attempt < Math.ceil(seconds / 2); attempt++) {
      if (current.state === "succeeded") {
        for (const warning of current.result?.warnings ?? [])
          io.err(
            `Warning: ${warning}. ${warning === "skillpack_download_unavailable" ? "Skillpack was not provisioned: allow GitHub release egress before rebuilding for skills use." : "Skillpack is installed in the user-local bin directory."}\n`,
          );
        return current.result ?? undefined;
      }
      if (current.state === "failed" || current.state === "recovery_required")
        throw new GoldenError(
          "build_failed",
          `Build ${job.jobId}: ${current.state} (${goldenBuildFailureText(current)}).`,
        );
      deadline.throwIfAborted();
      await (deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(2000);
      current = await client.request<GoldenBuildStatus>("/api/v1/golden/build/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: job.jobId }),
        signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
      });
    }
  } catch (error) {
    if (error instanceof GoldenError) throw error;
    throw new GoldenError(
      "build_failed",
      `Polling stopped; build ${job.jobId} may still be running. Use snapshot build-status ${job.jobId}; do not resubmit.`,
    );
  }
  if (current.state === "succeeded") {
    for (const warning of current.result?.warnings ?? []) io.err(`Warning: ${warning}\n`);
    return current.result ?? undefined;
  }
  if (current.state === "failed" || current.state === "recovery_required")
    throw new GoldenError("build_failed", `Build ${job.jobId}: ${current.state} (${goldenBuildFailureText(current)}).`);
  if (flag(args, "--json")) io.out(`${JSON.stringify(current)}\n`);
  else io.out(`Build is ${current.state}. Resume with armada snapshot build-status ${job.jobId}.\n`);
  return undefined;
}

async function update(positionals: string[], args: ReturnType<typeof parseArgs>, io: Io, deps: Deps): Promise<number> {
  const name = oneName(positionals);
  const additions = values(args, "--add-repo");
  if (additions.length && ["--repo", "--config", "--init", "--setup"].some((key) => args.options.has(key)))
    throw new GoldenError(
      "invalid_config",
      "--add-repo preserves the stored config. Do not combine it with --repo, --config, --init or --setup; use --config for intentional replacement.",
    );
  if (additions.length && flag(args, "--replace"))
    throw new GoldenError(
      "invalid_config",
      "--replace cannot be combined with --add-repo; choose append or replacement.",
    );
  if (!additions.length && !flag(args, "--replace"))
    throw new GoldenError(
      "invalid_config",
      "Full replacement can drop stored repositories and init commands. Use --add-repo to append safely, or pass --replace with --repo/--config to confirm replacing the entire config.",
    );
  let config: GoldenConfig<string | undefined> | undefined;
  try {
    if (additions.length)
      configFromFlags(additions, []); // Never reconstruct the stored list.
    else config = await readConfig(args, deps);
  } catch (error) {
    if (error instanceof GoldenError)
      throw new GoldenError(
        error.code,
        `${error.message} Check config JSON/paths and use full GitHub git URLs (https://github.com/owner/repo.git[@branch]). Use --add-repo to append; --repo replaces the complete list.`,
      );
    throw error;
  }
  if (!additions.length)
    io.err(
      "Warning: --repo/--config replaces ALL stored repositories and init commands. To append without removing existing repositories, use --add-repo.\n",
    );
  const setupFile = single(args, "--setup");
  let setup: string | undefined;
  if (setupFile !== undefined) {
    try {
      setup = await (deps.readFile ?? ((path: string) => Bun.file(path).text()))(setupFile);
    } catch {
      throw new GoldenError("invalid_config", `Could not read setup file '${setupFile}'.`);
    }
  }
  const auth = authOf(io, deps);
  const client = await createArmadaApiClient(
    { env: auth.env, fetch: deps.fetch ?? auth.fetch, session: auth.session },
    { preserveServerErrors: true },
  );
  let result: Awaited<ReturnType<typeof admitGoldenBuild>>;
  try {
    result = await admitGoldenBuild(
      client,
      args,
      io,
      deps,
      additions.length ? "/api/v1/golden/update-add-repos" : "/api/v1/golden/update",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          ...(providerFlag(args) ? { provider: providerFlag(args) } : {}),
          ...(additions.length ? { addRepos: additions } : { config }),
          ...(single(args, "--org") === undefined ? {} : { org: single(args, "--org") }),
          ...(setup === undefined ? {} : { setup }),
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (error) {
    if (error instanceof ArmadaApiError) {
      const help =
        additions.length && error.status === 404 && !/No golden named/i.test(error.message)
          ? "This server does not support --add-repo. Upgrade the Armada server and CLI together, then retry. No replacement fallback was attempted."
          : error.status === 404
            ? "Run armada snapshot list --org <org> --json and select the exact name, organization and --provider."
            : /idempotency/i.test(error.message)
              ? "Recover the existing job with snapshot build-status --idempotency-key <key> --org <org>. Reuse a key only for the identical request."
              : /exists on boat and modal/i.test(error.message)
                ? "Repeat the update with --provider boat or --provider modal; no build was admitted."
                : error.status === 400
                  ? "Check the repository URL/branch and config. --repo replaces the full list; --add-repo preserves it. If required fields are rejected, upgrade the CLI and server together."
                  : /capacity or binding/i.test(error.message)
                    ? "For a rebuild, an administrator must distinguish a missing backend binding from an active/stale reservation. Check the existing build ID with snapshot build-status; do not create a second Boat snapshot."
                    : error.status === 403
                      ? "Use the snapshot owner (private) or org admin (shared). For GitHub access, grant the caller and Armada GitHub App access to every requested repository."
                      : error.status >= 500
                        ? "Check provider connection/billing and server configuration with an administrator. If the outcome is uncertain, recover the printed admission key before resubmitting."
                        : "Check the reported binding/build status before retrying; do not clear a live reservation.";
      throw new ArmadaApiError(error.serverCode, error.status, `${error.message} ${help}`);
    }
    throw error;
  }
  if (!result) return 0;
  if (flag(args, "--json")) {
    io.out(`${JSON.stringify(result)}\n`);
    return 0;
  }
  io.out(
    `Updated snapshot ${result.name} (${result.visibility}).\nSaved snapshot: ${result.snapshot}\n${config ? `Repos: ${config.repos.map((repo) => repo.dir).join(", ")}.` : "Existing repositories and init commands retained."}\n`,
  );
  return 0;
}

async function create(positionals: string[], args: ReturnType<typeof parseArgs>, io: Io, deps: Deps): Promise<number> {
  const name = oneName(positionals);
  const config = await readConfig(args, deps);
  const setupFile = single(args, "--setup");
  let setup: string | undefined;
  if (setupFile !== undefined) {
    const read = deps.readFile ?? ((path: string) => Bun.file(path).text());
    try {
      setup = await read(setupFile);
    } catch {
      throw new GoldenError("invalid_config", `Could not read setup file '${setupFile}'.`);
    }
  }
  const auth = authOf(io, deps);
  const client = await createArmadaApiClient(
    { env: auth.env, fetch: deps.fetch ?? auth.fetch, session: auth.session },
    { preserveServerErrors: true },
  );
  const result = await admitGoldenBuild(client, args, io, deps, "/api/v1/golden/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      ...(providerFlag(args) ? { provider: providerFlag(args) } : {}),
      config,
      ...(flag(args, "--private") ? { private: true } : {}),
      ...(single(args, "--org") === undefined ? {} : { org: single(args, "--org") }),
      ...(setup === undefined ? {} : { setup }),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!result) return 0;
  if (flag(args, "--json")) {
    io.out(`${JSON.stringify(result)}\n`);
    return 0;
  }
  io.out(
    `Created snapshot ${result.name} (${result.visibility}).\nSaved snapshot: ${result.snapshot}\nRepos: ${config.repos.map((repo) => repo.dir).join(", ")}.\n`,
  );
  return 0;
}

async function connect(args: ReturnType<typeof parseArgs>, io: Io, deps: Deps): Promise<number> {
  const name = oneName(args.positionals);
  const auth = authOf(io, deps);
  const client = await createArmadaApiClient({ env: auth.env, fetch: deps.fetch ?? auth.fetch, session: auth.session });
  const result = await client.request<{ golden: string; sandboxId: string; webUrl: string | null }>(
    "/api/v1/golden/connect",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        ...(providerFlag(args) ? { provider: providerFlag(args) } : {}),
        ...(single(args, "--org") === undefined ? {} : { org: single(args, "--org") }),
      }),
    },
  );
  if (flag(args, "--json")) io.out(`${JSON.stringify(result, null, 2)}\n`);
  else
    io.out(
      `Snapshot ${result.golden} is ready for setup.\nSandbox: ${result.sandboxId}${result.webUrl ? `\nURL: ${result.webUrl}` : ""}\n`,
    );
  return 0;
}
async function snapshot(args: ReturnType<typeof parseArgs>, io: Io, deps: Deps): Promise<number> {
  const name = oneName(args.positionals);
  const auth = authOf(io, deps);
  const client = await createArmadaApiClient({ env: auth.env, fetch: deps.fetch ?? auth.fetch, session: auth.session });
  const saved = await client.request<{ name: string; snapshot: string }>("/api/v1/golden/snapshot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      ...(providerFlag(args) ? { provider: providerFlag(args) } : {}),
      ...(single(args, "--org") === undefined ? {} : { org: single(args, "--org") }),
    }),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (flag(args, "--json")) {
    io.out(`${JSON.stringify(saved)}\n`);
    return 0;
  }
  io.out(`Saved snapshot ${saved.name}.\nSaved snapshot: ${saved.snapshot}\n`);
  return 0;
}

async function list(args: ReturnType<typeof parseArgs>, io: Io, deps: Deps): Promise<number> {
  if (args.positionals.length > 0) throw new GoldenError("invalid_config", "golden list takes no name.");
  const auth = authOf(io, deps);
  const client = await createArmadaApiClient({
    env: auth.env,
    fetch: deps.fetch ?? auth.fetch,
    session: auth.session,
    ...(auth.timeoutMs === undefined ? {} : { timeoutMs: auth.timeoutMs }),
  });
  const result = await client.request<{ goldens: GoldenRecord[] }>("/api/v1/golden/list", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(single(args, "--org") === undefined ? {} : { org: single(args, "--org") }) }),
  });
  const provider = providerFlag(args);
  const rows = result.goldens.filter((row) => provider === undefined || row.provider === provider);
  if (flag(args, "--json")) {
    io.out(`${JSON.stringify(rows.map(jsonGolden), null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    io.out("No snapshots.\n");
    return 0;
  }
  io.out(`${rows.map(line).join("\n")}\n`);
  return 0;
}

/** The control API serializes Date fields as ISO strings; convert only at the CLI boundary. */
type LaunchWireResult = Omit<LaunchResult, "expiresAt"> & { expiresAt?: string | null };

function decodeLaunchResult(result: LaunchWireResult): LaunchResult {
  const { expiresAt, ...launch } = result;
  return {
    ...launch,
    ...(expiresAt === null || expiresAt === undefined ? {} : { expiresAt: new Date(expiresAt) }),
  };
}

async function launch(argv: readonly string[], io: Io, deps: Deps): Promise<number> {
  argv = await prepareLaunch(argv, { ...authOf(io, deps), ...io });
  const args = parseArgs(
    argv,
    [
      "--size",
      "--skill",
      "--max-active-children",
      "--host",
      "--image",
      "--request-id",
      "--credential-version",
      "--variable",
      "--secret",
      "--golden",
    ],
    ["--sized", "--armada-access", "--keep-after-merge"],
  );
  if (single(args, "--provider") === "docker") {
    const auth = authOf(io, deps);
    return launchDocker(args, io, { ...auth, fetch: deps.fetch ?? auth.fetch });
  }
  if (
    ["--host", "--image", "--request-id", "--credential-version", "--golden", "--variable", "--secret"].some(
      (key) => single(args, key) !== undefined,
    )
  )
    throw new GoldenError("invalid_config", "Docker placement flags require --provider docker.");
  const maxActiveChildren = single(args, "--max-active-children");
  if (
    maxActiveChildren !== undefined &&
    (!flag(args, "--armada-access") || !/^[1-9][0-9]*$/.test(maxActiveChildren) || Number(maxActiveChildren) > 100)
  )
    throw new GoldenError(
      "invalid_config",
      "--max-active-children requires --armada-access and a limit from 1 to 100.",
    );
  const rawSize = single(args, "--size");
  const size = rawSize === undefined ? undefined : parseMachineSize(rawSize);
  if (flag(args, "--no-connections") && single(args, "--connections") !== undefined)
    throw new GoldenError("invalid_config", "Use --connections or --no-connections, not both.");
  const legacyVisibility = single(args, "--visibility");
  if (legacyVisibility !== undefined) {
    if (legacyVisibility !== "private" && legacyVisibility !== "org")
      throw new GoldenError("invalid_config", "Legacy --visibility must be private or org.");
    io.err(
      "Warning: --visibility is deprecated and ignored. The server enforces sandbox access and resolves omitted connection defaults.\n",
    );
  }
  const connections = single(args, "--connections");
  if (connections !== undefined && connections.split(",").some((id) => !id.trim()))
    throw new GoldenError(
      "invalid_config",
      "--connections needs a comma-separated list of nonempty IDs; use --no-connections to opt out.",
    );
  const [name, prompt, ...extra] = args.positionals;
  if (name === undefined || extra.length > 0) {
    throw new GoldenError("invalid_config", "Give a snapshot name and at most one prompt.");
  }
  const harness = harnessOf(single(args, "--agent"));
  const repo = single(args, "--repo");
  resolveModelChoice(harness, { model: single(args, "--model"), reasoningEffort: single(args, "--reasoning-effort") });
  const ttl = single(args, "--ttl");
  const ttlSeconds = ttl === undefined ? undefined : parseTtl(ttl);
  const auth = authOf(io, deps);
  const client = await createArmadaApiClient({
    env: auth.env,
    fetch: deps.fetch ?? auth.fetch,
    session: auth.session,
    ...(auth.timeoutMs === undefined ? {} : { timeoutMs: auth.timeoutMs }),
  });
  const sized = size !== undefined || repo !== undefined || flag(args, "--sized");
  const result = decodeLaunchResult(
    await client.request<LaunchWireResult>(
      flag(args, "--armada-access")
        ? "/api/v1/sandbox/launch-access-v1"
        : sized
          ? SIZED_LAUNCH_ROUTE_V1
          : "/api/v1/sandbox/launch",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(flag(args, "--no-connections") ? { connections: [] } : {}),
          ...(flag(args, "--keep-after-merge") ? { stopWhenWorkMerged: false } : {}),
          ...(values(args, "--skill").length ? { skills: values(args, "--skill") } : {}),
          ...(connections === undefined ? {} : { connections: connections.split(",") }),
          ...(flag(args, "--armada-access")
            ? {
                armadaAccessVersion: 1,
                armadaAccess: {
                  ...(maxActiveChildren === undefined ? {} : { maxActiveChildren: Number(maxActiveChildren) }),
                },
              }
            : {}),
          credentialId: single(args, "--credential-id"),
          golden: name,
          ...(sized ? { sizePolicyVersion: 1 } : {}),
          ...(size === undefined ? {} : { size }),
          ...(repo === undefined ? {} : { repo }),
          ...(providerFlag(args) ? { provider: providerFlag(args) } : {}),
          harness,
          ...(single(args, "--model") === undefined ? {} : { model: single(args, "--model") }),
          ...(single(args, "--reasoning-effort") === undefined
            ? {}
            : { reasoningEffort: single(args, "--reasoning-effort") }),
          ...(prompt === undefined ? {} : { prompt }),
          ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
          ...(single(args, "--org") === undefined ? {} : { org: single(args, "--org") }),
        }),
        signal: AbortSignal.timeout(10 * 60_000),
      },
    ),
  );
  io.out(
    flag(args, "--json") ? `${JSON.stringify(launchResponse(result), null, 2)}\n` : launchText(result, auth.now()),
  );
  if (
    size !== undefined &&
    (result.sandbox.machineSize?.requested !== size ||
      result.sandbox.machineSize?.effective !== size ||
      result.sandbox.machineSize?.source !== "override")
  ) {
    const message =
      "The sandbox was created, but the server did not confirm the requested size. Do not retry launch; inspect this sandbox and check server rollout compatibility.";
    io.err(
      flag(args, "--json")
        ? `${JSON.stringify({ warning: { code: "size_unconfirmed", message } })}\n`
        : `Warning: ${message}\n`,
    );
  }
  if (!flag(args, "--json"))
    await printOptionalResourceAdvice(client, result.sandbox.id, single(args, "--org"), io.err);
  return 0;
}

const FOLLOW_DELAY_MS = 1_000;

type LogsWireResult = {
  events: Awaited<ReturnType<Provider["events"]>>["events"];
  cursor: string | null;
  hasMore: boolean;
  settled: boolean;
};

async function logs(argv: readonly string[], io: Io, deps: Deps): Promise<number> {
  const normalized: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--tail") {
      normalized.push("--tail", /^\d+$/.test(argv[i + 1] ?? "") ? argv[++i]! : "100");
    } else normalized.push(arg);
  }
  const args = parseArgs(normalized, ["--tail"]);
  const tail = single(args, "--tail");
  const limit = tail === undefined ? undefined : Number(tail);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000))
    throw new GoldenError("invalid_config", "--tail must be between 1 and 1000.");
  if (tail !== undefined && (flag(args, "--all") || single(args, "--since")))
    throw new GoldenError("invalid_config", "--tail cannot be combined with --all or --since.");
  const org = single(args, "--org");
  let firstTail = tail !== undefined;
  const id = oneName(args.positionals);
  const all = flag(args, "--all");
  const follow = flag(args, "--follow");
  const auth = authOf(io, deps);
  const client = await createArmadaApiClient({
    env: auth.env,
    fetch: deps.fetch ?? auth.fetch,
    session: auth.session,
    ...(auth.timeoutMs === undefined ? {} : { timeoutMs: auth.timeoutMs }),
  });
  let settled = false;
  let cursor: string | null = single(args, "--since") ?? null;

  while (!settled) {
    const result: LogsWireResult = await client.request<LogsWireResult>("/api/v1/logs/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id,
        all,
        follow,
        ...(org === undefined ? {} : { org }),
        ...(firstTail ? { direction: "backward", limit } : {}),
        ...(cursor === null ? {} : { cursor }),
      }),
      // A server-side follow/read may wait for provider events; keep a bounded, endpoint-specific limit.
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (flag(args, "--json")) io.out(`${JSON.stringify(result, null, 2)}\n`);
    else for (const event of result.events) io.out(`${eventText(event)}\n`);
    if (firstTail) {
      firstTail = false;
      result.hasMore = false;
    }
    const nextCursor: string | null = result.cursor ?? cursor;
    const progressed = nextCursor !== cursor;
    if ((all || follow) && result.hasMore && !progressed) {
      throw new GoldenError("invalid_config", "Armada logs response has more events but did not advance its cursor.");
    }
    cursor = nextCursor;
    const drain = all || follow;
    settled = !drain || (!result.hasMore && (!follow || result.settled));
    // Pace only live polling, not pages the server already has available.
    if (!settled && !result.hasMore)
      await (deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(FOLLOW_DELAY_MS);
  }
  return 0;
}

function eventText(event: Awaited<ReturnType<Provider["events"]>>["events"][number]): string {
  if (event.kind === "message" || event.kind === "prompt" || event.kind === "steer") return event.text;
  if (
    event.kind === "other" &&
    event.type === "armada/modelRateLimit" &&
    event.data &&
    typeof event.data === "object"
  ) {
    const data = event.data as Record<string, unknown>;
    if (typeof data.message === "string")
      return `${data.message} (retry ${data.retryCount}, total wait ${Number(data.totalWaitMs) / 1000} s)`;
  }
  return JSON.stringify(event);
}

function harnessOf(value: string | undefined): Harness {
  const harness = HARNESSES.find((candidate) => candidate === value);
  if (!harness) throw new GoldenError("invalid_config", `Pass --agent ${HARNESSES.join(" or ")}.`);
  return harness;
}

function launchText(result: LaunchResult, now: Date): string {
  const { sandbox, golden } = result;
  const lines = [
    `Launched ${sandbox.harness} sandbox from snapshot ${golden.name}.`,
    "Access: enforced by the server; metadata hints do not grant interior access.",
    `Sandbox: ${sandbox.id}`,
    `${sandbox.provider === "boat" ? "Boat" : "Modal"} sandbox: ${sandbox.providerSandboxId}`,
    `Status: ${sandbox.status}`,
    ...(sandbox.machineSize
      ? [
          `Size: ${sandbox.machineSize.effective ?? "unknown (legacy)"} (requested ${sandbox.machineSize.requested ?? "none"}; source ${sandbox.machineSize.source}).`,
        ]
      : []),
    ...(sandbox.repositoryDir
      ? [`Repository context: ${sandbox.repositoryDir} (native agent cwd; not an isolation boundary).`]
      : []),
    ...(sandbox.skills?.map((skill) => `Skill: ${skill.reference} (${skill.checksum})`) ?? []),
    `Model: ${sandbox.model ?? "provider default"} (reasoning effort ${sandbox.reasoningEffort ?? "default"})`,
  ];
  if (sandbox.credentialId)
    lines.push(`Credential account: ${sandbox.credentialId} (revision ${sandbox.credentialVersion}).`);
  if (result.conversationId) lines.push(`Conversation: ${result.conversationId}`);
  else lines.push("No prompt sent: the sandbox is ready for the first prompt.");
  lines.push(githubLine(result, now));
  if (result.github.status === "connected" && result.github.message) lines.push(`Note: ${result.github.message}`);
  lines.push(
    result.expiresAt
      ? `Stops by itself at ${new Date(result.expiresAt).toISOString()} (TTL ${result.ttlSeconds}s).`
      : `Stops by itself after ${result.ttlSeconds}s.`,
  );
  return `${lines.join("\n")}\n`;
}

function githubLine(result: LaunchResult, now: Date): string {
  const { github } = result;
  if (github.status === "connected") {
    const expiry = github.tokenExpiresAt ? new Date(github.tokenExpiresAt) : null;
    const lifetime =
      expiry && Number.isFinite(expiry.getTime())
        ? `launch token expires at ${expiry.toISOString()} (~${Math.max(0, Math.floor((expiry.getTime() - now.getTime()) / 60_000))} minutes remaining)`
        : "launch token remaining lifetime unknown";
    const repair =
      result.sandbox.provider === "boat"
        ? `Use armada github refresh ${result.sandbox.id} for a running legacy sandbox; automatic next-prompt repair is experimental and off by default.`
        : "Reconnect GitHub if needed and resume to re-resolve credentials.";
    return `GitHub: git and gh act as ${github.login} (${lifetime}; shared owner refresh may invalidate it earlier). ${repair}`;
  }
  return `GitHub: not set up. ${github.message ?? ""}`.trim();
}

function line(row: GoldenRecord): string {
  const snapshot = row.providerSnapshotId ? "snapshot" : "no snapshot";
  const repos = row.config.repos.length === 1 ? "1 repo" : `${row.config.repos.length} repos`;
  return `${row.name}  ${row.provider}  ${row.visibility}  ${snapshot}  ${repos}`;
}

function jsonGolden(row: GoldenRecord) {
  return { ...goldenResponse(row), buildWarnings: row.buildWarnings ?? [] };
}

async function readConfig(args: ReturnType<typeof parseArgs>, deps: Deps): Promise<GoldenConfig<string | undefined>> {
  const file = single(args, "--config");
  const repos = values(args, "--repo");
  // --setup is its own field now (create() reads it as a local file and sends its content),
  // not a legacy alias folded into --init: a value here must not also become a literal init command.
  const init = values(args, "--init");
  if (file && (repos.length > 0 || init.length > 0)) {
    throw new GoldenError("invalid_config", "Pass either --config or --repo and --init, not both.");
  }
  if (file) {
    const read = deps.readFile ?? ((path: string) => Bun.file(path).text());
    let text: string;
    try {
      text = await read(file);
    } catch {
      throw new GoldenError("invalid_config", `Could not read config file '${file}'.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new GoldenError("invalid_config", `Config file '${file}' is not JSON.`);
    }
    return parseSnapshotConfig(parsed);
  }
  return configFromFlags(repos, init, "snapshot");
}

function oneName(positionals: string[]): string {
  const name = positionals[0];
  if (name === undefined || positionals.length !== 1) {
    throw new GoldenError("invalid_config", "Give exactly one snapshot name.");
  }
  return name;
}

async function login(argv: readonly string[], io: Io, deps: Deps): Promise<number> {
  const parsed = parseAuth(argv);
  rejectUnknown(parsed.flags, ["provider", "email", "url", "json"]);
  if (parsed.position.length > 0) throw new AuthError("Run armada login --help.", "usage");
  if (parsed.flags.has("provider") && parsed.flags.has("email")) {
    throw new AuthError("Use --provider or --email, not both.", "usage");
  }
  const provider = parsed.flags.has("provider") ? assertProvider(authFlag(parsed.flags, "provider")) : undefined;
  const email = parsed.flags.has("email") ? authFlag(parsed.flags, "email") : undefined;
  await loginCommand(authOf(io, deps), {
    provider,
    email,
    url: parsed.flags.get("url"),
    json: parsed.flags.has("json"),
  });
  return 0;
}

async function logout(argv: readonly string[], io: Io, deps: Deps): Promise<number> {
  const parsed = parseAuth(argv);
  rejectUnknown(parsed.flags, ["json"]);
  if (parsed.position.length > 0) throw new AuthError("Run armada logout.", "usage");
  await logoutCommand(authOf(io, deps), parsed.flags.has("json"));
  return 0;
}

async function tokenCommand(parsed: AuthArgs, auth: AuthIo): Promise<number> {
  const sub = parsed.position[0];
  const extra = parsed.position[1];
  switch (sub) {
    case "create":
      rejectUnknown(parsed.flags, ["org", "label", "json"]);
      if (extra !== undefined) throw new AuthError("Run armada token create --org <name> --label <label>.", "usage");
      await tokenCreate(auth, parsed.flags.get("org"), parsed.flags.get("label"), parsed.flags.has("json"));
      return 0;
    case "list":
      rejectUnknown(parsed.flags, ["json"]);
      if (extra !== undefined) throw new AuthError("Run armada token list.", "usage");
      await tokenList(auth, parsed.flags.has("json"));
      return 0;
    case "revoke":
      rejectUnknown(parsed.flags, ["json"]);
      if (!extra || parsed.position.length > 2) throw new AuthError("Run armada token revoke <id>.", "usage");
      await tokenRevoke(auth, extra, parsed.flags.has("json"));
      return 0;
    default:
      throw new AuthError("Run armada token create, list, or revoke.", "usage");
  }
}

interface AuthArgs {
  position: string[];
  flags: Map<string, string>;
}

function parseAuth(argv: readonly string[]): AuthArgs {
  const position: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      position.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      position.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (name === "json" && eq === -1) {
      flags.set("json", "true");
      continue;
    }
    if (name.length === 0) throw new AuthError("Unknown flag.", "usage");
    const value = eq === -1 ? argv[index + 1] : arg.slice(eq + 1);
    if (eq === -1) {
      if (value === undefined || value.startsWith("--")) throw new AuthError(`Missing value for --${name}.`, "usage");
      index += 1;
    }
    if (value === undefined) throw new AuthError(`Missing value for --${name}.`, "usage");
    flags.set(name, value);
  }
  return { position, flags };
}

function authFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) throw new AuthError(`Missing value for --${name}.`, "usage");
  return value;
}

function rejectUnknown(flags: Map<string, string>, allowed: readonly string[]): void {
  for (const name of flags.keys()) {
    if (!allowed.includes(name)) throw new AuthError(`Unknown flag --${name}.`, "usage");
  }
}

function authOf(io: Io, deps: Deps): AuthIo {
  return deps.auth ?? productionAuthIo(io, deps.env ?? process.env);
}

function vaultIo(io: Io, deps: Deps, strictUtf8 = false): VaultIo {
  return {
    auth: authOf(io, deps),
    readFile:
      deps.readFile ??
      (async (path) =>
        strictUtf8
          ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await Bun.file(path).arrayBuffer())
          : Bun.file(path).text()),
    readStdin:
      deps.readStdin ??
      (async () => {
        if (process.stdin.isTTY) return promptSecret();
        return strictUtf8
          ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await Bun.stdin.arrayBuffer())
          : Bun.stdin.text();
      }),
  };
}
