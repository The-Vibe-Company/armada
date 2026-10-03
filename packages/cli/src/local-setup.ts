import { type ArmadaConfig, herdrHarnessKind, parseConfig, setHerdrPermissions } from "@armada/core";
import { Herdr, type HerdrHandle } from "./herdr.ts";
import { type Io, UsageError } from "./io.ts";
import { detectLocalTools, localHarnesses, localModelProfiles, offerLocalInstalls } from "./local-tools.ts";

/** Explicit owner setup: no Armada sign-in, launch token, ticket or fleet write. */
export async function setupLocal(
  io: Io,
  initial: ArmadaConfig,
  configPath: string,
  args: { rest: string[]; json: boolean },
): Promise<number> {
  if (args.rest.length !== 1 || args.rest[0] !== "local")
    throw new UsageError("setup needs a command: armada setup local");
  if (args.json || !io.interactive || io.env.CI || !io.prompt) {
    const message =
      "Local setup needs the owner at an interactive terminal to choose permissions and answer harness questions";
    io.stdout(
      args.json
        ? `${JSON.stringify({ ready: false, message, next: "armada setup local at an interactive terminal" })}\n`
        : `${message}: run armada setup local at an interactive terminal.\n`,
    );
    return 1;
  }
  let config = initial;
  const profiles = Object.entries(config.herdr.profiles);
  if (!profiles.length) throw new UsageError("local setup needs at least one [herdr.profiles.<name>] in armada.toml");
  const unset = profiles.filter(([, p]) => p.permissions === undefined).map(([name]) => name);
  if (unset.length) {
    if (!io.writeFile)
      throw new UsageError("local setup needs configuration writes to save the owner's permission choice");
    const before = await io.readFile(configPath);
    if (before === null || JSON.stringify(parseConfig(before, configPath)) !== JSON.stringify(initial))
      throw new UsageError("configuration changed before setup; retry with the current armada.toml");
    io.stdout(
      `Choose permissions for local profiles: ${unset.join(", ")}.\nAsk keeps each harness's normal approval policy. Full uses Claude --dangerously-skip-permissions, Codex --dangerously-bypass-approvals-and-sandbox (no command sandbox), and OpenCode --auto (explicit deny rules still apply).\nTrust, MCP, sign-in and model questions remain the owner's decisions.\n`,
    );
    const answer = await io.prompt("Permissions [ask/full] (Enter for ask): ", { hidden: false });
    if (answer === null) return 1;
    const permissions = answer.trim().toLowerCase() || "ask";
    if (permissions !== "ask" && permissions !== "full") {
      io.stderr("Choose ask or full; configuration unchanged.\n");
      return 1;
    }
    if ((await io.readFile(configPath)) !== before) {
      io.stderr("Configuration changed while you chose permissions; retry setup without overwriting that edit.\n");
      return 1;
    }
    let next: string;
    try {
      next = setHerdrPermissions(before, unset, permissions);
      const parsed = parseConfig(next, configPath);
      await io.writeFile(configPath, next);
      config = parsed;
    } catch {
      throw new UsageError(
        `could not safely save permissions; set permissions = "${permissions}" in the named profiles yourself, removing any conflicting native bypass flag from extra_args`,
      );
    }
    io.stdout(`Saved permissions = "${permissions}" for ${unset.join(", ")} in ${configPath}.\n`);
  }
  if (!io.exec) throw new UsageError("local setup needs process execution");
  const detected = await offerLocalInstalls(
    io,
    await detectLocalTools(io, localHarnesses(config), localModelProfiles(config)),
  );
  // Missing sign-in/model is precisely what the owner will resolve in the panes.
  // Only an unusable binary prevents creating setup sessions.
  if (detected.tools.some((tool) => tool.state !== "ready")) {
    for (const check of detected.checks.filter((c) => c.level === "error"))
      io.stderr(`${check.message}${check.fix ? `: ${check.fix}` : ""}\n`);
    return 1;
  }
  const git = await io.exec("git", ["rev-parse", "--show-toplevel"], { cwd: io.cwd, timeoutMs: 10_000 });
  const repo = git.stdout.trim();
  if (
    git.code !== 0 ||
    !repo.startsWith("/") ||
    [...repo].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new UsageError("local setup must run in a git repository");
  const runtime = new Herdr(io);
  await runtime.ensureServer();
  const location = await runtime.setupRoot(repo, config.project.slug, config.secrets.names);
  const workspace = await runtime.setupWorkspace(location.root, config.secrets.names);
  io.stdout(
    `Local setup at ${location.root}.\nAnswer each harness's folder trust, update, project MCP, sign-in and model questions yourself in its pane. Armada never answers these questions or edits harness settings.\nClaude Code: trusting this parent folder does not cover Git repositories beneath it. Current versions key linked-worktree trust on the main checkout (${location.repo}); approve that repository yourself, or answer each new worktree's question on versions that ask again. Project MCP questions can still appear per checkout.\n`,
  );
  const selected = new Set<string>();
  const sessions: {
    handle: HerdrHandle;
    profile: ArmadaConfig["herdr"]["profiles"][string];
    name: string;
    error: string | null;
  }[] = [];
  for (const [name, profile] of Object.entries(config.herdr.profiles)) {
    const kind = herdrHarnessKind(profile.harness);
    if (selected.has(kind)) continue;
    selected.add(kind);
    const pane = await runtime.setupPane(workspace, location.root, profile, config.secrets.names);
    const session = { handle: pane.handle, profile, name, error: null as string | null };
    sessions.push(session);
    io.stdout(`${kind} (profile ${name}): herdr agent attach ${pane.handle.agent}\n`);
    if (!pane.existing) {
      try {
        await runtime.startChecked(pane.handle, profile);
      } catch (error) {
        session.error =
          error instanceof UsageError
            ? error.message
            : `Could not start ${kind}; run herdr agent attach ${pane.handle.agent}`;
        io.stdout(`${session.error}\n`);
      }
    }
  }
  io.stdout(
    "Setup checks the selected profile for each native harness; other models remain subject to armada doctor's profile checks.\n",
  );
  const answer = await io.prompt(
    "Answer the questions in those panes, then press Enter here to check (or Ctrl-C to leave them open): ",
    { hidden: false },
  );
  if (answer === null) return 1;
  let ready = true;
  for (const session of sessions) {
    try {
      const screen = await runtime.inspect(session.handle, session.profile.harness);
      if (screen.issue || !screen.ready) {
        ready = false;
        io.stdout(
          `${screen.issue?.message ?? "The harness is not ready"}: herdr agent attach ${session.handle.agent}\n`,
        );
      } else {
        await runtime.checkSetupModel(session.handle, session.profile);
        io.stdout(
          `${herdrHarnessKind(session.profile.harness)} (profile ${session.name}): ready; model answered the setup check.\n`,
        );
      }
    } catch (error) {
      ready = false;
      io.stdout(
        `${error instanceof UsageError ? error.message : "Could not verify the harness"}; herdr agent attach ${session.handle.agent}\n`,
      );
    }
  }
  io.stdout(
    `${ready ? "Local setup checked" : "Local setup still needs attention"}. The panes and setup checkout are kept; rerun armada setup local to check again.\n`,
  );
  return ready ? 0 : 1;
}
