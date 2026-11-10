import { AuthError, assertProvider } from "@armada/auth";
import {
  configFromFlags,
  type GoldenActor,
  type GoldenBuildStatus,
  type GoldenConfig,
  GoldenError,
  type GoldenRecord,
  type GoldenStore,
  HARNESSES,
  type Harness,
  isSandboxProvider,
  LaunchError,
  type LaunchResult,
  MODEL_CATALOG,
  type Provider,
  ProviderError,
  ProviderRoutingError,
  parseGoldenConfig,
  parseMachineSize,
  resolveModelChoice,
  SANDBOX_PROVIDERS,
  type SandboxProviderId,
  type SandboxStore,
  SIZED_LAUNCH_ROUTE_V1,
  VaultError,
  type VaultStore,
  VERSION,
} from "@armada/core";
import { accountCommand } from "./account-commands.ts";
import { flag, parseArgs, single, values } from "./args.ts";
import { ArmadaApiError, armadaApiUrl, createArmadaApiClient } from "./armada-api.ts";
import {
  type AuthIo,
  loginCommand,
  logoutCommand,
  productionAuthIo,
  tokenCreate,
  tokenList,
  tokenRevoke,
} from "./auth-commands.ts";
import { operation, parseTtl } from "./operations.ts";
import { orchestratorCommand } from "./orchestrator-commands.ts";
import { printOptionalResourceAdvice } from "./resource-advice.ts";
import { sizePolicyCommand } from "./size-policy-command.ts";
import { skillCommand } from "./skill-install.ts";
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
  /** The secret for `armada creds set`. By default stdin, and only when it is piped. */
  readStdin?: () => Promise<string>;
  /** Legacy test seam; commands use the Armada API rather than direct stores. */
  actor?: GoldenActor;
  store?: GoldenStore;
  sandboxes?: SandboxStore;
  provider?: Provider;
  sandboxPolls?: number;
  snapshotPolls?: number;
  /** Set by auth tests. Otherwise login stores an Armada API session on this machine. */
  auth?: AuthIo;
  /**
   * The encrypted credential store. Tests inject one. Otherwise `armada launch` asks the server
   * (`ARMADA_URL`) to resolve them, since the encryption key stays there.
   */
  vault?: { store: VaultStore; encryptionKey: string };
}

