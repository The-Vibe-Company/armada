// Herdr's JSON CLI is the runtime boundary. Never surface arbitrary CLI output:
// agent prompt may include a one-time launch token in its arguments or errors.
import type { HerdrProfile } from "@armada/core";
import { type Io, UsageError } from "./io.ts";

export interface HerdrHandle {
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
const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(v);

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
      reply = object(JSON.parse(out.stdout || out.stderr));
    } catch {
      throw new UsageError(`herdr ${operation} failed; inspect the runtime with herdr agent list`);
    }
    const error = object(reply?.error);
    if (code !== 0 || error) {
      const reason = typeof error?.code === "string" && /^[a-z_]{1,64}$/.test(error.code) ? ` (${error.code})` : "";
      throw new UsageError(`herdr ${operation} failed${reason}; inspect the runtime with herdr agent list`);
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

  private checkAgent(reply: Record<string, unknown>, handle: HerdrHandle) {
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
