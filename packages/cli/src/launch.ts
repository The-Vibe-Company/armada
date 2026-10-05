import { basename, dirname, join } from "node:path";
import {
  type ArmadaConfig,
  armadaAddress,
  BriefError,
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
  ProfileError,
  parseConfig,
  shellWord,
  type ValidationChoice,
  ValidationChoiceError,
} from "@armada/core";
import { apiOf } from "./api.ts";
import { Herdr, type HerdrHandle, herdrWorktreePath, herdrWorktreesDirectory } from "./herdr.ts";
import { type Io, missingKey, UsageError } from "./io.ts";
import { detectLocalTools, ensureLocalProfile } from "./local-tools.ts";
import { requireSignIn } from "./login.ts";
import { preApprovalReason, preparePreApproval } from "./plan-approval.ts";
import { rearmFor, remember, watchOf } from "./watch.ts";

export async function launch(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  args: { rest: string[]; json: boolean; options: Record<string, string> },
  version: string,
  configPath: string,
) {
  if (args.rest[0] !== "revoke") return launchLocal(io, config, credentials, args, version, configPath);
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
  if (inFlight)
    await remember(io, config.project.slug, { inFlight, readAt: (io.now ?? (() => new Date()))().toISOString() });
  const watch = await rearmFor(io, config.project.slug, { inFlight, open: null });
  io.stdout(
    args.json
      ? `${JSON.stringify({ ...revoked, watch }, null, 2)}\n`
      : `Revoked the pending launch of ${revoked.ticket}.\n${watch.line}\n`,
  );
  return 0;
}

