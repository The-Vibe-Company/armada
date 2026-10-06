// Herdr's JSON CLI is the runtime boundary. Never surface arbitrary CLI output:
// agent prompt may include a one-time launch token in its arguments or errors.
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  type HerdrHarness,
  type HerdrProfile,
  herdrHarnessKind,
  herdrHarnessLabel,
  herdrPermissionArgs,
  type RuntimeState,
} from "@armada/core";
import { type FirstRunIssue, firstRunIssue } from "./first-run.ts";
import { type Io, UsageError } from "./io.ts";
import { verifyOpenCodeModel } from "./opencode-model.ts";

export class HerdrError extends UsageError {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }
}

export interface HerdrClaimHandle {
  workspace: string;
  pane: string;
  agent: string;
}

export interface HerdrHandle extends HerdrClaimHandle {
  workspace: string;
  pane: string;
  agent: string;
  path: string;
}

export const harnessArgs = (p: HerdrProfile): string[] => [
  "--model",
  p.model,
  ...(p.harness === "codex"
    ? ["-c", `model_reasoning_effort=${JSON.stringify(p.effort)}`]
    : p.harness === "claude"
      ? ["--effort", p.effort]
      : []),
  ...(p.harness === "codex" &&
  !p.extraArgs.some((arg) => /^(?:check_for_update_on_startup\s*=|--config=check_for_update_on_startup=)/.test(arg))
    ? ["-c", "check_for_update_on_startup=false"]
    : []),
  ...herdrPermissionArgs(p),
];

const object = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(v);

/**
 * Herdr's `[worktrees] directory` from its config, else the documented default
 * `~/.herdr/worktrees` (THE-972). Read-only: a preview only, herdr still decides
 * the real path when it creates the worktree.
 */
export function herdrWorktreesDirectory(env: Record<string, string | undefined>, configText: string | null): string {
  const configured = configText ? worktreesDirectoryOf(configText) : null;
  const directory = configured ?? "~/.herdr/worktrees";
  const home = env.HOME;
  if (directory === "~") return home ?? directory;
  if (directory.startsWith("~/")) return home ? join(home, directory.slice(2)) : directory;
  return directory;
}

/** Where herdr puts a managed worktree for `branch`: `<directory>/<repo>/<branch with "/" as "-">`. */
export function herdrWorktreePath(directory: string, repoName: string, branch: string): string {
  return join(directory, repoName, branch.replaceAll("/", "-"));
}

/** The `directory` of herdr's `[worktrees]` table, or null when unset. */
function worktreesDirectoryOf(text: string): string | null {
  let inWorktrees = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const table = line.match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
    if (table) {
      inWorktrees = table[1]?.trim() === "worktrees";
      continue;
    }
    if (!inWorktrees) continue;
    const value = line.match(/^directory\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/)?.[1];
    if (!value) continue;
    if (value.startsWith("'")) return value.slice(1, -1);
    try {
      return JSON.parse(value) as string;
    } catch {
      return null;
    }
  }
  return null;
}

/** Only persisted IDs, never arbitrary options, are accepted as runtime targets. */
export function parseHerdrHandle(raw: string): HerdrClaimHandle {
  let h: Record<string, unknown> | null = null;
  try {
    h = object(JSON.parse(raw));
  } catch {}
  if (!h || !id(h.workspace) || !id(h.pane) || !id(h.agent) || !/^[a-z][a-z0-9_-]{0,31}$/.test(h.agent))
    throw new UsageError("invalid herdr claim handle; expected JSON with workspace, pane and agent");
  return { workspace: h.workspace, pane: h.pane, agent: h.agent };
}

export function herdrPhase(phase: string | null | undefined): RuntimeState {
  if (phase === "blocked" || phase === "awaiting-approval" || phase === "awaiting-validation") return "blocked";
  if (phase === "ready-to-merge") return "idle";
  return phase && ["planning", "implementing", "shipping"].includes(phase) ? "working" : "unknown";
}

