import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
  ArmadaApiError,
  type ArmadaConfig,
  type ArmadaSignIn,
  armadaAddress,
  BriefError,
  type BuildBriefInput,
  buildBrief,
  buildModel,
  CONFIG_FILE,
  type Credentials,
  checkPublished,
  checkRequestedProfile,
  chooseProfile,
  chooseValidations,
  DEFAULT_ARMADA_API_URL,
  fetchBriefTicket,
  fetchProgram,
  HERDR_HARNESSES,
  type HerdrHarness,
  type HerdrProfileChoice,
  herdrClaimHandle,
  herdrHarnessKind,
  herdrHarnessLabel,
  inFlight,
  LINEAR_KEY,
  type OverlapReading,
  type ProfileChoice,
  ProfileError,
  parseConfig,
  Refusal,
  RuntimeError,
  type RuntimeName,
  reservationsForBrief,
  shellWord,
  type ValidationChoice,
  ValidationChoiceError,
} from "@armada/core";
import { apiOf } from "./api.ts";
import { coordinatorName } from "./coordinator.ts";
import { type HerdrHandle, herdrWorktreePath, herdrWorktreesDirectory, parseHerdrHandle } from "./herdr.ts";
import { httpOptions, type Io, missingKey, UsageError } from "./io.ts";
import { detectLocalTools, ensureLocalProfile } from "./local-tools.ts";
import { requireSignIn } from "./login.ts";
import { preApprovalReason, preparePreApproval } from "./plan-approval.ts";
import {
  type Launched,
  type LaunchSpec,
  type RuntimeAdapter,
  recheckMutation,
  redactRuntimeText,
  runtimeFor,
} from "./runtimes/adapter.ts";
import { conductorLaunchArguments } from "./runtimes/conductor.ts";
import { HerdrAdapter } from "./runtimes/herdr.ts";
import { coordinatorHandle, rearmFor, remember, stopHookBanner, watchOf } from "./watch.ts";
import { liveFleet } from "./worker.ts";
import { countWorkerSlots, mintLaunchToken, overCapReason } from "./worker-slots.ts";

export class LaunchError extends Refusal {
  override name = "LaunchError";
}

/** Keep launch headlines readable even when tracker titles contain line breaks. */
export const launchTitle = (title: string) => title.replace(/\s+/g, " ").trim().slice(0, 80);

export async function launch(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  args: { rest: string[]; json: boolean; options: Record<string, string> },
  version: string,
  configPath: string,
) {
  if (args.options["when-unblocked"] || args.options.after !== undefined)
    return deferLaunch(io, config, credentials, args);
  if (args.rest[0] !== "revoke") {
    const code = await launchWorker(io, config, credentials, args, version, configPath);
    if (args.options["dry-run"] === "true") {
      const banner = await stopHookBanner(io);
      if (banner) (args.json ? io.stderr : io.stdout)(`${banner}\n`);
    }
    return code;
  }
  if (Object.keys(args.options).length) throw new UsageError("launch revoke does not take runtime or profile options");
  const [operation, ticket, ...extra] = args.rest;
  if (operation !== "revoke" || !ticket || extra.length || !/^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/.test(ticket))
    throw new UsageError("launch needs a ticket to revoke: armada launch revoke <ticket>");
  const revoked = await apiOf(io, credentials.armadaApi.url).revokeLaunch(requireSignIn(credentials), {
    project: config.project.slug,
    ticket: ticket.toUpperCase(),
  });
  const known = (await watchOf(io, config.project.slug)).state?.inFlight;
  const inFlight = known?.filter((held) => held !== revoked.ticket) ?? null;
  let slots: { taken: number; max: number | null } | undefined;
  if (config.policy.maxWorkers) {
    const { fleet } = liveFleet(io, config, credentials);
    try {
      if (fleet) slots = { ...(await countWorkerSlots(io, fleet)), max: config.policy.maxWorkers };
    } catch {
      io.stderr("armada: warning: could not refresh workers after revoke; cached slot count cleared.\n");
    }
  }
  await remember(io, config.project.slug, { inFlight, slots, readAt: (io.now ?? (() => new Date()))().toISOString() });
  const watch = await rearmFor(io, config.project.slug, { inFlight, slots, open: null });
  io.stdout(
    args.json
      ? `${JSON.stringify({ ...revoked, watch }, null, 2)}\n`
      : `Revoked the pending launch of ${revoked.ticket}.\n${watch.line}\n`,
  );
  return 0;
}

export interface LaunchBinding {
  project: string;
  ticket: string;
  id: string;
  runtime: RuntimeName;
  handle: string;
}
/** Test seam; production binding uses the shared Armada API client. */
export type BindLaunch = (signIn: ArmadaSignIn, target: LaunchBinding) => Promise<unknown>;

