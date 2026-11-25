import { AuthError } from "@armada/auth";
import {
  configFromFlags,
  type GoldenBuildStatus,
  type GoldenConfig,
  GoldenError,
  type GoldenRecord,
  goldenBuildFailureText,
  goldenResponse,
  LaunchError,
  ProviderError,
  ProviderRoutingError,
  parseSnapshotConfig,
  VaultError,
  VERSION,
} from "@armada/core";
import { ArmadaApiError } from "./api-responses.ts";
import {
  type Args,
  acceptedOptions,
  flag,
  jsonRequested,
  oneName,
  parseArgs,
  providerFlag,
  single,
  usesHostLaunch,
  uuid,
  values,
  withJsonFlag,
} from "./args.ts";
import { type AuthIo, loginCommand, productionAuthIo } from "./auth-commands.ts";
import { commandWords, HELP } from "./command-catalog.ts";
import { findCommand, focusedHelp } from "./commands/index.ts";
import type { CurrentSandboxFile } from "./current-sandbox.ts";
import { dockerSnapshotCommand } from "./docker-snapshots.ts";
import { failureHint } from "./failure-hint.ts";
import { type LocalHostIo, localHostCommand, productionLocalHostIo } from "./local-host.ts";
import { profileStores, selectProfile } from "./profiles.ts";
import type { RelayDeps } from "./relay-session.ts";
import { createSdkCommandClient, resolveArmadaOrigin } from "./sdk-session.ts";
import { skillCommand } from "./skill-install.ts";
import { snapshotText } from "./snapshot-text.ts";
import { waitForSnapshot } from "./snapshot-wait.ts";

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export interface Deps {
  stdoutIsTTY?: boolean;
  sandboxFile?: CurrentSandboxFile;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  readFile?: (path: string) => Promise<string>;
  readStdin?: () => Promise<string>;
  localHost?: LocalHostIo;
  auth?: AuthIo;
  relay?: RelayDeps;
}