const HELP = `armada ${VERSION}: launch coding agents in Boat and Modal sandboxes

Usage:
  armada orchestrator --help               Persistent coordinator create/list/detail/send/steer/stop/resume/recover/events/capabilities
  armada --version                         Print the version
  armada --help                            Show this help
  armada skill install (--project <directory> | --global) --yes [--revision <commit>]
                                           Public GitHub manager + review skills; no login. See skill --help.
  armada golden create <name> (--repo <url>[@branch] ... | --config <file>) [--init <cmd> ...]
                               [--setup <local-file>] [--provider boat|modal] [--private] [--org <org>] [--idempotency-key <key>] [--timeout <seconds>]
                                           Server-orchestrated: builds, scans and snapshots the golden on the
                                           server over your own GitHub connection. No BOAT_API_KEY needed.
                                           --setup reads a local script and sends its content to run after
                                           cloning, before the scan.
  armada golden update <name> (--repo <url>[@branch] ... | --config <file>) [--init <cmd> ...]
                               [--setup <local-file>] [--provider boat|modal] [--org <org>] [--idempotency-key <key>] [--timeout <seconds>]
                                           Rebuild the existing golden in place. One golden may contain
                                           many repositories; visibility and ownership stay unchanged.
                                           Create/update admit a durable job, then poll for up to --timeout
                                           seconds (default 60, max 600; 0 returns after admission).
                                           Disconnecting never resubmits or cancels the job.
  armada golden build-status <job-id>      Read the authenticated durable build status
  armada golden build-status --idempotency-key <key> --org <org>
                                           Recover an uncertain admission using the saved key.
  armada golden connect <name> [--provider boat|modal]
                                           Open the canonical master for maintenance
  armada golden snapshot <name> [--provider boat|modal]
                                           Scan and freeze the master sandbox
  armada golden capabilities [--provider boat|modal] [--org UUID] [--json]
                                           Server-authoritative golden capacity; null means unbounded/unknown
  armada golden size-policy <name> [--provider boat|modal] [--org <org>] [--file <JSON|->] [--json]
                                           Inspect defaults, or replace the entire policy from a file/stdin.
                                           Version 1: {"version":1,"golden":null,"repositories":{}}
                                           Repository keys are configured directories. null golden and an empty map
                                           clear defaults. Scoped to this provider golden, future launches only.
  armada golden list [--provider boat|modal] [--json]
                                           Goldens you can see
  armada launch <golden> --agent claude|codex ["prompt"] [--model <id>] [--reasoning-effort <level>]
                [--provider boat|modal] [--repo <configured-dir|owner/repo>] [--size small|medium|large|xlarge | --sized] [--ttl 4h] [--json]
                [--skill org/slug@version ...] [--connections <id,...> | --no-connections] [--org <org>]
                Omit connections to request server defaults; --no-connections opts out.
                                           Fork a golden into a sandbox. With a prompt the agent starts at once;
                                           without one the sandbox waits, ready, for the first prompt. The model
                                           and effort apply to every later turn too. --credential-id UUID selects a model account;
                                           otherwise use your personal or organization default. --repo owner/repo selects a recorded
                                           golden repository as the native agent's real initial cwd (also when idle);
                                           omit it to keep legacy launch behavior. Size resolves on the server:
                                           --size > selected repository default > golden default > legacy.
                                           --size or --repo requires the versioned sizing server; --sized requires
                                           default-policy resolution without overriding size. No downgrade/retry
                                           to legacy launch on unsupported servers. Bare legacy launches keep their route.
                                           Size labels do not promise equal performance/billing across providers.
                                           Defaults:
                                           ${modelDefaults()}
                                           --repo prepares native agent cwd in the selected repository, including when idle; not confinement.
  armada list [--status STATUS] [--agent|--harness claude|codex] [--golden UUID] [--owner UUID|me]
              [--page N] [--limit 1..200] [--org UUID] [--json] [--page-info]
                                           Default page size 25; --json keeps {sandboxes:[...]}; --page-info adds exact totals
  armada mcp sandbox-connections <sandbox-uuid> [--org UUID] [--json]
                                           Read actual bound connection metadata, never mutate bindings
  armada advice <sandbox-id> [--org UUID] [--json]
                                           Last-10 comparable-session resource evidence; collects one bounded sample.
                                           Missing/partial evidence abstains. Never resizes or changes defaults.
                                           Human launch guidance uses stderr only; --json launch never requests advice.
  armada bind-credential <sandbox-id> --credential-id UUID [--org UUID] [--json]
                                           Owner-only legacy Modal binding recovery; stop safely first; no restart
  armada rm <sandbox-id> --yes [--org UUID] [--json]  Permanently delete a stopped sandbox and its recovery archives
  armada extend <sandbox-id> --ttl <duration> [--org UUID] [--json]
  armada detail|status|stop|wait|interrupt <sandbox-id> [--org UUID] [--json]
  armada report <sandbox-id> ready|blocked --prompt-id ID [--reason TEXT] [--pr-number N] [--pr-url URL] [--head-sha SHA]
  armada send|steer|exec <sandbox-id> <text-or-command> [--model ID] [--reasoning-effort LEVEL]
  armada golden retirement dry-run|reconcile <golden-id> [--limit 1-50] [--org UUID]
  armada golden remove <golden-id> [--org UUID] [--json]
                                           Remove from launch selection; retain children and provider artifacts
  armada golden visibility <golden-id> --visibility private|org [--org UUID]
  armada mcp catalog|rename ID NAME|default ID on|off [--org UUID]
  armada mcp add NAME --service notion|linear [--scope personal|org] [--org UUID]
  armada mcp add NAME URL [--scope personal|org] [--org UUID]
                                           Public/OAuth URL shortcut; auto discovery, no secret argv
  armada mcp list|add|update|connect|status|reconnect|enable|disable|revoke|delete [id] [--org UUID] [--file JSON]
  armada logs <sandbox-id> [--tail [n]] [--all] [--follow] [--json]
                                           Read agent events; --all drains available pages, --follow waits for new pages until settled
  armada login [--url <url>] [--provider github|google | --email <address>]
                                           --email sends a sign-in link; click it, or type the code it contains
  armada logout
  armada token create [--org <name>] [--label <label>]
  armada token list
  armada token revoke <id>
  armada org create <name>                 Create an org; you are its first admin
  armada org list
  armada org setup [--org <name>]          Show organization provider setup status
  armada org connect boat|modal [--org <name>] [--file <path>]
                                           Connect an org provider using stdin or a file
  armada org use <name|UUID|none>           Persist selection for this Armada server
  armada org current                        Show selected organization
  armada account status|logout              Account identity / revoke current login session
  armada github status|connect|reconnect|disconnect|install|manage [installation-id]
  armada github refresh <sandbox>
                                           Browser authorization waits for real completion; --no-browser prints URL
  armada org invitations create <email> [--role admin|member] [--org <name|UUID>] [--json]
  armada org invitations list [--org <name|UUID>] [--json]
  armada org invitations resend|revoke <id> [--org <name|UUID>] [--json]
                                           Admin invitation management; --org overrides org use selection.
                                           Email sent means provider accepted, not confirmed inbox delivery.
  armada org invitations accept [--file <path>] [--json]
                                           Token from stdin/file only; log in personally with the matching
                                           verified email first. Opening a link never joins an organization.
  armada org members list|add|remove|role  [--org <name>] add <email> [--role admin|member]
                                           Direct membership administration; add requires an existing account,
                                           grants membership immediately and does not send an invitation.
  armada creds login codex --name <name> [--org <name>]\n                                           Native local device login; five-minute expiry, Ctrl-C cancels\n  armada creds import claude|codex --name <name> [--file <path>] [--org <name>]
                                           Import a locally obtained native token/auth.json; never pass secrets as arguments
  armada creds set <kind> [--org <name>] [--file <path>]
                                           Store a credential, encrypted; the value is read from stdin or a file
                                           Model accounts: --name NAME creates; --id UUID --expected-version N replaces
  armada creds list [--org <name>]         Account IDs, names, defaults and safe metadata; never values
  armada creds rename <id> <name> [--org <name>]
  armada creds default|remove <id> [--org <name>]
  armada creds rm <kind> [--org <name>]
                                           kinds: claude-oauth, anthropic, openai, codex-auth, boat, modal, skillpack

Every command after 'armada login' acts as the user who signed in. golden commands take --org <name>
when you belong to more than one org.

Environment:
  ARMADA_TOKEN                             API token for non-interactive authentication. Takes precedence over
                                           a saved login session.
  ARMADA_URL                               Armada API server (default: https://armada.thevibecompany.co).
`;