export async function prepareLaunch(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  args: { rest: string[]; json: boolean; options: Record<string, string> },
  version: string,
  configPath: string,
  replacement?: { branch: string; coordinator?: string | null; preApprovalReason?: string; command?: string },
) {
  const [input, ...extra] = args.rest;
  const o = args.options;
  const overCap = overCapReason(o);
  if (!input || extra.length || !/^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/.test(input))
    throw new UsageError("launch needs a ticket: armada launch <ticket> [--runtime conductor|herdr]");
  if (o.runtime && !["conductor", "herdr", "claude-code"].includes(o.runtime))
    throw new UsageError("--runtime must be conductor or herdr");
  const requested = o.profile?.trim() || null;
  const reason = o.reason?.trim() || null;
  const approvalReason = replacement?.preApprovalReason ?? preApprovalReason(o);
  if (reason && !requested && !approvalReason) throw new UsageError("--reason goes with --profile");
  if (o.harness && !HERDR_HARNESSES.includes(o.harness as HerdrHarness))
    throw new UsageError("--harness must be claude, codex, opencode or deepseek (OpenCode + DeepSeek model)");
  // Conductor's section also holds guided Claude Code profiles. Herdr has its own routing.
  const selection =
    o.runtime === "herdr" ||
    (!o.runtime &&
      (requested
        ? !Object.hasOwn(config.conductor.profiles, requested) && Object.hasOwn(config.herdr.profiles, requested)
        : !Object.keys(config.conductor.profiles).length && !!Object.keys(config.herdr.profiles).length))
      ? "herdr"
      : "conductor";
  try {
    checkRequestedProfile(config, requested, selection);
  } catch (error) {
    if (error instanceof ProfileError) throw new UsageError(error.message);
    throw error;
  }
  const notes = await readNotes(io, o.notes);
  const signIn = requireSignIn(credentials);
  if (!credentials.linearApiKey) throw missingKey(LINEAR_KEY);
  if (!io.exec) throw new UsageError("launch needs process execution");
  const ticketId = input.toUpperCase();
  const now = io.now ?? (() => new Date());
  const linear = { apiKey: credentials.linearApiKey, ...httpOptions(io) };
  const [ticket, program] = await Promise.all([
    fetchBriefTicket(linear, ticketId),
    fetchProgram({ ...linear, rootId: config.tracker.programRoot, labels: config.tracker.labels, now }),
  ]);
  if (!ticket) throw new UsageError(`ticket ${ticketId} not found in Linear`);
  if (ticket.statusType === "completed" || ticket.statusType === "canceled")
    throw new UsageError(`${ticketId} is ${ticket.status}; there is nothing to launch`);
  if (!program.issues.some((i) => i.id === ticketId))
    throw new UsageError(`${ticketId} is not under program root ${config.tracker.programRoot}`);
  if (ticket.blockers.some((b) => b.statusType !== "completed" && b.statusType !== "canceled"))
    throw new UsageError(`${ticketId} has open blockers; resolve them before launching`);
  if (
    !replacement &&
    inFlight(buildModel(program.issues, program.rootId), program.comments, {
      now: now().getTime(),
      silentAfterMinutes: config.policy.silentAfterMinutes,
    }).some((lane) => lane.issue.id === ticketId)
  )
    throw new UsageError(`${ticketId} is already in flight; inspect its worker before launching again`);
  if (ticket.labels.includes(config.tracker.parkedLabel))
    throw new UsageError(`${ticketId} is parked; remove the parked label before launching`);
  const branch = replacement?.branch || ticket.branchName;
  if (!branch) throw new UsageError(`${ticketId} has no suggested branch in Linear`);
  let choice: ProfileChoice | HerdrProfileChoice | null;
  let validation: ValidationChoice | null;
  try {
    choice = chooseProfile(config, { ticket: ticketId, labels: ticket.labels, requested, reason }, selection);
    validation = chooseValidations(config.policy.validations, {
      ticket: ticketId,
      requested: o.validation ?? null,
      reason: o["validation-reason"] ?? null,
      command:
        replacement?.command ??
        [
          `armada launch ${ticketId}${o.runtime ? ` --runtime ${o.runtime}` : ""}`,
          ...["harness", "profile", "reason", "notes"].flatMap((key) =>
            o[key] ? [`--${key} ${shellWord(o[key])}`] : [],
          ),
          ...["pre-approve", "dry-run"].filter((key) => o[key] === "true").map((key) => `--${key}`),
          ...(args.json ? ["--json"] : []),
        ].join(" "),
    });
  } catch (error) {
    if (error instanceof ProfileError) throw new UsageError(error.message);
    if (error instanceof ValidationChoiceError) throw new UsageError(error.message, error.next);
    throw error;
  }
  if (!choice)
    throw new UsageError(`launch needs a [${selection}.profiles.<name>] with agent or harness, model and effort`);
  const local = "harness" in choice.profile ? (choice as HerdrProfileChoice) : null;
  const remoteChoice = local ? null : (choice as ProfileChoice);
  const runtimeName = local ? "herdr" : remoteChoice?.profile.runtime;
  if (runtimeName === "claude-code" || o.runtime === "claude-code")
    throw new UsageError(`launch it with the Agent tool: armada brief ${ticketId} --prompt`);
  if (runtimeName !== "herdr" && runtimeName !== "conductor") throw new UsageError("unsupported launch runtime");
  if (o.harness && (!local || o.harness !== local.profile.harness))
    throw new UsageError(
      `profile "${choice.name}" does not use ${o.harness}; choose a matching --profile with --reason to change harness`,
    );
  const approval = approvalReason ? await preparePreApproval(io, config, credentials, ticket, approvalReason) : null;
  const { fleet } = liveFleet(io, config, credentials);
  if (!fleet) throw new UsageError("launch needs Armada's live fleet; sign in with armada login");
  const available = async () => {
    const [pending, active] = await Promise.all([fleet.pendingLaunches(), fleet.runtimeHandle(ticketId)]);
    if (active?.claimedAt && !active.releasedAt)
      throw new UsageError(`${ticketId} is already in flight; inspect its worker before launching again`);
    const p = pending.find((p) => p.ticket === ticketId);
    if (p) {
      const minutes = Math.max(0, Math.floor((now().getTime() - Date.parse(p.launchedAt)) / 60_000));
      throw new UsageError(
        `${ticketId} was launched ${minutes} min ago${p.handle ? ` (handle ${redactRuntimeText(p.handle)})` : ""} and has not claimed yet: armada peek ${ticketId}, or armada launch revoke ${ticketId}`,
      );
    }
  };
  if (!replacement) await available();
  if (o["dry-run"] === "true" && config.policy.maxWorkers && !replacement) {
    try {
      const slots = await countWorkerSlots(io, fleet);
      if (slots.taken >= config.policy.maxWorkers && !overCap && ticket.priority !== 1) {
        io.stderr(`armada: would be refused: ${slots.taken} of ${config.policy.maxWorkers} workers\n`);
        return 1;
      }
    } catch {
      io.stderr("armada: cannot count workers; retry or --over-cap\n");
      return 1;
    }
  }
  if (local && !replacement && o["dry-run"] === "true")
    return await launchPlan(io, args.json, {
      ticketId,
      title: ticket.title,
      choice: local,
      branch,
      version,
      preApproval: approval?.preview ?? null,
    });
  const branchCheck = await io.exec("git", ["check-ref-format", "--branch", branch], { cwd: io.cwd, timeoutMs: 5000 });
  if (branchCheck.code !== 0) throw new UsageError("the ticket branch is invalid; nothing was launched");
  if (local && o["dry-run"] !== "true") {
    const execute = io.exec;
    const preflight: Io = {
      ...io,
      interactive: args.json ? false : io.interactive,
      exec: (command, argv, options) => execute(command, argv, { ...options, timeoutMs: options.timeoutMs ?? 10_000 }),
    };
    const model = await ensureLocalProfile(preflight, configPath, local.name, local.profile);
    if (model === null) return 1;
    local.profile.model = model;
  }
  let runtime = runtimeFor(io, config, runtimeName);
  if (!local && !remoteChoice) throw new UsageError("no profile selected");
  const profile = local
    ? {
        name: local.name,
        agent: local.profile.harness,
        model: local.profile.model,
        effort: local.profile.effort,
        fastMode: false,
        herdr: local.profile,
      }
    : { name: choice.name, ...(remoteChoice as ProfileChoice).profile };
  const checks =
    local && o["dry-run"] !== "true" ? [] : await runtime.preflight({ profile, repository: config.github.repository });
  const gaps = checks.filter((c) => c.level === "error").map((c) => `${c.message}${c.fix ? `: ${c.fix}` : ""}`);
  const warnings = checks.filter((c) => c.level === "warning").map((c) => c.message);
  const dry = o["dry-run"] === "true";
  if (gaps.length && !dry) throw new UsageError(gaps.join("; "));
  // Preserve herdr's persisted OpenCode model snapshot for the worker's claim.
  const openCode = local && herdrHarnessKind(local.profile.harness) === "opencode";
  const configSnapshot = openCode ? await io.readFile(configPath) : null;
  if (openCode) {
    if (!io.writeFile || configSnapshot === null)
      throw new UsageError("local OpenCode launch needs the configuration copied into its worker worktree");
    if (JSON.stringify(parseConfig(configSnapshot, configPath)) !== JSON.stringify(config))
      throw new UsageError("configuration changed during preflight; retry launch with the saved model");
  }
  let repo = io.cwd;
  let base = !local ? (config.conductor.baseBranch ?? null) : null;
  try {
    const root = await io.exec("git", ["rev-parse", "--show-toplevel"], { cwd: io.cwd, timeoutMs: 10_000 });
    if (root.code !== 0 || !root.stdout.trim().startsWith("/"))
      throw new UsageError("local launch must run in a git repository");
    repo = root.stdout.trim();
    if (!base) {
      const remote = await io.exec("git", ["ls-remote", "--symref", "origin", "HEAD"], {
        cwd: repo,
        timeoutMs: 20_000,
      });
      base = remote.code === 0 ? (remote.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m)?.[1] ?? null) : null;
      if (!base) throw new UsageError("could not read the default branch of origin");
    }
  } catch (error) {
    if (!dry) throw error;
    gaps.push(error instanceof UsageError ? error.message : "could not read the repository state");
  }
  runtime = runtimeFor({ ...io, cwd: repo }, config, runtimeName);
  const conventions = config.brief.extra
    ? { path: config.brief.extra, text: await io.readFile(join(dirname(configPath), config.brief.extra)) }
    : null;
  const sharedResources = await reservationsForBrief(() => fleet.reservations(), config.reservations.length > 0);
  const npm = await checkPublished(version, io.fetch ?? fetch);
  if (npm.state === "missing") {
    const message = `armada ${version} is not on npm yet; publish this version before launching ${local ? "local workers" : "workers"}`;
    if (!dry) throw new UsageError(message);
    gaps.push(message);
  }
  let overlap: OverlapReading | undefined;
  try {
    overlap = await fleet.overlap({ ticket: ticketId, paths: [] });
  } catch {
    warnings.push("Comparison incomplete: in-flight PR files could not be read from Armada.");
  }
  const briefInput: BuildBriefInput = {
    ...sharedResources,
    overlap,
    config,
    ticket,
    program,
    profile: choice.name,
    reason,
    version,
    npm,
    env: io.env,
    now: now(),
    conventions,
    validation,
    notes,
  };
  // Build once before a token exists so brief errors cannot strand a token.
  const preview = buildBrief({ ...briefInput, ...(local ? { herdr: { choice: local, handle: "preview" } } : {}) });
  warnings.push(
    ...preview.warnings.filter(
      (warning) =>
        (warning.startsWith("Comparison incomplete") || warning.startsWith(`${ticketId}: `)) &&
        !warnings.includes(warning),
    ),
  );
  if (!dry) for (const warning of warnings) io.stderr(`armada: warning: ${warning}\n`);
  const spec: LaunchSpec = {
    ticket: ticketId,
    title: ticket.title,
    repository: config.github.repository,
    base: base ?? "",
    branch,
    from: { kind: "base" },
    profile,
    prompt: "",
    projectId: !local ? config.conductor.projectId : null,
    env: { ARMADA_TICKET: ticketId },
    blankSecrets: config.secrets.names,
  };
  return {
    io,
    config,
    credentials,
    args,
    ticketId,
    ticket,
    program,
    now,
    signIn,
    choice,
    local,
    runtimeName,
    runtime,
    spec,
    briefInput,
    preview,
    checks,
    gaps,
    warnings,
    configSnapshot,
    available,
    approval,
    repo,
    coordinator: replacement?.coordinator,
    replacement: !!replacement,
    overCap,
  };
}