async function launchLocal(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  args: { rest: string[]; json: boolean; options: Record<string, string> },
  version: string,
  configPath: string,
) {
  const [input, ...extra] = args.rest;
  const o = args.options;
  if (!input || extra.length || !/^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/.test(input) || o.runtime !== "herdr")
    throw new UsageError(
      "launch needs a ticket and runtime: armada launch <ticket> --runtime herdr [--harness claude|codex|opencode|deepseek]",
    );
  const requested = o.profile?.trim() || null;
  const reason = o.reason?.trim() || null;
  const approvalReason = preApprovalReason(o);
  if (reason && !requested && !approvalReason) throw new UsageError("--reason goes with --profile");
  if (o.harness && !HERDR_HARNESSES.includes(o.harness as HerdrHarness))
    throw new UsageError("--harness must be claude, codex, opencode or deepseek (OpenCode + DeepSeek model)");
  try {
    checkRequestedProfile(config, requested, "herdr");
  } catch (error) {
    if (error instanceof ProfileError) throw new UsageError(error.message);
    throw error;
  }
  const signIn = requireSignIn(credentials);
  if (!credentials.linearApiKey) throw missingKey(LINEAR_KEY);
  if (!io.exec) throw new UsageError("local launch needs process execution");
  const ticketId = input.toUpperCase();
  const now = io.now ?? (() => new Date());
  const linear = { apiKey: credentials.linearApiKey, fetch: io.fetch ?? fetch };
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
    inFlight(buildModel(program.issues, program.rootId), program.comments, {
      now: now().getTime(),
      silentAfterMinutes: config.policy.silentAfterMinutes,
    }).some((lane) => lane.issue.id === ticketId)
  )
    throw new UsageError(`${ticketId} is already in flight; inspect its worker before launching again`);
  const branch = ticket.branchName;
  if (!branch) throw new UsageError(`${ticketId} has no suggested branch in Linear`);
  let choice: HerdrProfileChoice | null;
  let validation: ValidationChoice | null;
  try {
    choice = chooseProfile(config, { ticket: ticketId, labels: ticket.labels, requested, reason }, "herdr");
    validation = chooseValidations(config.policy.validations, {
      ticket: ticketId,
      requested: o.validation ?? null,
      reason: o["validation-reason"] ?? null,
      command: [
        `armada launch ${ticketId} --runtime herdr`,
        ...["harness", "profile", "reason"].flatMap((key) => (o[key] ? [`--${key} ${shellWord(o[key])}`] : [])),
        ...["pre-approve", "dry-run"].filter((key) => o[key] === "true").map((key) => `--${key}`),
        ...(args.json ? ["--json"] : []),
      ].join(" "),
    });
  } catch (error) {
    if (error instanceof ProfileError) throw new UsageError(error.message);
    if (error instanceof ValidationChoiceError) throw new UsageError(error.message, error.next);
    throw error;
  }
  if (!choice) throw new UsageError("local launch needs a [herdr.profiles.<name>] with harness, model and effort");
  if (o.harness && o.harness !== choice.profile.harness)
    throw new UsageError(
      `profile "${choice.name}" uses ${choice.profile.harness}; choose a matching --profile with --reason to change harness`,
    );
  const approval = approvalReason ? await preparePreApproval(io, config, credentials, ticket, approvalReason) : null;
  if (o["dry-run"] === "true")
    return await launchPlan(io, args.json, {
      ticketId,
      choice,
      branch,
      version,
      preApproval: approval?.preview ?? null,
    });
  const execute = io.exec;
  const preflight: Io = {
    ...io,
    interactive: args.json ? false : io.interactive,
    exec: (command, argv, options) => execute(command, argv, { ...options, timeoutMs: options.timeoutMs ?? 10_000 }),
  };
  const model = await ensureLocalProfile(preflight, configPath, choice.name, choice.profile);
  if (model === null) return 1;
  choice.profile.model = model;
  // Claim reads configuration in the worker worktree, not the coordinator checkout.
  const openCode = herdrHarnessKind(choice.profile.harness) === "opencode";
  const configSnapshot = openCode ? await io.readFile(configPath) : null;
  if (openCode) {
    if (!io.writeFile || configSnapshot === null)
      throw new UsageError("local OpenCode launch needs the configuration copied into its worker worktree");
    if (JSON.stringify(parseConfig(configSnapshot, configPath)) !== JSON.stringify(config))
      throw new UsageError("configuration changed during preflight; retry launch with the saved model");
  }
  const root = await io.exec("git", ["rev-parse", "--show-toplevel"], { cwd: io.cwd, timeoutMs: 10_000 });
  if (root.code !== 0 || !root.stdout.trim().startsWith("/"))
    throw new UsageError("local launch must run in a git repository");
  const repo = root.stdout.trim();
  const remote = await io.exec("git", ["ls-remote", "--symref", "origin", "HEAD"], { cwd: repo, timeoutMs: 20_000 });
  const base = remote.code === 0 ? remote.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m)?.[1] : null;
  if (!base) throw new UsageError("could not read the default branch of origin");
  const conventions = config.brief.extra
    ? { path: config.brief.extra, text: await io.readFile(join(dirname(configPath), config.brief.extra)) }
    : null;
  const npm = await checkPublished(version, io.fetch ?? fetch);
  // An older package cannot understand the new local profile in the claim.
  if (npm.state === "missing")
    throw new UsageError(`armada ${version} is not on npm yet; publish this version before launching local workers`);
  const api = apiOf(io, credentials.armadaApi.url);
  // Prerequisites and all policy judgments are settled before a one-time token is made.
  const preApprovedReason = await approval?.apply();
  const launch = await api.launchToken(signIn, { project: config.project.slug, ticket: ticketId });
  const runtime = new Herdr(io);
  let handle: HerdrHandle | undefined;
  try {
    await runtime.ensureServer();
    handle = await runtime.create({ repo, branch, base, ticket: ticketId, secrets: config.secrets.names });
    if (configSnapshot !== null && io.writeFile) await io.writeFile(join(handle.path, CONFIG_FILE), configSnapshot);
    const b = buildBrief({
      config,
      ticket,
      program,
      profile: null,
      version,
      npm,
      env: io.env,
      now: now(),
      conventions,
      validation,
      preApprovedReason,
      launch: {
        token: launch.token,
        expiresAt: launch.expiresAt,
        apiUrl:
          armadaAddress(credentials.armadaApi.url) === armadaAddress(DEFAULT_ARMADA_API_URL)
            ? null
            : armadaAddress(credentials.armadaApi.url),
      },
      herdr: { choice, handle: herdrClaimHandle(handle) },
    });
    await runtime.startChecked(handle, choice.profile);
    await runtime.promptChecked(handle, choice.profile, b.prompt);
  } catch (error) {
    // Keep the workspace for recovery; deletion could lose the worker's unpushed work.
    if (handle) io.stderr(`armada: local workspace retained: ${herdrClaimHandle(handle)}\n`);
    let revoked = false;
    try {
      await api.revokePendingLaunch(signIn, { project: config.project.slug, ticket: ticketId, id: launch.worker.id });
      revoked = true;
      io.stderr(`armada: revoked the pending launch of ${ticketId}.\n`);
    } catch {
      io.stderr(
        `armada: could not revoke the pending launch; run armada launch revoke ${ticketId} before retrying (a claimed worker must release).\n`,
      );
    }
    throw new UsageError(
      error instanceof UsageError || error instanceof BriefError ? error.message : "local worker launch failed",
      !revoked
        ? `armada launch revoke ${ticketId}`
        : handle
          ? `herdr agent attach ${handle.agent}`
          : "herdr agent list",
    );
  }
  const known = (await watchOf(io, config.project.slug)).state?.inFlight ?? [];
  const inFlightTickets = [...new Set([...known, ticketId])].sort();
  await remember(io, config.project.slug, { inFlight: inFlightTickets, readAt: now().toISOString() });
  const watch = await rearmFor(io, config.project.slug, { inFlight: inFlightTickets, open: null });
  const result = {
    ticket: ticketId,
    runtime: "herdr",
    profile: choice.name,
    harness: choice.profile.harness,
    actualHarness: herdrHarnessKind(choice.profile.harness),
    harnessDescription: herdrHarnessLabel(choice.profile.harness),
    branch,
    handle: herdrClaimHandle(handle),
    path: handle.path,
    state: "working",
    watch,
  };
  io.stdout(
    args.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `Launched ${ticketId} with ${result.harnessDescription} on profile ${choice.name}.\nWorktree: ${handle.path}\nHandle: ${result.handle}\nThe worker signs in and claims its ticket from the brief.\n${watch.line}\n`,
  );
  return 0;
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
  input: { ticketId: string; choice: HerdrProfileChoice; branch: string; version: string; preApproval: string | null },
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
      : `Launch plan for ${input.ticketId} (dry run: nothing is created)\n\nProfile    ${input.choice.name} — ${input.choice.why}\nHarness    ${plan.harnessDescription} (exact model: ${plan.model || "not set"}, effort ${plan.effort})\nBranch     ${plan.branch}\nWorktree   ${worktree ?? "unknown"}\nBase       ${base ?? "unknown"}\nPreflight  ${ready ? "ready" : "blocked"}\n`,
  );
  if (!json && input.preApproval) io.stdout(`${input.preApproval}\n`);
  for (const warning of warnings) io.stderr(`armada: warning: ${warning}\n`);
  for (const gap of gaps) io.stderr(`armada: ${gap}\n`);
  return ready ? 0 : 1;
}
