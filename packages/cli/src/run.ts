import { AuthError } from "@armada/auth";
import {
  configFromFlags,
  type GoldenBuildStatus,
  type GoldenConfig,
  GoldenError,
  type GoldenRecord,
  goldenBuildFailureText,
  goldenResponse,
  isSandboxProvider,
  LaunchError,
  ProviderError,
  ProviderRoutingError,
  parseSnapshotConfig,
  type SandboxProviderId,
  VaultError,
  VERSION,
} from "@armada/core";
import { acceptedOptions, flag, oneName, parseArgs, providerFlag, single, values } from "./args.ts";
import { ArmadaApiError, createArmadaApiClient, resolveArmadaOrigin } from "./armada-api.ts";
import { type AuthIo, loginCommand, productionAuthIo } from "./auth-commands.ts";
import { commandWords, HELP } from "./command-catalog.ts";
import { findCommand, focusedHelp } from "./commands/index.ts";
import { dockerSnapshotCommand } from "./docker-snapshots.ts";
import { failureHint } from "./failure-hint.ts";
import { type LocalHostIo, localHostCommand, productionLocalHostIo } from "./local-host.ts";
import { profileStores, selectProfile } from "./profiles.ts";
import { sizePolicyCommand } from "./size-policy-command.ts";
import { skillCommand } from "./skill-install.ts";
import { snapshotText } from "./snapshot-text.ts";

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
    if (localArgs.length === 1 && localArgs[0] === "skill") return skillCommand(["--help"], io);
    const bareCommand = localArgs.length === 1 ? findCommand(localArgs[0] ?? "") : undefined;
    if (bareCommand?.helpWhenBare) {
      io.out(bareCommand.help);
      return 0;
    }
    const help = focusedHelp(localArgs);
    if (help) {
      const registered = localArgs.length === 2 ? findCommand(localArgs[0] ?? "") : undefined;
      if (registered?.validateProfileForHelp) selectProfile(argv, deps.env ?? deps.auth?.env ?? process.env);
      io.out(help);
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
        await client.control("account/status", {});
      }
      return await dispatch(argv, io, deps);
    } catch (error) {
      if (
        !sessionFailure(error) ||
        argv[0] === "api" ||
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
  const [command, ...original] = argv;
  if (command === "skill") return skillCommand(original, io);
  // Command discovery must work before login or organization selection.
  if (
    command &&
    commandWords.includes(command) &&
    original.length === 1 &&
    ["--help", "-h"].includes(original[0] ?? "")
  ) {
    io.out(HELP);
    return 0;
  }
  const registered = command ? findCommand(command) : undefined;
  let rest = original;
  const terminator = rest.indexOf("--");
  const optionArgs = terminator < 0 ? rest : rest.slice(0, terminator);
  const useSelectedOrg = registered?.useSelectedOrg;
  const commandUsesSelection =
    typeof useSelectedOrg === "function" ? useSelectedOrg(rest) : registered && useSelectedOrg !== false;
  if (command && commandUsesSelection && !optionArgs.some((arg) => arg === "--org" || arg.startsWith("--org="))) {
    const auth = authOf(io, deps);
    const selected = await auth.preferences?.read(await resolveArmadaOrigin(auth));
    if (selected) {
      const split = rest.indexOf("--");
      rest =
        split < 0 ? [...rest, "--org", selected] : [...rest.slice(0, split), "--org", selected, ...rest.slice(split)];
    }
  }
  if (registered) return registered.run(rest, { io, deps, auth: authOf(io, deps) });
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
    default:
      throw new AuthError(`unknown command '${command}'. Run 'armada --help'.`, "usage");
  }
}