export type PreparedLaunch = Exclude<Awaited<ReturnType<typeof prepareLaunch>>, number>;

export async function launchWorker(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  args: { rest: string[]; json: boolean; options: Record<string, string> },
  version: string,
  configPath: string,
  bindLaunch?: BindLaunch,
) {
  const prepared = await prepareLaunch(io, config, credentials, args, version, configPath);
  if (typeof prepared === "number") return prepared;
  if (args.options["dry-run"] === "true") return printLaunchPlan(prepared);
  const { fleet } = liveFleet(io, config, credentials);
  if (!fleet) throw new UsageError("launch needs Armada's live fleet");
  return withLaunchLease(io, fleet, prepared.ticketId, async () => {
    const result = await executeLaunch(prepared, bindLaunch);
    printLaunch(prepared, result);
    return result.unconfirmed ? 1 : 0;
  });
}

export function printLaunchPlan(p: PreparedLaunch) {
  const { io, args, ticketId, choice, spec, preview, checks, gaps, warnings, runtimeName } = p;
  const { branch, base, profile } = spec;
  const argv = ["conductor", "--json", ...conductorLaunchArguments(spec)];
  const ready = gaps.length === 0;
  const plan = {
    ticket: ticketId,
    title: p.ticket.title,
    runtime: runtimeName,
    dryRun: true,
    preApproval: p.approval?.preview ?? null,
    profile: choice.name,
    why: choice.why,
    profileWhy: choice.why,
    agent: profile.agent,
    model: profile.model,
    effort: profile.effort,
    fastMode: profile.fastMode,
    branch,
    base,
    argv,
    input: `<brief, ${Buffer.byteLength(preview.prompt)} bytes, via stdin>`,
    preflight: { ready, checks, gaps, warnings, inFlight: false, pendingLaunch: false },
  };
  io.stdout(
    args.json
      ? `${JSON.stringify(plan, null, 2)}\n`
      : `Launch plan for ${ticketId} "${launchTitle(p.ticket.title)}" (dry run: nothing is created)\nProfile    ${choice.name} — ${choice.why}\nConductor  ${profile.agent}, model ${profile.model}, effort ${profile.effort}, fast mode ${profile.fastMode}\nCommand    ${JSON.stringify(argv)} ${plan.input}\nPreflight  ${ready ? "ready" : "blocked"}\n`,
  );
  if (!args.json && p.approval) io.stdout(`${p.approval.preview}\n`);
  for (const gap of gaps) io.stderr(`armada: ${gap}\n`);
  if (!args.json) for (const warning of warnings) io.stderr(`armada: warning: ${warning}\n`);
  return ready ? 0 : 1;
}