export async function run(argv: readonly string[], io: Io, deps: Deps = {}): Promise<number> {
  const machineOutput = deps.stdoutIsTTY === false || jsonRequested(argv);
  const writeFailure = (code: string, message: string, hint: string | null) =>
    io.err(`${JSON.stringify({ error: { code, message, hint } })}\n`);
  const finish = (exitCode: number) => {
    if (machineOutput && exitCode !== 0) {
      const code = exitCode === 2 ? "usage" : exitCode === 3 ? "unauthorized" : "command_failed";
      const message = "Armada could not complete the command.";
      writeFailure(code, message, failureHint({ code, message }, argv, Boolean(auth?.env.ARMADA_TOKEN)).trim());
    }
    return exitCode;
  };
  let signingIn = false;
  let auth: AuthIo | undefined;
  const sessionFailure = (error: unknown) =>
    error instanceof AuthError &&
    (error.code === "unauthorized" || (error instanceof ArmadaApiError && error.status === 401));
  try {
    const localArgs = selectProfile(argv, {}).args;
    if (localArgs[0] === "host" && localArgs[1] === "install")
      return finish(
        await localHostCommand(
          localArgs.slice(2),
          io,
          deps.localHost ??
            productionLocalHostIo({
              ...(deps.fetch ? { fetch: deps.fetch } : {}),
              ...(deps.readStdin ? { readStdin: deps.readStdin } : {}),
            }),
        ),
      );
    if (localArgs.length === 1 && localArgs[0] === "skill") return finish(await skillCommand(["--help"], io));
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
    const [name, verb] = localArgs;
    const family = name ? findCommand(name) : undefined;
    if (family?.requireKnownSubcommand && verb && !Object.hasOwn(family.subcommandHelp ?? {}, `${name} ${verb}`)) {
      throw new AuthError(`unknown command '${name} ${verb}'. Run 'armada --help'.`, "usage");
    }
    const selected = selectProfile(argv, deps.env ?? deps.auth?.env ?? process.env);
    argv = selected.args;
    deps = { ...deps, env: selected.env };
    const command = argv[0];
    if (
      selected.env.ARMADA_PROFILE !== undefined &&
      (command === undefined || command === "skill" || findCommand(command))
    ) {
      const stores = profileStores(selected.env);
      const env: NodeJS.ProcessEnv = { ...selected.env };
      const discovery = (argv.length === 2 && ["--help", "-h"].includes(argv[1] ?? "")) || command === "completion";
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
        const client = await createSdkCommandClient(auth);
        await client.control("account/status", {});
      }
      return finish(await dispatch(argv, io, deps));
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
      if (!machineOutput && auth.interactive && auth.confirmSignIn && (await auth.confirmSignIn())) {
        signingIn = true;
        await loginCommand(auth);
        signingIn = false;
        return finish(await dispatch(argv, io, { ...deps, auth }));
      }
      if (argv.length === 0 && !machineOutput) {
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
    const renderMessage =
      error instanceof AuthError && error.code === "usage" ? (message: string) => message : snapshotText;
    if (machineOutput) {
      const known =
        error instanceof GoldenError ||
        error instanceof LaunchError ||
        error instanceof VaultError ||
        error instanceof ProviderRoutingError ||
        error instanceof ProviderError ||
        error instanceof AuthError;
      writeFailure(
        error instanceof ArmadaApiError ? error.serverCode : known ? error.code : "internal_error",
        known ? renderMessage(error.message) : "Armada could not complete the command.",
        failureHint(known ? error : {}, argv, Boolean(auth?.env.ARMADA_TOKEN)).trim() || null,
      );
      return known ? failureExitCode(error) : 1;
    }
    const printFailure = (message: string) =>
      io.err(
        `armada: ${renderMessage(message)}\n${(error instanceof ArmadaApiError && argv[0] === "new") || (argv[0] === "host" && argv[1] === "install") ? "" : failureHint(error, argv, Boolean(auth?.env.ARMADA_TOKEN))}`,
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

function failureExitCode(error: { code: string }): number {
  if (["invalid_config", "invalid_request", "invalid", "usage", "no_credentials"].includes(error.code)) return 2;
  return error.code === "unauthorized" || (error instanceof ArmadaApiError && error.status === 401) ? 3 : 1;
}

async function dispatch(argv: readonly string[], io: Io, deps: Deps): Promise<number> {
  const [command, ...original] = argv;
  if (command === "skill") return skillCommand(original, io);
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
  let rest = deps.stdoutIsTTY === false && registered?.automaticJson ? withJsonFlag(original) : original;
  const terminator = rest.indexOf("--");
  const optionArgs = terminator < 0 ? rest : rest.slice(0, terminator);
  const useSelectedOrg = registered?.useSelectedOrg;
  const commandUsesSelection = typeof useSelectedOrg === "function" ? useSelectedOrg(rest) : useSelectedOrg === true;
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

const configOptions = ["--config", "--repo", "--init"];
const buildOptions = [...configOptions, "--setup", "--idempotency-key", "--wait", "--timeout"];
const options = {
  ls: [],
  new: [...buildOptions, "--private"],
  update: [...buildOptions, "--replace", "--add-repo"],
  rebuild: [],
  rm: [],
  show: ["--build", "--idempotency-key"],
} satisfies Record<string, readonly string[]>;
type Verb = keyof typeof options;

export async function snapshotCommand([verb, ...rest]: readonly string[], io: Io, deps: Deps) {
  if (!verb || !Object.hasOwn(options, verb))
    throw new AuthError(`unknown command 'snapshot ${verb}'. Run 'armada --help'.`, "usage");

  const auth = authOf(io, deps);
  const operation = verb as Verb;
  const args = parseArgs(rest, ["--host", "--request-id", "--build"], ["--replace", "--wait"]);
  if (usesHostLaunch(single(args, "--provider"))) {
    return dockerSnapshotCommand(
      operation,
      args,
      io,
      { ...auth, fetch: deps.fetch ?? auth.fetch },
      deps.sleep,
      () => readConfig(args, deps),
      () => buildWaitSeconds(args),
    );
  }
  acceptedOptions(args, `snapshot ${operation}`, ["--org", "--provider", "--json", ...options[operation]]);
  const provider = providerFlag(args);
  if (operation === "rebuild") throw new GoldenError("invalid_config", "snapshot rebuild requires --provider docker.");
  if (operation === "new") return create(args.positionals, args, io, deps);
  if (operation === "update") return update(args.positionals, args, io, deps);
  if (operation === "ls") return list(args, io, deps);

  const org = single(args, "--org");
  const jobId = single(args, "--build");
  const idempotencyKey = single(args, "--idempotency-key");
  if (jobId !== undefined || idempotencyKey !== undefined) {
    if (
      args.positionals.length ||
      provider ||
      (jobId !== undefined && (idempotencyKey !== undefined || org !== undefined)) ||
      (idempotencyKey !== undefined && !org)
    )
      throw new GoldenError(
        "invalid_config",
        "Use snapshot show --build JOB_ID or --idempotency-key KEY --org ORG_UUID.",
      );
    if (idempotencyKey !== undefined) uuid(org, "--org");
    const client = await createSdkCommandClient({ ...auth, fetch: deps.fetch ?? auth.fetch });
    const job = await client.golden<GoldenBuildStatus>("build/status", { jobId, idempotencyKey, org });
    io.out(`${JSON.stringify(job)}\n`);
    if (job.state === "failed" || job.state === "recovery_required")
      throw new GoldenError("build_failed", `Build ${job.jobId}: ${goldenBuildFailureText(job)}`);
    return 0;
  }

  const selector = oneName(args.positionals);
  const client = await createSdkCommandClient({ ...auth, fetch: deps.fetch ?? auth.fetch });
  const isId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(selector);
  if (operation === "rm" && isId && !provider) {
    io.out(`${JSON.stringify(await client.golden("remove", { id: selector, org }))}\n`);
    return 0;
  }
  const { goldens } = await client.golden<{ goldens: GoldenRecord[] }>("list", { org });
  const matches = goldens.filter(
    (row) =>
      (isId ? row.id.toLowerCase() === selector.toLowerCase() : row.name === selector) &&
      (!provider || row.provider === provider),
  );
  const [row] = matches;
  if (matches.length !== 1 || !row)
    throw new GoldenError(
      matches.length ? "conflict" : "not_found",
      matches.length
        ? "More than one visible snapshot has this name. Select --provider and --org, or use the exact id from armada snapshot ls --json. Nothing was removed."
        : "No visible snapshot matches this selection. Run armada snapshot ls --json to check its name, id and organization. Nothing was removed.",
    );
  const result =
    operation === "show" ? jsonGolden(row) : await client.golden("remove", { id: row.id, org: org ?? row.orgId });
  io.out(`${JSON.stringify(result)}\n`);
  return 0;
}

function buildWaitSeconds(args: Args) {
  const timeout = single(args, "--timeout");
  if (!flag(args, "--wait")) {
    if (timeout !== undefined) throw new GoldenError("invalid_config", "Pass --wait to use --timeout.");
    return 0;
  }
  const seconds = Number(timeout ?? "60");
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600)
    throw new GoldenError("invalid_config", "Build --timeout must be 1–600 seconds.");
  return seconds;
}

async function admitGoldenBuild(
  client: import("./sdk-session.ts").ArmadaCommandClient,
  args: ReturnType<typeof parseArgs>,
  io: Io,
  deps: Deps,
  operation: "create" | "update" | "update-add-repos",
  body: Record<string, unknown>,
): Promise<(NonNullable<GoldenBuildStatus["result"]> & { jobId: string }) | undefined> {
  const key = single(args, "--idempotency-key") ?? crypto.randomUUID();
  const seconds = buildWaitSeconds(args);
  io.err(`Build admission key: ${key}. Recover with snapshot show --idempotency-key ${key} --org ORG_UUID.\n`);
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
      "The server did not return a durable build receipt; the CLI/server may be out of date and the operation may already have completed. Upgrade them together and inspect snapshot ls before retrying; do not resubmit blindly.",
    );
  if (!flag(args, "--json")) io.out(`Build job: ${job.jobId}\n`);
  let current: GoldenBuildStatus;
  try {
    current = await waitForSnapshot(
      job,
      seconds,
      deps.sleep,
      ({ state }) => state === "queued" || state === "running",
      (signal) => client.golden<GoldenBuildStatus>("build/status", { jobId: job.jobId }, signal),
    );
  } catch (error) {
    if (error instanceof GoldenError) throw error;
    throw new GoldenError(
      "build_failed",
      `Polling stopped; build ${job.jobId} may still be running. Use snapshot show --build ${job.jobId}; do not resubmit.`,
    );
  }
  if (seconds > 0 && current.state === "succeeded") {
    for (const warning of current.result?.warnings ?? [])
      io.err(
        `Warning: ${warning}. ${warning === "skillpack_download_unavailable" ? "Skillpack was not provisioned: allow GitHub release egress before rebuilding for skills use." : "Skillpack is installed in the user-local bin directory."}\n`,
      );
    return current.result ? { ...current.result, jobId: job.jobId } : undefined;
  }
  if (current.state === "failed" || current.state === "recovery_required")
    throw new GoldenError("build_failed", `Build ${job.jobId}: ${current.state} (${goldenBuildFailureText(current)}).`);
  if (flag(args, "--json")) io.out(`${JSON.stringify(current)}\n`);
  else io.out(`Build is ${current.state}. Resume with armada snapshot show --build ${job.jobId}.\n`);
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
    if (additions.length) configFromFlags(additions, []);
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
  const client = await createSdkCommandClient(
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
          ? "Check the update route with an administrator before retrying."
          : error.status === 404
            ? "Run armada snapshot ls --org <org> --json and select the exact name, organization and --provider."
            : /idempotency/i.test(error.message)
              ? "Recover the existing job with snapshot show --idempotency-key <key> --org ORG_UUID. Reuse a key only for the identical request."
              : /exists on boat and modal/i.test(error.message)
                ? "Repeat the update with --provider boat or --provider modal; no build was admitted."
                : error.status === 400
                  ? "Check the repository URL/branch and config. --repo replaces the full list; --add-repo preserves it. If required fields are rejected, upgrade the CLI and server together."
                  : /capacity or binding/i.test(error.message)
                    ? "For a rebuild, an administrator must distinguish a missing backend binding from an active/stale reservation. Check the existing build ID with snapshot show --build; do not create a second Boat snapshot."
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
  const client = await createSdkCommandClient(
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
  if (args.positionals.length > 0) throw new GoldenError("invalid_config", "snapshot ls takes no name.");
  const auth = authOf(io, deps);
  const client = await createSdkCommandClient({
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