export async function snapshotCommand(argv: readonly string[], io: Io, deps: Deps): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    io.out(HELP);
    return subcommand === undefined ? 2 : 0;
  }
  if (subcommand === "size-policy")
    return sizePolicyCommand(rest, authOf(io, deps), (path) =>
      path ? (deps.readFile ?? ((p) => Bun.file(p).text()))(path) : (deps.readStdin ?? (() => Bun.stdin.text()))(),
    );
  const snapshotOptions: Record<string, readonly string[]> = {
    capabilities: ["--provider"],
    retirement: ["--limit"],
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
    get: [],
    rebuild: [],
    list: ["--provider"],
  };
  if (!Object.hasOwn(snapshotOptions, subcommand))
    throw new AuthError(`unknown command 'snapshot ${subcommand}'. Run 'armada --help'.`, "usage");
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
  acceptedOptions(args, `snapshot ${subcommand}`, [
    "--org",
    "--json",
    ...(snapshotOptions[subcommand] ?? []),
    ...(subcommand === "retirement" && args.positionals[0] === "reconcile" ? ["--file"] : []),
  ]);
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
      const payload = await client.golden<unknown>("capabilities", {
        ...(provider === undefined ? {} : { provider }),
        ...(single(args, "--org") === undefined ? {} : { org: single(args, "--org") }),
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
      if ((action !== "dry-run" && action !== "reconcile") || !id || extra.length)
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
      const result = await client.golden(`retirement/${action}`, {
        id,
        org: single(args, "--org"),
        limit: Number(single(args, "--limit") ?? 20),
        ...(action === "reconcile" ? { receipts } : {}),
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
        const { goldens } = await client.golden<{ goldens: GoldenRecord[] }>("list", {
          ...(org === undefined ? {} : { org }),
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
      const result = await client.golden("remove", { id, org });
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
      const result = await client.golden("visibility", {
        id: oneName(args.positionals),
        visibility,
        org: single(args, "--org"),
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
      const job = await client.golden<GoldenBuildStatus>(
        "build/cancel",
        { jobId: oneName(args.positionals), org: single(args, "--org") },
        AbortSignal.timeout(10_000),
      );
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
      const result = await client.golden<{ build: GoldenBuildStatus | null }>(
        "build/find",
        { name, provider, org: single(args, "--org") },
        AbortSignal.timeout(10_000),
      );
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
      const job = await client.golden<GoldenBuildStatus>(
        "build/status",
        {
          jobId: args.positionals[0],
          idempotencyKey: single(args, "--idempotency-key"),
          org: single(args, "--org"),
        },
        AbortSignal.timeout(10_000),
      );
      if (!flag(args, "--json") && (job.state === "failed" || job.state === "recovery_required"))
        io.err(`Build ${job.jobId}: ${snapshotText(goldenBuildFailureText(job))}\n`);
      io.out(JSON.stringify(job) + "\n");
      return job.state === "failed" || job.state === "recovery_required" ? 1 : 0;
    }
    case "create":
      return create(args.positionals, args, io, deps);
    case "update":
      return update(args.positionals, args, io, deps);
    case "list":
      return list(args, io, deps);
    default:
      throw new AuthError(`unknown command 'snapshot ${subcommand}'. Run 'armada --help'.`, "usage");
  }
}

async function admitGoldenBuild(
  client: import("./armada-api.ts").ArmadaCommandClient,
  args: ReturnType<typeof parseArgs>,
  io: Io,
  deps: Deps,
  operation: "create" | "update" | "update-add-repos",
  body: Record<string, unknown>,
): Promise<NonNullable<GoldenBuildStatus["result"]> | undefined> {
  const key = single(args, "--idempotency-key") ?? crypto.randomUUID();
  const seconds = Number(single(args, "--timeout") ?? "60");
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 600)
    throw new GoldenError("invalid_config", "Build --timeout must be 0–600 seconds (local polling only).");
  io.err(`Build admission key: ${key}. Recover with snapshot build-status --idempotency-key ${key} --org <org>.\n`);
  const job = await client.golden<GoldenBuildStatus>(
    operation,
    { ...body, idempotencyKey: key },
    AbortSignal.timeout(10_000),
  );
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
      current = await client.golden<GoldenBuildStatus>(
        "build/status",
        { jobId: job.jobId },
        AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
      );
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
    result = await admitGoldenBuild(client, args, io, deps, additions.length ? "update-add-repos" : "update", {
      name,
      ...(providerFlag(args) ? { provider: providerFlag(args) } : {}),
      ...(additions.length ? { addRepos: additions } : { config }),
      ...(single(args, "--org") === undefined ? {} : { org: single(args, "--org") }),
      ...(setup === undefined ? {} : { setup }),
    });
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
  const result = await admitGoldenBuild(client, args, io, deps, "create", {
    name,
    ...(providerFlag(args) ? { provider: providerFlag(args) } : {}),
    config,
    ...(flag(args, "--private") ? { private: true } : {}),
    ...(single(args, "--org") === undefined ? {} : { org: single(args, "--org") }),
    ...(setup === undefined ? {} : { setup }),
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

async function list(args: ReturnType<typeof parseArgs>, io: Io, deps: Deps): Promise<number> {
  if (args.positionals.length > 0) throw new GoldenError("invalid_config", "golden list takes no name.");
  const auth = authOf(io, deps);
  const client = await createArmadaApiClient({
    env: auth.env,
    fetch: deps.fetch ?? auth.fetch,
    session: auth.session,
    ...(auth.timeoutMs === undefined ? {} : { timeoutMs: auth.timeoutMs }),
  });
  const result = await client.golden<{ goldens: GoldenRecord[] }>("list", {
    ...(single(args, "--org") === undefined ? {} : { org: single(args, "--org") }),
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

function authOf(io: Io, deps: Deps): AuthIo {
  return deps.auth ?? productionAuthIo(io, deps.env ?? process.env);
}