export async function executeLaunch(p: PreparedLaunch, bindLaunch?: BindLaunch) {
  const {
    io,
    config,
    credentials,
    ticketId,
    now,
    signIn,
    choice,
    local,
    runtimeName,
    runtime,
    spec,
    briefInput,
    configSnapshot,
    available,
  } = p;
  const { branch, profile } = spec;
  const api = apiOf(io, credentials.armadaApi.url);
  await available();
  await recheckMutation();
  if (local && spec.from.kind === "branch") {
    // The advertised commit may not be in this machine's object store yet.
    const fetched = await io.exec?.(
      "git",
      ["fetch", "--no-tags", "--no-write-fetch-head", "origin", `refs/heads/${spec.branch}`],
      { cwd: p.repo, timeoutMs: 30000 },
    );
    const exists = await io.exec?.("git", ["cat-file", "-e", `${spec.from.head}^{commit}`], {
      cwd: p.repo,
      timeoutMs: 5000,
    });
    if (fetched?.code !== 0 || exists?.code !== 0)
      throw new UsageError("could not fetch the pushed branch head; no launch token was created");
  }
  await recheckMutation();
  briefInput.preApprovedReason = await p.approval?.apply();
  await recheckMutation();
  const started = now().toISOString();
  const launchCoordinator =
    p.coordinator === undefined ? await coordinatorName(io, config.project.slug) : p.coordinator;
  const launch = await mintLaunchToken(io, config, credentials, {
    ticket: ticketId,
    priority: p.ticket.priority,
    overCap: p.overCap,
    replacement: p.replacement,
    // Explicit null preserves an unowned generation; only a normal launch
    // chooses the coordinator selected in this terminal.
    coordinator: launchCoordinator,
  });
  let worker: Launched | null = null;
  let unconfirmed: string | null = null;
  let handle: HerdrHandle | undefined;
  const build = (herdr?: { choice: HerdrProfileChoice; handle: string }) =>
    buildBrief({
      ...briefInput,
      launch: {
        token: launch.token,
        expiresAt: launch.expiresAt,
        apiUrl:
          armadaAddress(credentials.armadaApi.url) === armadaAddress(DEFAULT_ARMADA_API_URL)
            ? null
            : armadaAddress(credentials.armadaApi.url),
      },
      ...(herdr ? { herdr } : {}),
    }).prompt;
  const revoke = async () => {
    try {
      await api.revokePendingLaunch(signIn, { project: config.project.slug, ticket: ticketId, id: launch.worker.id });
      io.stderr(`armada: revoked the pending launch of ${ticketId}.\n`);
      return true;
    } catch {
      io.stderr(
        `armada: could not revoke the pending launch; run armada launch revoke ${ticketId} before retrying (a claimed worker must release).\n`,
      );
      return false;
    }
  };
  const recordFailure = async (outcome: "failed" | "uncertain", reason: string, next: string) => {
    const safe = (text: string) =>
      redactRuntimeText(text.split(launch.token).join("[redacted]")).replace(/\s+/g, " ").trim().slice(0, 500);
    const message = safe(reason);
    const command = safe(next);
    try {
      const fleet = liveFleet(io, config, credentials).fleet;
      if (!fleet) throw new Error("fleet unavailable");
      await fleet.recordLaunchFailure({
        ticket: ticketId,
        outcome,
        reason: message,
        next: command,
        launchId: launch.worker.id,
        coordinator: launchCoordinator,
      });
    } catch {
      io.stderr("armada: warning: could not record the failed launch on Armada.\n");
    }
    return new LaunchError(message, command);
  };
  const fail = async (outcome: "failed" | "uncertain", reason: string, next: string): Promise<never> => {
    throw await recordFailure(outcome, reason, next);
  };
  try {
    if (local && runtime instanceof HerdrAdapter) {
      worker = await runtime.launchPrepared(spec, async (created) => {
        if (!created.path) throw new UsageError("herdr did not return a worktree");
        handle = { ...parseHerdrHandle(created.handle), path: created.path };
        if (configSnapshot !== null && io.writeFile) await io.writeFile(join(handle.path, CONFIG_FILE), configSnapshot);
        return build({ choice: local, handle: herdrClaimHandle(handle) });
      });
    } else {
      spec.prompt = build();
      worker = await runtime.launch(spec);
    }
  } catch (error) {
    const recover = (runtime as RuntimeAdapter).recoverLaunch?.bind(runtime);
    if (
      (spec.from.kind === "in-place" || !recover) &&
      error instanceof RuntimeError &&
      error.code === "unknown-outcome"
    )
      await fail(
        "uncertain",
        `Launch has an unknown outcome; the pending launch is retained. Inspect the runtime before retrying${handle ? `: ${herdrClaimHandle(handle)}` : ""}`,
        runtimeName === "herdr" ? "herdr agent list" : `armada peek ${ticketId}`,
      );
    if (error instanceof RuntimeError && error.code === "unknown-outcome" && recover) {
      try {
        const recovery = await recover(spec, started);
        const recovered = recovery.workers[0];
        if (recovery.complete && recovery.candidates.length === 1 && recovered) {
          worker = recovered;
          unconfirmed = "the worker may not have received its brief";
          io.stderr(
            `armada: recovered the Conductor workspace after an uncertain launch; inspect ${recovered.handle} to confirm the worker received its brief.\n`,
          );
        } else if (!recovery.complete || recovery.candidates.length > 1) {
          // An uncertain search is not a refusal: preserve the token and block a second launch.
          throw new LaunchError(
            `Conductor recovery ${recovery.complete ? "returned several possible workers" : "is incomplete"}: ${recovery.candidates.join(", ") || "no visible candidate ids"}; the pending launch is retained. Inspect conductor workspace list --mine --repo ${config.github.repository} --since ${started}; pick the worker or revoke the launch, then archive unwanted workspaces with conductor workspace archive <workspace>`,
            `armada launch revoke ${ticketId}`,
          );
        }
      } catch (recoveryError) {
        if (recoveryError instanceof LaunchError) await fail("uncertain", recoveryError.message, recoveryError.next);
        await fail(
          "uncertain",
          `Conductor recovery could not be completed; the pending launch is retained. Inspect conductor workspace list --mine --repo ${config.github.repository} --since ${started} before revoking or archiving possible workspaces`,
          `armada launch revoke ${ticketId}`,
        );
      }
    }
    if (!worker) {
      if (handle) io.stderr(`armada: local workspace retained: ${herdrClaimHandle(handle)}\n`);
      const revoked = await revoke();
      const message =
        error instanceof UsageError || error instanceof BriefError || error instanceof RuntimeError
          ? error instanceof RuntimeError && error.cause instanceof UsageError
            ? error.cause.message
            : error.message
          : `${runtimeName} worker launch failed`;
      await fail(
        "failed",
        message,
        !revoked
          ? `armada launch revoke ${ticketId}`
          : handle
            ? `herdr agent attach ${handle.agent}`
            : runtimeName === "herdr"
              ? "herdr agent list"
              : error instanceof RuntimeError && ["invalid", "unknown-outcome"].includes(error.code)
                ? "conductor model"
                : `armada launch ${ticketId}`,
      );
    }
  }
  if (!worker)
    throw await recordFailure("failed", "runtime did not return a worker handle", `armada launch revoke ${ticketId}`);
  try {
    await recheckMutation();
    await (bindLaunch ?? api.bindLaunch)(signIn, {
      project: config.project.slug,
      ticket: ticketId,
      id: launch.worker.id,
      runtime: runtimeName,
      handle: worker.handle,
    });
  } catch (error) {
    io.stderr(
      error instanceof ArmadaApiError && error.status === 404
        ? "armada: warning: launch binding is not deployed yet; the worker's sign-in will record its handle.\n"
        : "armada: warning: could not bind the launched worker; its sign-in will record the handle.\n",
    );
  }
  if (unconfirmed) await recordFailure("uncertain", unconfirmed, `armada peek ${ticketId}`);
  const known = (await watchOf(io, config.project.slug)).state?.inFlight ?? [];
  const inFlightTickets = [...new Set([...known, ticketId])].sort();
  const fleet = liveFleet(io, config, credentials).fleet;
  const counted = config.policy.maxWorkers && fleet ? await countWorkerSlots(io, fleet).catch(() => null) : null;
  const slots = counted ? { taken: counted.taken, max: config.policy.maxWorkers } : undefined;
  await remember(io, config.project.slug, {
    inFlight: inFlightTickets,
    ...(slots ? { slots } : {}),
    readAt: now().toISOString(),
  });
  const watch = await rearmFor(io, config.project.slug, { inFlight: inFlightTickets, slots, open: null });
  const result = {
    ticket: ticketId,
    title: p.ticket.title,
    runtime: runtimeName,
    profile: choice.name,
    why: choice.why,
    agent: profile.agent,
    model: profile.model,
    effort: profile.effort,
    fastMode: profile.fastMode,
    branch,
    ...worker,
    unconfirmed,
    ...(local
      ? {
          harness: local.profile.harness,
          actualHarness: herdrHarnessKind(local.profile.harness),
          harnessDescription: herdrHarnessLabel(local.profile.harness),
        }
      : {}),
    watch,
  };
  return result;
}