/** Runtime reporting is optional, including when the binary or server disappears. */
export async function reportHerdr(
  io: Io,
  phase: string | null | undefined,
  agent: string,
  heartbeat = false,
): Promise<void> {
  if (io.env.HERDR_ENV !== "1" || !io.env.HERDR_PANE_ID) return;
  try {
    if (!id(io.env.HERDR_PANE_ID)) throw new Error("invalid pane");
    await new Herdr(io).report(io.env.HERDR_PANE_ID, agent, herdrPhase(phase), heartbeat);
  } catch {
    io.stderr("armada: warning: could not report worker state to herdr; Armada reporting continues.\n");
  }
}

// Keep owner sign-ins on disk accessible through HOME, without exporting the
// coordinator's credentials to a persistent server or its future workers.
const runtimeEnvironment = (env: Io["env"]) =>
  Object.fromEntries(
    Object.entries(env).filter(([name]) =>
      /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|TERM|LC_[A-Z_]+|XDG_(CONFIG_HOME|DATA_HOME|STATE_HOME|CACHE_HOME|RUNTIME_DIR)|HERDR_(SESSION|SOCKET_PATH|CONFIG_PATH))$/.test(
        name,
      ),
    ),
  );
const credentialNames = (env: Io["env"], extra: string[]) =>
  [
    ...new Set([
      "LINEAR_API_KEY",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "ARMADA_API_KEY",
      "ARMADA_SESSION_TOKEN",
      "ARMADA_SIGNED_IN_TO",
      "ARMADA_API_URL",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      ...Object.keys(env).filter((name) => /^(ARMADA_|CONDUCTOR_)|(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(name)),
      ...extra,
    ]),
  ]
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .sort();

export class Herdr {
  private setupShell: { workspace: string; pane: string } | null = null;

  constructor(
    private readonly io: Io,
    private readonly beforeWrite?: () => Promise<void>,
  ) {}

  private async call(args: string[], timeoutMs = 40_000): Promise<Record<string, unknown>> {
    const operation = args.slice(0, 2).join(" ");
    if (
      ![
        "status --json",
        "workspace get",
        "workspace list",
        "worktree list",
        "agent get",
        "agent list",
        "agent wait",
        "pane get",
        "pane read",
      ].includes(operation)
    )
      await this.beforeWrite?.();
    let reply: Record<string, unknown> | null;
    let code: number;
    try {
      if (!this.io.exec) throw new Error("no exec");
      const out = await this.io.exec("herdr", args, { cwd: this.io.cwd, timeoutMs });
      if (out.timedOut) throw new HerdrError("herdr request timed out; inspect its pane before retrying", "timeout");
      code = out.code;
      // Herdr's terminal writes acknowledge success with no output by default.
      // Only these operations may omit JSON; reads and topology stay strict.
      if (
        code === 0 &&
        !out.stdout.trim() &&
        !out.stderr.trim() &&
        ["pane run", "pane report-agent", "pane report-metadata"].includes(operation)
      )
        return {};
      reply = object(JSON.parse(out.stdout || out.stderr));
    } catch (error) {
      if (error instanceof HerdrError) throw error;
      throw new UsageError(`herdr ${operation} failed; inspect the runtime with herdr agent list`);
    }
    const error = object(reply?.error);
    if (code !== 0 || error) {
      const reason = typeof error?.code === "string" && /^[a-z_]{1,64}$/.test(error.code) ? ` (${error.code})` : "";
      throw new HerdrError(
        `herdr ${operation} failed${reason}; inspect the runtime with herdr agent list`,
        reason ? String(error?.code) : null,
      );
    }
    if (!reply) throw new UsageError(`herdr ${operation} returned invalid JSON`);
    return reply;
  }

  async ensureServer(): Promise<void> {
    const status = async (timeoutMs: number) => {
      const server = object((await this.call(["status", "--json"], timeoutMs)).server);
      if (!server || typeof server.running !== "boolean") throw new UsageError("invalid herdr server status response");
      if (server.running && (server.compatible === false || server.endpoint_compatible === false))
        throw new UsageError("the running herdr server is incompatible; update or restart it before launching");
      return server.running;
    };
    if (await status(5_000)) return;
    await this.beforeWrite?.();
    if (
      !this.io.detach ||
      !(await this.io.detach("herdr", ["server"], { cwd: this.io.cwd, env: runtimeEnvironment(this.io.env) }))
    )
      throw new UsageError("could not start herdr server; start it headless with herdr server");
    // Bounded readiness polling, injected in tests; never restart a live server.
    const now = this.io.now ?? (() => new Date());
    const deadline = now().getTime() + 5_000;
    for (let attempt = 0; attempt < 20; attempt++) {
      const remaining = deadline - now().getTime();
      if (remaining <= 0) break;
      if (await status(Math.min(1_000, remaining))) return;
      const delay = Math.min(250, deadline - now().getTime());
      if (delay > 0) await (this.io.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))))(delay);
    }
    throw new UsageError("herdr server did not become ready; inspect herdr status");
  }

  /** Shared extension first, then a setting scoped to the newly created worktree. */
  private async gitConfig(repo: string, args: string[], read = false): Promise<string | null> {
    if (!read) await this.beforeWrite?.();
    const result = await this.io
      .exec?.("git", ["-C", repo, "config", ...args], { cwd: this.io.cwd, timeoutMs: 10_000, maxOutputBytes: 16_384 })
      .catch(() => null);
    if (read && result?.code === 1 && !result.timedOut && !result.outputExceeded) return null;
    if (result?.code !== 0 || result.timedOut || result.outputExceeded)
      throw new UsageError("could not configure worktree signing; inspect Git configuration before retrying");
    return result.stdout.trim();
  }

  private async enableWorktreeConfig(repo: string): Promise<void> {
    if (
      (await this.gitConfig(repo, ["--local", "--includes", "--bool", "--get", "extensions.worktreeConfig"], true)) ===
      "true"
    )
      return;
    // Enabling the extension changes how these common settings apply. Leave
    // migration to the owner instead of changing their checkout's behavior.
    const worktree = await this.gitConfig(repo, ["--local", "--includes", "--get", "core.worktree"], true);
    const bare = await this.gitConfig(repo, ["--local", "--includes", "--bool", "--get", "core.bare"], true);
    const sparse = await this.gitConfig(
      repo,
      ["--local", "--includes", "--bool", "--get", "core.sparseCheckout"],
      true,
    );
    if (worktree !== null || bare === "true" || sparse === "true")
      throw new UsageError(
        "worktree signing needs extensions.worktreeConfig: migrate core.worktree, core.bare or core.sparseCheckout to per-worktree config first (see git worktree documentation), or keep [git] sign = inherit",
      );
    await this.gitConfig(repo, ["--local", "extensions.worktreeConfig", "true"]);
  }

  async create(input: {
    repo: string;
    branch: string;
    base: string;
    ticket: string;
    secrets?: string[];
    label?: string;
    path?: string;
    agent?: string;
    sign?: "inherit" | "off";
  }): Promise<HerdrHandle> {
    const agent = input.agent ?? input.ticket.toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agent)) throw new UsageError("ticket cannot be used as a herdr agent name");
    if (input.sign === "off") await this.enableWorktreeConfig(input.repo);
    const r = object(
      (
        await this.call([
          "worktree",
          "create",
          "--cwd",
          input.repo,
          "--branch",
          input.branch,
          "--base",
          input.base,
          ...(input.path ? ["--path", input.path] : []),
          "--no-focus",
          ...(input.label ? ["--label", input.label] : []),
        ])
      ).result,
    );
    const workspace = object(r?.workspace)?.workspace_id;
    const rootPane = object(r?.root_pane)?.pane_id;
    const path = object(r?.worktree)?.path;
    if (
      !id(workspace) ||
      !id(rootPane) ||
      typeof path !== "string" ||
      !path.startsWith("/") ||
      object(r?.root_pane)?.workspace_id !== workspace
    )
      throw new UsageError("invalid herdr worktree response; inspect herdr worktree list before retrying");
    if (input.sign === "off") {
      await this.gitConfig(path, ["--worktree", "commit.gpgsign", "false"]);
      // An include copied from the owner's worktree can still override the
      // direct value. Check all scopes before starting an unattended worker.
      if ((await this.gitConfig(path, ["--includes", "--bool", "--get", "commit.gpgsign"], true)) !== "false")
        throw new UsageError(
          "worktree signing is still enabled by included or overriding Git configuration; move the signing override after includes in the worker's config.worktree before retrying",
        );
    }
    // A pre-existing server may carry coordinator credentials. Override them in
    // a dedicated worker shell, and use the pane ID returned by herdr.
    const tab = object(
      (
        await this.call([
          "tab",
          "create",
          "--workspace",
          workspace,
          "--cwd",
          path,
          "--no-focus",
          ...credentialNames(this.io.env, input.secrets ?? []).flatMap((name) => ["--env", `${name}=`]),
          "--env",
          `ARMADA_TICKET=${input.ticket}`,
        ])
      ).result,
    );
    const pane = object(tab?.root_pane)?.pane_id;
    if (!id(pane) || pane === rootPane || object(tab?.root_pane)?.workspace_id !== workspace)
      throw new UsageError("invalid herdr worker pane response; inspect herdr pane list before retrying");
    // Only the sanitized shell remains in the new workspace. A cleanup error
    // prevents the harness from starting; never touch any pre-existing pane.
    await this.call(["pane", "close", rootPane]);
    return { workspace, pane, agent, path };
  }

  /** A relaunch gets a fresh, sanitized pane; the old occupant stays until confirmed idle. */
  async resume(handle: HerdrClaimHandle, input: { ticket: string; secrets: string[] }): Promise<HerdrHandle> {
    const tree = await this.worktree(handle);
    const tab = object(
      (
        await this.call([
          "tab",
          "create",
          "--workspace",
          handle.workspace,
          "--cwd",
          tree.path,
          "--no-focus",
          ...credentialNames(this.io.env, input.secrets).flatMap((name) => ["--env", `${name}=`]),
          "--env",
          `ARMADA_TICKET=${input.ticket}`,
        ])
      ).result,
    );
    const pane = object(tab?.root_pane);
    if (!id(pane?.pane_id) || pane.workspace_id !== handle.workspace || pane.pane_id === handle.pane)
      throw new UsageError("invalid herdr relaunch pane response");
    const agent = `relaunch-${pane.pane_id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
    if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(agent)) throw new UsageError("invalid herdr relaunch agent name");
    return { workspace: handle.workspace, pane: pane.pane_id, agent, path: tree.path };
  }

  async closeIdlePane(handle: HerdrClaimHandle): Promise<void> {
    const state = await this.state(handle);
    if (state !== "idle" && state !== "done")
      throw new UsageError("worker resumed before pane close; retained its pane");
    await this.call(["pane", "close", handle.pane]);
  }

  /** Ask the runtime for a real checkout path, respecting its loaded worktrees.directory. */
  async setupRoot(repo: string, slug: string, secrets: string[]): Promise<{ root: string; repo: string }> {
    const result = object((await this.call(["worktree", "list", "--cwd", repo])).result);
    const source = object(result?.source);
    if (
      source?.source_checkout_path !== repo ||
      typeof source.repo_root !== "string" ||
      !source.repo_root.startsWith("/") ||
      !Array.isArray(result?.worktrees)
    )
      throw new UsageError("invalid herdr worktree list response; inspect herdr worktree list before setup");
    const branch = `armada-local-setup-${slug}`;
    const label = `Armada local setup checkout: ${slug}`;
    const found = result.worktrees.map(object).find((tree) => tree?.branch === branch);
    let path: string;
    if (found) {
      if (found.is_linked_worktree !== true || typeof found.path !== "string" || !found.path.startsWith("/"))
        throw new UsageError(
          `the setup branch ${branch} already exists outside Armada setup; leave it untouched and choose another project slug`,
        );
      path = found.path;
    } else {
      path = (await this.create({ repo, branch, base: "HEAD", ticket: "setup-local", secrets, label })).path;
    }
    const root = dirname(path);
    if (root === "/" || [...root].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
      throw new UsageError("invalid herdr worktree parent directory");
    return { root, repo: source.repo_root };
  }

  /** Reuse only our explicitly labelled setup workspace; ordinary worker panes are untouched. */
  async setupWorkspace(root: string, secrets: string[]): Promise<string> {
    const label = `Armada local setup: ${root}`;
    const workspaces = object((await this.call(["workspace", "list"])).result)?.workspaces;
    if (!Array.isArray(workspaces)) throw new UsageError("invalid herdr workspace list response");
    const matches = workspaces.map(object).filter((ws) => ws?.label === label);
    if (matches.length > 1)
      throw new UsageError("multiple local setup workspaces; inspect herdr workspace list before retrying");
    if (matches.length) {
      const workspace = matches[0]?.workspace_id;
      if (!id(workspace)) throw new UsageError("invalid herdr setup workspace response");
      return workspace;
    }
    const result = object(
      (
        await this.call([
          "workspace",
          "create",
          "--cwd",
          root,
          "--label",
          label,
          "--no-focus",
          ...credentialNames(this.io.env, secrets).flatMap((name) => ["--env", `${name}=`]),
          "--env",
          "ARMADA_TICKET=",
        ])
      ).result,
    );
    const workspace = object(result?.workspace)?.workspace_id;
    const pane = object(result?.root_pane);
    if (!id(workspace) || !id(pane?.pane_id) || pane?.workspace_id !== workspace)
      throw new UsageError("invalid herdr setup workspace response");
    this.setupShell = { workspace, pane: String(pane?.pane_id) };
    return workspace;
  }

  async setupPane(
    workspace: string,
    root: string,
    profile: HerdrProfile,
    secrets: string[],
  ): Promise<{ handle: HerdrHandle; existing: boolean }> {
    const kind = herdrHarnessKind(profile.harness);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([kind, ...harnessArgs(profile)]))
      .digest("hex")
      .slice(0, 32);
    const name = `setup-${workspace}-${kind}`;
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new UsageError("cannot name the setup agent for this workspace");
    const agents = object((await this.call(["agent", "list"])).result)?.agents;
    if (!Array.isArray(agents)) throw new UsageError("invalid herdr agent list response");
    const matches = agents.map(object).filter((agent) => agent?.name === name);
    if (matches.length > 1) throw new UsageError("multiple setup agents; inspect herdr agent list");
    if (matches.length) {
      const agent = matches[0];
      if (agent?.workspace_id !== workspace || !id(agent.pane_id) || agent.cwd !== root || agent.agent !== kind)
        throw new UsageError("setup agent identity or directory changed; inspect herdr agent list before retrying");
      if (object(agent.tokens)?.armadaSetup !== fingerprint)
        throw new UsageError(
          `the ${kind} setup session uses different launch settings; close its pane ${agent.pane_id} in herdr, then rerun armada setup local to check the current profile`,
        );
      return { handle: { workspace, pane: agent.pane_id, agent: name, path: root }, existing: true };
    }
    const result = object(
      (
        await this.call([
          "tab",
          "create",
          "--workspace",
          workspace,
          "--cwd",
          root,
          "--label",
          kind,
          "--no-focus",
          ...credentialNames(this.io.env, secrets).flatMap((key) => ["--env", `${key}=`]),
          "--env",
          "ARMADA_TICKET=",
        ])
      ).result,
    );
    const pane = object(result?.root_pane);
    if (!id(pane?.pane_id) || pane?.workspace_id !== workspace)
      throw new UsageError("invalid herdr setup pane response");
    await this.call([
      "pane",
      "report-metadata",
      pane.pane_id,
      "--source",
      "armada-setup",
      "--token",
      `armadaSetup=${fingerprint}`,
    ]);
    if (this.setupShell?.workspace === workspace) {
      await this.call(["pane", "close", this.setupShell.pane]);
      this.setupShell = null;
    }
    return { handle: { workspace, pane: pane.pane_id, agent: name, path: root }, existing: false };
  }

  async start(handle: HerdrHandle, profile: HerdrProfile, timeoutMs = 30_000, verifyModel = true): Promise<void> {
    const r = await this.call([
      "agent",
      "start",
      handle.agent,
      "--kind",
      herdrHarnessKind(profile.harness),
      "--pane",
      handle.pane,
      "--timeout",
      String(timeoutMs),
      "--",
      ...harnessArgs(profile),
    ]);
    await this.checkLaunchAgent(r, handle, profile.harness);
    if (verifyModel && herdrHarnessKind(profile.harness) === "opencode") {
      try {
        await verifyOpenCodeModel(this.io, handle.pane, profile.model);
      } catch (error) {
        // No brief has been sent yet. Close only this new worker's pane;
        // retain its workspace and worktree for inspection and recovery.
        let closed = false;
        try {
          await this.call(["pane", "close", handle.pane]);
          closed = true;
        } catch {}
        throw new UsageError(
          `${error instanceof UsageError ? error.message : "could not verify OpenCode model"}; ${
            closed ? "worker pane closed" : "could not close worker pane; close it with herdr pane close"
          }. No worker brief was sent.`,
        );
      }
    }
  }

  /** Verify the occupant of this exact pane before recovering its name or reading its screen. */
  async inspect(
    handle: HerdrClaimHandle,
    harness: HerdrHarness,
  ): Promise<{
    state: RuntimeState;
    ready: boolean;
    issue: FirstRunIssue | null;
  }> {
    const agent = await this.checkLaunchAgent(await this.call(["agent", "get", handle.pane], 5_000), handle, harness);
    const state = agent.agent_status;
    if (!["working", "blocked", "idle", "done", "unknown"].includes(String(state)))
      throw new UsageError("invalid herdr agent state");
    let text: string;
    try {
      if (!this.io.exec) throw new Error("no exec");
      const result = await this.io.exec(
        "herdr",
        ["pane", "read", handle.pane, "--source", "visible", "--lines", "80"],
        {
          cwd: this.io.cwd,
          timeoutMs: 5_000,
        },
      );
      if (result.code !== 0) throw new Error("read failed");
      text = result.stdout;
    } catch {
      throw new UsageError(`could not inspect the worker screen; run herdr agent attach ${handle.pane}`);
    }
    return {
      state: state as RuntimeState,
      ready:
        (state === "idle" || state === "done") && agent.interactive_ready !== false && agent.launch_pending !== true,
      issue: firstRunIssue(harness, text),
    };
  }

  private screenError(
    handle: HerdrClaimHandle,
    issue: FirstRunIssue | null,
    message = "The harness needs the owner's attention",
  ) {
    return new UsageError(
      `${issue?.message ?? message}: run armada setup local, or answer it with herdr agent attach ${handle.pane}`,
      `herdr agent attach ${handle.pane}`,
    );
  }

  private async checkProfileModel(handle: HerdrHandle, profile: HerdrProfile): Promise<void> {
    if (herdrHarnessKind(profile.harness) !== "opencode") return;
    try {
      await verifyOpenCodeModel(this.io, handle.pane, profile.model);
    } catch (error) {
      const screen = await this.inspect(handle, profile.harness);
      throw this.screenError(
        handle,
        screen.issue,
        error instanceof UsageError ? error.message : "Could not verify the OpenCode profile model",
      );
    }
  }

  /** A short native start followed by bounded inspection, without answering any question. */
  async startChecked(handle: HerdrHandle, profile: HerdrProfile): Promise<void> {
    try {
      // Inspect first-run screens before checking the selected model. Setup
      // retains its pane so the owner can finish provider/sign-in questions.
      await this.start(handle, profile, 3_500, false);
    } catch (error) {
      if (!(error instanceof HerdrError) || !["agent_not_ready", "timeout"].includes(error.code ?? "")) throw error;
      // Herdr keeps the named occupant on these errors; never start it again.
    }
    const now = this.io.now ?? (() => new Date());
    const deadline = now().getTime() + 30_000;
    for (let attempt = 0; attempt < 120 && now().getTime() < deadline; attempt++) {
      const screen = await this.inspect(handle, profile.harness);
      if (screen.issue || screen.state === "blocked") throw this.screenError(handle, screen.issue);
      if (screen.ready) {
        await this.checkProfileModel(handle, profile);
        return;
      }
      await (this.io.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))))(250);
    }
    throw this.screenError(handle, null, "The harness did not become ready");
  }

  async promptChecked(handle: HerdrHandle, profile: HerdrProfile, prompt: string): Promise<void> {
    const before = await this.inspect(handle, profile.harness);
    if (before.issue || !before.ready) throw this.screenError(handle, before.issue);
    await this.checkProfileModel(handle, profile);
    try {
      await this.prompt(handle, prompt);
    } catch (error) {
      // A transport timeout cannot establish whether the prompt was accepted.
      // Preserve it for the launcher; revocation could cut off a running worker.
      if (error instanceof HerdrError && error.code === "timeout") throw error;
      const screen = await this.inspect(handle, profile.harness);
      if (screen.issue || screen.state === "blocked") throw this.screenError(handle, screen.issue);
      if (error instanceof HerdrError && error.code === "agent_prompt_stalled")
        throw this.screenError(handle, null, "The harness did not accept the brief");
      throw error;
    }
  }

  /** Token-free model probe after the owner has cleared every recognised question. */
  async checkSetupModel(handle: HerdrHandle, profile: HerdrProfile): Promise<void> {
    const screen = await this.inspect(handle, profile.harness);
    if (screen.issue || !screen.ready) throw this.screenError(handle, screen.issue);
    await this.checkProfileModel(handle, profile);
    try {
      const agent = this.checkAgent(
        await this.call(
          [
            "agent",
            "prompt",
            handle.pane,
            "Reply with OK only. Do not read files, run commands or modify anything.",
            "--wait",
            "--until",
            "idle",
            "--until",
            "done",
            "--timeout",
            "10000",
          ],
          12_000,
        ),
        handle,
      );
      const after = await this.inspect(handle, profile.harness);
      if (after.issue) throw this.screenError(handle, after.issue);
      if (!["idle", "done"].includes(String(agent.agent_status)) || !after.ready)
        throw this.screenError(handle, null, "The model did not finish the setup check");
    } catch (error) {
      const after = await this.inspect(handle, profile.harness);
      if (after.issue) throw this.screenError(handle, after.issue);
      if (error instanceof UsageError && !(error instanceof HerdrError)) throw error;
      throw this.screenError(handle, null, "The model did not finish the setup check");
    }
  }

  async prompt(handle: HerdrHandle, prompt: string): Promise<void> {
    // One argv item: never an interpolated shell command, file in the repo or log.
    const r = await this.call([
      "agent",
      "prompt",
      handle.pane,
      prompt,
      "--wait",
      "--until",
      "working",
      "--timeout",
      "30000",
    ]);
    const agent = this.checkAgent(r, handle);
    if (agent.agent_status !== "working") throw new UsageError("herdr did not confirm the worker is working");
  }

  async state(handle: HerdrClaimHandle): Promise<RuntimeState> {
    return (await this.reading(handle)).state;
  }

  async reading(handle: HerdrClaimHandle): Promise<{ state: RuntimeState; sequence?: number }> {
    const agent = this.checkAgent(await this.call(["agent", "get", handle.pane], 5_000), handle);
    const state = agent.agent_status;
    if (!["working", "blocked", "idle", "done", "unknown"].includes(String(state)))
      throw new UsageError("invalid herdr agent state");
    const sequence = agent.state_change_seq;
    if (sequence !== undefined && (!Number.isSafeInteger(sequence) || Number(sequence) < 0))
      throw new UsageError("invalid herdr state-change sequence");
    return { state: state as RuntimeState, ...(sequence === undefined ? {} : { sequence: Number(sequence) }) };
  }

  async message(handle: HerdrClaimHandle, text: string): Promise<void> {
    const state = await this.state(handle);
    // Herdr deliberately refuses agent prompt while blocked. pane run submits
    // literal text plus Enter using the terminal's bracketed-paste mode.
    if (state === "blocked") await this.call(["pane", "run", handle.pane, text]);
    else this.checkAgent(await this.call(["agent", "prompt", handle.pane, text]), handle);
  }

  async quiesce(handle: HerdrClaimHandle, waitMs = 5000): Promise<void> {
    const state = await this.state(handle);
    if (state === "idle" || state === "done") return;
    if (state === "unknown") throw new UsageError("cannot stop an unverified active turn; wait for herdr idle state");
    await this.call(["agent", "send-keys", handle.pane, "ctrl+c"], 5_000);
    const agent = this.checkAgent(
      await this.call(
        ["agent", "wait", handle.pane, "--until", "idle", "--until", "done", "--timeout", String(waitMs)],
        waitMs + 2000,
      ),
      handle,
    );
    if (agent.agent_status !== "idle" && agent.agent_status !== "done")
      throw new UsageError("worker is still active; its worktree was retained");
  }

  async report(pane: string, agent: string, state: RuntimeState, heartbeat = false): Promise<void> {
    if (agent === "armada" || heartbeat) {
      const current = object(object((await this.call(["pane", "get", pane], 5_000)).result)?.pane);
      if (current?.pane_id !== pane) throw new UsageError("invalid herdr pane response");
      if (agent === "armada" && typeof current.agent === "string" && current.agent) agent = current.agent;
      // A liveness ping must not overwrite a newly detected harness approval.
      if (heartbeat && state === "working" && current.agent_status === "blocked") state = "blocked";
    }
    if (agent === "deepseek" || agent === herdrHarnessLabel("deepseek")) agent = herdrHarnessKind("deepseek");
    await this.call(["pane", "report-agent", pane, "--source", "armada", "--agent", agent, "--state", state], 5_000);
  }

  async worktree(handle: HerdrClaimHandle): Promise<{ repo: string; path: string }> {
    const ws = object(object((await this.call(["workspace", "get", handle.workspace], 5_000)).result)?.workspace);
    const tree = object(ws?.worktree);
    if (
      ws?.workspace_id !== handle.workspace ||
      tree?.is_linked_worktree !== true ||
      typeof tree.repo_root !== "string" ||
      !tree.repo_root.startsWith("/") ||
      typeof tree.checkout_path !== "string" ||
      !tree.checkout_path.startsWith("/") ||
      tree.repo_root === tree.checkout_path
    )
      throw new UsageError("herdr workspace is not a verified linked worktree; left it untouched");
    return { repo: tree.repo_root, path: tree.checkout_path };
  }

  async remove(handle: HerdrClaimHandle, path: string): Promise<void> {
    const result = object((await this.call(["worktree", "remove", "--workspace", handle.workspace])).result);
    if (result?.workspace_id !== handle.workspace || result?.path !== path || result?.forced !== false)
      throw new UsageError("invalid herdr worktree removal response; inspect herdr worktree list before retrying");
  }

  private async checkLaunchAgent(reply: Record<string, unknown>, handle: HerdrClaimHandle, harness: HerdrHarness) {
    const kind = herdrHarnessKind(harness);
    const occupant = object(object(reply.result)?.agent);
    // Herdr can clear the alias when startup detection re-registers a harness.
    // Recover only a missing alias on the expected occupant of our exact pane.
    if (
      occupant &&
      (occupant.name === null || occupant.name === undefined) &&
      occupant.agent === kind &&
      occupant.pane_id === handle.pane &&
      occupant.workspace_id === handle.workspace
    )
      reply = await this.call(["agent", "rename", handle.pane, handle.agent], 5_000);
    const agent = this.checkAgent(reply, handle);
    if (agent.agent !== kind)
      throw new UsageError("herdr worker harness changed; inspect herdr agent list before retrying");
    return agent;
  }

  private checkAgent(reply: Record<string, unknown>, handle: HerdrClaimHandle) {
    const agent = object(object(reply.result)?.agent);
    if (
      !agent ||
      agent.name !== handle.agent ||
      agent.pane_id !== handle.pane ||
      agent.workspace_id !== handle.workspace
    )
      throw new UsageError("invalid herdr agent response; inspect herdr agent list before retrying");
    return agent;
  }
}