/** Runs one command line and returns the process exit code. */
export async function run(argv: readonly string[], io: Io, deps: Deps = {}): Promise<number> {
  try {
    return await dispatch(argv, io, deps);
  } catch (error) {
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
        `${JSON.stringify({ error: { code: error instanceof ArmadaApiError ? error.serverCode : error.code, message: error.message } })}\n`,
      );
      return ["invalid_config", "invalid_request", "invalid", "usage", "no_credentials"].includes(error.code) ? 2 : 1;
    }
    if (error instanceof GoldenError) {
      io.err(`armada: ${error.message}\n`);
      return error.code === "invalid_config" ? 2 : 1;
    }
    if (error instanceof LaunchError) {
      io.err(`armada: ${error.message}\n`);
      if (error.sandboxId) io.err(`Sandbox ${error.sandboxId} is recorded as failed and its machine is stopped.\n`);
      return error.code === "invalid_request" || error.code === "no_credentials" ? 2 : 1;
    }
    if (error instanceof VaultError) {
      io.err(`armada: ${error.message}\n`);
      return error.code === "invalid" ? 2 : 1;
    }
    if (error instanceof ProviderRoutingError) {
      io.err(`armada: ${error.message}\n`);
      return 1;
    }
    if (error instanceof ProviderError) {
      io.err(`armada: ${error.message}\n`);
      return 1;
    }
    if (error instanceof AuthError) {
      io.err(`armada: ${error.message}\n`);
      return error.code === "usage" ? 2 : 1;
    }
    throw error;
  }
}