export function printLaunch(p: PreparedLaunch, result: Awaited<ReturnType<typeof executeLaunch>>) {
  const { io, args, ticketId, choice, local } = p;
  const worker = result;
  const watch = result.watch;
  const headline = `Launched ${ticketId} "${launchTitle(p.ticket.title)}"${result.unconfirmed ? ` (unconfirmed: ${result.unconfirmed})` : ""}`;
  io.stdout(
    args.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : local
        ? `${headline} with ${herdrHarnessLabel(local.profile.harness)} on profile ${choice.name}.\nWorktree: ${worker.path}\nHandle: ${worker.handle}\nThe worker signs in and claims its ticket from the brief.\n${watch.line}\n`
        : `${headline} on profile ${choice.name} — ${choice.why}.\nWorkspace: ${worker.handle.split("/")[0]}\nSession: ${worker.handle.split("/")[1]}\n${worker.link ?? "Conductor did not return a session link"}\n${watch.line}\n`,
  );
}

export async function withLaunchLease<T>(
  io: Io,
  fleet: import("@armada/core").Fleet,
  ticketId: string,
  act: (lease: { name: string; holder: string; ttlMs: number }) => Promise<T>,
) {
  // Different terminals, including two commands in one coordinator session, need different holders.
  const holder = `${coordinatorHandle(io) ?? `terminal:${io.pid ?? process.pid}`}:${randomUUID()}`;
  const name = `launch:${ticketId}`;
  const lease = await fleet.acquireLease({ name, holder, ttlMs: 5 * 60_000 });
  if (!lease.acquired) throw new UsageError(`${ticketId} has another launch in progress; inspect it before retrying`);
  try {
    return await act({ name, holder, ttlMs: 5 * 60_000 });
  } finally {
    try {
      await fleet.releaseLease({ name, holder });
    } catch {
      io.stderr("armada: warning: could not release the launch lease; it expires after five minutes.\n");
    }
  }
}

