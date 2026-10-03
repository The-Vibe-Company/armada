// Herdr's JSON CLI is the runtime boundary. Never surface arbitrary CLI output:
// agent prompt may include a one-time launch token in its arguments or errors.
import type { HerdrProfile, RuntimeState } from "@armada/core";
import { type Io, UsageError } from "./io.ts";

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
  p.harness === "opencode" ? `${p.model.split("#")[0]}#${p.effort}` : p.model,
  ...(p.harness === "codex"
    ? ["-c", `model_reasoning_effort=${JSON.stringify(p.effort)}`]
    : p.harness === "claude"
      ? ["--effort", p.effort]
      : []),
  ...p.extraArgs,
];

const object = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(v);

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
  constructor(private readonly io: Io) {}

  private async call(args: string[], timeoutMs = 40_000): Promise<Record<string, unknown>> {
    const operation = args.slice(0, 2).join(" ");
    let reply: Record<string, unknown> | null;
    let code: number;
    try {
      if (!this.io.exec) throw new Error("no exec");
      const out = await this.io.exec("herdr", args, { cwd: this.io.cwd, timeoutMs });
      code = out.code;
      // Herdr's terminal writes acknowledge success with no output by default.
      // Only these operations may omit JSON; reads and topology stay strict.
      if (
        code === 0 &&
        !out.stdout.trim() &&
        !out.stderr.trim() &&
        ["pane run", "pane report-agent"].includes(operation)
      )
        return {};
      reply = object(JSON.parse(out.stdout || out.stderr));
    } catch {
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

  async create(input: {
    repo: string;
    branch: string;
    base: string;
    ticket: string;
    secrets?: string[];
  }): Promise<HerdrHandle> {
    const agent = input.ticket.toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agent)) throw new UsageError("ticket cannot be used as a herdr agent name");
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
          "--no-focus",
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

  async start(handle: HerdrHandle, profile: HerdrProfile): Promise<void> {
    const r = await this.call([
      "agent",
      "start",
      handle.agent,
      "--kind",
      profile.harness,
      "--pane",
      handle.pane,
      "--timeout",
      "30000",
      "--",
      ...harnessArgs(profile),
    ]);
    this.checkAgent(r, handle);
  }

  async prompt(handle: HerdrHandle, prompt: string): Promise<void> {
    // One argv item: never an interpolated shell command, file in the repo or log.
    const r = await this.call([
      "agent",
      "prompt",
      handle.agent,
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
    const agent = this.checkAgent(await this.call(["agent", "get", handle.pane], 5_000), handle);
    const state = agent.agent_status;
    if (!["working", "blocked", "idle", "done", "unknown"].includes(String(state)))
      throw new UsageError("invalid herdr agent state");
    return state as RuntimeState;
  }

  async message(handle: HerdrClaimHandle, text: string): Promise<void> {
    const state = await this.state(handle);
    // Herdr deliberately refuses agent prompt while blocked. pane run submits
    // literal text plus Enter using the terminal's bracketed-paste mode.
    if (state === "blocked") await this.call(["pane", "run", handle.pane, text]);
    else this.checkAgent(await this.call(["agent", "prompt", handle.pane, text]), handle);
  }

  async quiesce(handle: HerdrClaimHandle): Promise<void> {
    const state = await this.state(handle);
    if (state === "idle" || state === "done") return;
    if (state === "unknown") throw new UsageError("cannot stop an unverified active turn; wait for herdr idle state");
    await this.call(["agent", "send-keys", handle.pane, "ctrl+c"], 5_000);
    const agent = this.checkAgent(
      await this.call(["agent", "wait", handle.pane, "--until", "idle", "--until", "done", "--timeout", "5000"], 7_000),
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