async function dispatch(argv: readonly string[], io: Io, deps: Deps): Promise<number> {
  const [command, ...original] = argv;
  if (command === "skill") return skillCommand(original, io);
  // Command discovery must work before login or organization selection.
  if (command === "launch" && original.length === 1 && ["--help", "-h"].includes(original[0] ?? "")) {
    io.out(HELP);
    return 0;
  }
  if (command === "orchestrator") {
    const auth = authOf(io, deps);
    return orchestratorCommand(original, {
      ...auth,
      fetch: deps.fetch ?? auth.fetch,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
  }
  let rest = original;
  const terminator = rest.indexOf("--");
  const optionArgs = terminator < 0 ? rest : rest.slice(0, terminator);
  const scoped = [
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
    const selected = await auth.preferences?.read(armadaApiUrl(auth.env.ARMADA_URL));
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
    case "creds":
      return credsCommand(rest, vaultIo(io, deps));
    case "token":
      return tokenCommand(parseAuth(rest), authOf(io, deps));
    default:
      io.err(`armada: unknown command '${command}'. Run 'armada --help'.\n`);
      return 2;
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
  const args = parseArgs(rest, subcommand === "retirement" ? ["--limit"] : []);
  providerFlag(args);
  const limits = {
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.sandboxPolls !== undefined ? { sandboxPolls: deps.sandboxPolls } : {}),
    ...(deps.snapshotPolls !== undefined ? { snapshotPolls: deps.snapshotPolls } : {}),
  };
  switch (subcommand) {
    case "capabilities": {
      if (args.positionals.length) throw new GoldenError("invalid_config", "golden capabilities takes no name.");
      const requested = providerFlag(args);
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
          ...(requested === undefined ? {} : { provider: requested }),
          ...(single(args, "--org") === undefined ? {} : { org: single(args, "--org") }),
        }),
      });
      const data =
        payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
      if (
        !isSandboxProvider(data.provider) ||
        (requested !== undefined && requested !== data.provider) ||
        (data.maxGoldens !== null &&
          (typeof data.maxGoldens !== "number" || !Number.isSafeInteger(data.maxGoldens) || data.maxGoldens < 0))
      ) {
        throw new VaultError("unavailable", "Armada returned invalid or mismatched golden capabilities.");
      }
      const capabilities: { provider: SandboxProviderId; maxGoldens: number | null } = {
        provider: data.provider,
        maxGoldens: data.maxGoldens as number | null,
      };
      io.out(
        flag(args, "--json")
          ? `${JSON.stringify(capabilities)}\n`
          : `${capabilities.provider}: max goldens ${capabilities.maxGoldens === null ? "unbounded/unknown" : capabilities.maxGoldens}\n`,
      );
      return 0;
    }
    case "retirement": {
      const [action, id, ...extra] = args.positionals;
      if (!["dry-run", "reconcile"].includes(action ?? "") || !id || extra.length)
        throw new GoldenError("invalid_config", "Use golden retirement dry-run|reconcile GOLDEN_UUID.");
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
      const result = await client.request("/api/v1/golden/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: oneName(args.positionals), org: single(args, "--org") }),
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
      io.out(JSON.stringify(job) + "\n");
      return job.state === "failed" || job.state === "recovery_required" ? 1 : 0;
    }
    case "create":
      return create(args.positionals, args, io, deps, limits);
    case "update":
      return update(args.positionals, args, io, deps);
    case "connect":
      return connect(args, io, deps, limits);
    case "snapshot":
      return snapshot(args, io, deps);
    case "list":
      return list(args, io, deps);
    default:
      io.err(`armada: unknown command 'golden ${subcommand}'. Run 'armada --help'.\n`);
      return 2;
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
  io.err(`Build admission key: ${key}. Recover with golden build-status --idempotency-key ${key} --org <org>.\n`);
  const job = await client.request<GoldenBuildStatus>(path, {
    ...init,
    body: JSON.stringify({ ...JSON.parse(String(init.body)), idempotencyKey: key }),
  });
  if (!flag(args, "--json")) io.out(`Build job: ${job.jobId}\n`);
  const deadline = AbortSignal.timeout(Math.max(1, seconds * 1000));
  let current = job;
  try {
    for (let attempt = 0; attempt < Math.ceil(seconds / 2); attempt++) {
      if (current.state === "succeeded") return current.result ?? undefined;
      if (current.state === "failed" || current.state === "recovery_required")
        throw new GoldenError("build_failed", `Build ${job.jobId}: ${current.state} (build_failed).`);
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
      `Polling stopped; build ${job.jobId} may still be running. Use golden build-status ${job.jobId}; do not resubmit.`,
    );
  }
  if (current.state === "succeeded") return current.result ?? undefined;
  if (current.state === "failed" || current.state === "recovery_required")
    throw new GoldenError("build_failed", `Build ${job.jobId}: ${current.state} (build_failed).`);
  if (flag(args, "--json")) io.out(`${JSON.stringify(current)}\n`);
  else io.out(`Build is ${current.state}. Resume with armada golden build-status ${job.jobId}.\n`);
  return undefined;
}