async function readNotes(io: Io, path: string | undefined): Promise<string | null> {
  if (path === undefined) return null;
  let text: string | null;
  try {
    if (path === "-") {
      if (!io.readStdin) throw new UsageError("--notes - needs standard input");
      text = await io.readStdin();
    } else text = await io.readFile(resolve(io.cwd, path));
  } catch {
    throw new UsageError("could not read --notes; supply a readable file or - for standard input");
  }
  if (text === null) throw new UsageError("--notes file is missing");
  if (!text.trim()) throw new UsageError("--notes must not be empty");
  if (Buffer.byteLength(text, "utf8") > 16 * 1024) throw new UsageError("--notes must be at most 16 KB");
  return text.trim();
}

/**
 * `launch --dry-run` (THE-972): print the routing, the machine and the preflight
 * without creating anything. Every probe and git read is read-only: no token is
 * minted, no worktree or pane is created, nothing is installed and no config is
 * written. The worktree path is a prediction of herdr's own layout.
 */
async function launchPlan(
  io: Io,
  json: boolean,
  input: {
    ticketId: string;
    title: string;
    choice: HerdrProfileChoice;
    branch: string;
    version: string;
    preApproval: string | null;
  },
): Promise<number> {
  // The same read-only preflight launch runs, without install offers, prompts or writes.
  const openCode = herdrHarnessKind(input.choice.profile.harness) === "opencode";
  const detected = await detectLocalTools(
    io,
    [input.choice.profile.harness],
    openCode
      ? [{ name: input.choice.name, harness: input.choice.profile.harness, model: input.choice.profile.model }]
      : [],
  );
  const npm = await checkPublished(input.version, io.fetch ?? fetch);
  const describe = (checks: typeof detected.checks) =>
    checks.map((check) => `${check.message}${check.fix ? `: ${check.fix}` : ""}`);
  const gaps = describe(detected.checks.filter((check) => check.level === "error"));
  const warnings = describe(detected.checks.filter((check) => check.level === "warning"));
  if (npm.state === "missing")
    gaps.push(`armada ${input.version} is not on npm yet; publish this version before launching local workers`);
  // Predict the worktree path from read-only git state; a missing repository is a gap too.
  let worktree: string | null = null;
  let base: string | null = null;
  try {
    const execute = io.exec;
    if (!execute) throw new UsageError("local launch needs process execution");
    const root = await execute("git", ["rev-parse", "--show-toplevel"], { cwd: io.cwd, timeoutMs: 10_000 });
    if (root.code !== 0 || !root.stdout.trim().startsWith("/"))
      throw new UsageError("local launch must run in a git repository");
    const repo = root.stdout.trim();
    // Herdr names the worktree folder after the main repository, even from a linked worktree.
    const common = await execute("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: repo,
      timeoutMs: 10_000,
    });
    const mainRoot = common.code === 0 && common.stdout.trim().startsWith("/") ? dirname(common.stdout.trim()) : repo;
    const remote = await execute("git", ["ls-remote", "--symref", "origin", "HEAD"], { cwd: repo, timeoutMs: 20_000 });
    base = remote.code === 0 ? (remote.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m)?.[1] ?? null) : null;
    if (!base) throw new UsageError("could not read the default branch of origin");
    const configHome = io.env.XDG_CONFIG_HOME ?? (io.env.HOME ? join(io.env.HOME, ".config") : null);
    const herdrConfigPath = io.env.HERDR_CONFIG_PATH ?? (configHome ? join(configHome, "herdr", "config.toml") : null);
    const herdrConfig = herdrConfigPath ? await io.readFile(herdrConfigPath).catch(() => null) : null;
    worktree = herdrWorktreePath(herdrWorktreesDirectory(io.env, herdrConfig), basename(mainRoot), input.branch);
  } catch (error) {
    gaps.push(error instanceof UsageError ? error.message : "could not read the repository state");
  }
  const ready = gaps.length === 0;
  const plan = {
    ticket: input.ticketId,
    title: input.title,
    runtime: "herdr",
    dryRun: true,
    preApproval: input.preApproval,
    profile: input.choice.name,
    profileWhy: input.choice.why,
    routed: input.choice.routed,
    reason: input.choice.reason,
    harness: input.choice.profile.harness,
    actualHarness: herdrHarnessKind(input.choice.profile.harness),
    harnessDescription: herdrHarnessLabel(input.choice.profile.harness),
    model: input.choice.profile.model,
    effort: input.choice.profile.effort,
    branch: input.branch,
    worktree,
    base,
    preflight: { ready, gaps, warnings },
  };
  io.stdout(
    json
      ? `${JSON.stringify(plan, null, 2)}\n`
      : `Launch plan for ${input.ticketId} "${launchTitle(input.title)}" (dry run: nothing is created)\n\nProfile    ${input.choice.name} — ${input.choice.why}\nHarness    ${plan.harnessDescription} (exact model: ${plan.model || "not set"}, effort ${plan.effort})\nBranch     ${plan.branch}\nWorktree   ${worktree ?? "unknown"}\nBase       ${base ?? "unknown"}\nPreflight  ${ready ? "ready" : "blocked"}\n`,
  );
  if (!json && input.preApproval) io.stdout(`${input.preApproval}\n`);
  for (const warning of warnings) io.stderr(`armada: warning: ${warning}\n`);
  for (const gap of gaps) io.stderr(`armada: ${gap}\n`);
  return ready ? 0 : 1;
}

