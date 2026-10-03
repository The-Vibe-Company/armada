import { dirname, join } from "node:path";
import {
  type ArmadaConfig,
  armadaAddress,
  BriefError,
  buildBrief,
  buildModel,
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
  inFlight,
  LINEAR_KEY,
  ProfileError,
  type ValidationChoice,
  ValidationChoiceError,
} from "@armada/core";
import { apiOf } from "./api.ts";
import { Herdr, type HerdrHandle } from "./herdr.ts";
import { type Io, missingKey, UsageError } from "./io.ts";
import { ensureLocalTools } from "./local-tools.ts";
import { requireSignIn } from "./login.ts";
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
      "launch needs a ticket and runtime: armada launch <ticket> --runtime herdr [--harness claude|codex|opencode]",
    );
  const requested = o.profile?.trim() || null;
  const reason = o.reason?.trim() || null;
  if (reason && !requested) throw new UsageError("--reason goes with --profile");
  if (o.harness && !HERDR_HARNESSES.includes(o.harness as HerdrHarness))
    throw new UsageError("--harness must be claude, codex or opencode");
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
      command: `armada launch ${ticketId} --runtime herdr`,
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
  const execute = io.exec;
  const preflight: Io = {
    ...io,
    interactive: args.json ? false : io.interactive,
    exec: (command, argv, options) => execute(command, argv, { ...options, timeoutMs: options.timeoutMs ?? 10_000 }),
  };
  if (!(await ensureLocalTools(preflight, choice.profile.harness))) return 1;
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
  const launch = await api.launchToken(signIn, { project: config.project.slug, ticket: ticketId });
  const runtime = new Herdr(io);
  let handle: HerdrHandle | undefined;
  try {
    await runtime.ensureServer();
    handle = await runtime.create({ repo, branch, base, ticket: ticketId, secrets: config.secrets.names });
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
    await runtime.start(handle, choice.profile);
    await runtime.prompt(handle, b.prompt);
  } catch (error) {
    // Keep the workspace for recovery; deletion could lose the worker's unpushed work.
    if (handle) io.stderr(`armada: local workspace retained: ${herdrClaimHandle(handle)}\n`);
    throw new UsageError(
      error instanceof UsageError || error instanceof BriefError ? error.message : "local worker launch failed",
      `inspect herdr agent list; revoke the pending token with armada launch revoke ${ticketId} before retrying`,
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
    branch,
    handle: herdrClaimHandle(handle),
    path: handle.path,
    state: "working",
    watch,
  };
  io.stdout(
    args.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `Launched ${ticketId} with ${result.harness} on profile ${choice.name}.\nWorktree: ${handle.path}\nHandle: ${result.handle}\nThe worker signs in and claims its ticket from the brief.\n${watch.line}\n`,
  );
  return 0;
}