async function update(positionals: string[], args: ReturnType<typeof parseArgs>, io: Io, deps: Deps): Promise<number> {
  const name = oneName(positionals);
  const config = await readConfig(args, deps);
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
  const client = await createArmadaApiClient({ env: auth.env, fetch: deps.fetch ?? auth.fetch, session: auth.session });
  const result = await admitGoldenBuild(client, args, io, deps, "/api/v1/golden/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      ...(providerFlag(args) ? { provider: providerFlag(args) } : {}),
      config,
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
    `Updated golden ${result.name} (${result.visibility}).\nSaved snapshot: ${result.snapshot}\nRepos: ${config.repos.map((repo) => repo.dir).join(", ")}.\n`,
  );
  return 0;
}

type Limits = {
  sleep?: (ms: number) => Promise<void>;
  sandboxPolls?: number;
  snapshotPolls?: number;
};

async function create(
  positionals: string[],
  args: ReturnType<typeof parseArgs>,
  io: Io,
  deps: Deps,
  _limits: Limits,
): Promise<number> {
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
  const client = await createArmadaApiClient({ env: auth.env, fetch: deps.fetch ?? auth.fetch, session: auth.session });
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
    `Created golden ${result.name} (${result.visibility}).\nSaved snapshot: ${result.snapshot}\nRepos: ${config.repos.map((repo) => repo.dir).join(", ")}.\n`,
  );
  return 0;
}