async function deferLaunch(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  args: { rest: string[]; json: boolean; options: Record<string, string> },
) {
  const [input, ...extra] = args.rest;
  if (!input || extra.length || !/^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/.test(input))
    throw new UsageError("deferred launch needs a ticket: armada launch <ticket> --when-unblocked");
  for (const key of Object.keys(args.options))
    if (!["when-unblocked", "after", "profile"].includes(key))
      throw new UsageError(
        `--${key} cannot be stored with --when-unblocked; use it when launching the unblocked ticket`,
      );
  requireSignIn(credentials);
  const { fleet, warning } = liveFleet(io, config, credentials);
  if (!fleet) throw new UsageError(warning ?? "deferred launches need Armada");
  const request = await fleet.deferLaunch({
    ticket: input.toUpperCase(),
    profile: args.options.profile ?? null,
    after: args.options.after ?? null,
  });
  const previous = (await watchOf(io, config.project.slug)).state;
  const inFlight = previous?.inFlight ?? [];
  const waiting = [...new Set([...(previous?.waiting ?? []), request.ticket])];
  const counted = config.policy.maxWorkers ? await countWorkerSlots(io, fleet).catch(() => null) : null;
  const slots = counted ? { taken: counted.taken, max: config.policy.maxWorkers } : undefined;
  await remember(io, config.project.slug, { waiting, ...(slots ? { slots } : {}) });
  const watch = await rearmFor(io, config.project.slug, { inFlight, waiting: waiting.length, slots, open: null });
  io.stdout(
    args.json
      ? `${JSON.stringify({ ...request, watch }, null, 2)}\n`
      : `${request.ticket} will launch once ${request.reason?.startsWith("waits for a worker slot") ? "a worker slot frees" : `${request.blockers?.join(", ")} ${request.blockers?.length === 1 ? "is" : "are"} done`} (request #${request.id}).\n${watch.line}\n`,
  );
  return 0;
}