async function connect(args: ReturnType<typeof parseArgs>, io: Io, deps: Deps, _limits: Limits): Promise<number> {
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
      `Golden ${result.golden} is ready for setup.\nSandbox: ${result.sandboxId}${result.webUrl ? `\nURL: ${result.webUrl}` : ""}\n`,
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
  io.out(`Snapshotted golden ${saved.name}.\nSaved snapshot: ${saved.snapshot}\n`);
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
  const rows = result.goldens.filter((row) => providerFlag(args) === undefined || row.provider === providerFlag(args));
  if (flag(args, "--json")) {
    io.out(`${JSON.stringify(rows.map(jsonGolden), null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    io.out("No goldens.\n");
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
  const args = parseArgs(argv, ["--size", "--skill"], ["--sized"]);
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
    throw new GoldenError("invalid_config", "Give a golden name and at most one prompt.");
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
    await client.request<LaunchWireResult>(sized ? SIZED_LAUNCH_ROUTE_V1 : "/api/v1/sandbox/launch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(flag(args, "--no-connections") ? { connections: [] } : {}),
        ...(values(args, "--skill").length ? { skills: values(args, "--skill") } : {}),
        ...(connections === undefined ? {} : { connections: connections.split(",") }),
        credentialId: single(args, "--credential-id"),
        golden: name,
        ...(sized ? { sizePolicyVersion: 1 } : {}),
        ...(size === undefined ? {} : { size }),
        ...(repo === undefined ? {} : { repo }),
        ...(providerFlag(args) ? { provider: providerFlag(args) } : {}),
        harness,
        ...resolveModelChoice(harness, {
          model: single(args, "--model"),
          reasoningEffort: single(args, "--reasoning-effort"),
        }),
        ...(prompt === undefined ? {} : { prompt }),
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
        ...(single(args, "--org") === undefined ? {} : { org: single(args, "--org") }),
      }),
      signal: AbortSignal.timeout(10 * 60_000),
    }),
  );
  io.out(flag(args, "--json") ? `${JSON.stringify(jsonLaunch(result), null, 2)}\n` : launchText(result, auth.now()));
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
    if (!settled)
      await (deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(FOLLOW_DELAY_MS);
  }
  return 0;
}

function eventText(event: Awaited<ReturnType<Provider["events"]>>["events"][number]): string {
  if (event.kind === "message" || event.kind === "prompt" || event.kind === "steer") return event.text;
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
    `Launched ${sandbox.harness} sandbox from golden ${golden.name}.`,
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

function jsonLaunch(result: LaunchResult) {
  const { sandbox } = result;
  return {
    id: sandbox.id,
    provider: sandbox.provider,
    providerSandboxId: sandbox.providerSandboxId,
    boatId: sandbox.provider === "boat" ? sandbox.providerSandboxId : null,
    golden: result.golden.name,
    repositoryDir: sandbox.repositoryDir ?? null,
    harness: sandbox.harness,
    model: sandbox.model,
    skills: sandbox.skills ?? [],
    reasoningEffort: sandbox.reasoningEffort,
    credentialId: sandbox.credentialId ?? null,
    credentialVersion: sandbox.credentialVersion ?? null,
    status: sandbox.status,
    conversationIds: sandbox.conversationIds,
    promptId: result.promptId ?? null,
    ttlSeconds: result.ttlSeconds,
    expiresAt: result.expiresAt ? new Date(result.expiresAt).toISOString() : null,
    machineSize: sandbox.machineSize ?? null,
    github: {
      status: result.github.status,
      login: result.github.login ?? null,
      tokenExpiresAt: result.github.tokenExpiresAt ?? null,
      message: result.github.message ?? null,
    },
  };
}

function line(row: GoldenRecord): string {
  const snapshot = row.providerSnapshotId ? "snapshot" : "no snapshot";
  const repos = row.config.repos.length === 1 ? "1 repo" : `${row.config.repos.length} repos`;
  return `${row.name}  ${row.provider}  ${row.visibility}  ${snapshot}  ${repos}`;
}

function jsonGolden(row: GoldenRecord) {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    visibility: row.visibility,
    ownerId: row.ownerId,
    provider: row.provider,
    providerSnapshotId: row.providerSnapshotId,
    providerSandboxId: row.providerSandboxId,
    modal: row.modal,
    boatSnapshotId: row.provider === "boat" ? row.providerSnapshotId : null,
    boatSandboxId: row.provider === "boat" ? row.providerSandboxId : null,
    repos: row.config.repos.length,
    config: row.config,
  };
}

async function readConfig(args: ReturnType<typeof parseArgs>, deps: Deps): Promise<GoldenConfig> {
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
    return parseGoldenConfig(parsed);
  }
  return configFromFlags(repos, init);
}

function oneName(positionals: string[]): string {
  const name = positionals[0];
  if (name === undefined || positionals.length !== 1) {
    throw new GoldenError("invalid_config", "Give exactly one golden name.");
  }
  return name;
}

async function login(argv: readonly string[], io: Io, deps: Deps): Promise<number> {
  const parsed = parseAuth(argv);
  rejectUnknown(parsed.flags, ["provider", "email", "url"]);
  if (parsed.position.length > 0) throw new AuthError("Run armada login --help.", "usage");
  if (parsed.flags.has("provider") && parsed.flags.has("email")) {
    throw new AuthError("Use --provider or --email, not both.", "usage");
  }
  const provider = parsed.flags.has("provider") ? assertProvider(authFlag(parsed.flags, "provider")) : undefined;
  const email = parsed.flags.has("email") ? authFlag(parsed.flags, "email") : undefined;
  await loginCommand(authOf(io, deps), { provider, email, url: parsed.flags.get("url") });
  return 0;
}

async function logout(argv: readonly string[], io: Io, deps: Deps): Promise<number> {
  const parsed = parseAuth(argv);
  rejectUnknown(parsed.flags, []);
  if (parsed.position.length > 0) throw new AuthError("Run armada logout.", "usage");
  await logoutCommand(authOf(io, deps));
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

function vaultIo(io: Io, deps: Deps): VaultIo {
  return {
    auth: authOf(io, deps),
    readFile: deps.readFile ?? ((path) => Bun.file(path).text()),
    readStdin:
      deps.readStdin ??
      (() => (process.stdin.isTTY ? Promise.reject(new Error("stdin is a terminal")) : Bun.stdin.text())),
  };
}

function modelDefaults(): string {
  return Object.entries(MODEL_CATALOG)
    .map(([h, e]) => `${h} ${e.defaultModel} ${e.defaultReasoningEffort}`)
    .join(", ");
}
function providerFlag(args: ReturnType<typeof parseArgs>): SandboxProviderId | undefined {
  const value = single(args, "--provider");
  if (value === undefined) return undefined;
  if (!isSandboxProvider(value))
    throw new GoldenError("invalid_config", `--provider is ${SANDBOX_PROVIDERS.join(" or ")}.`);
  return value;
}
