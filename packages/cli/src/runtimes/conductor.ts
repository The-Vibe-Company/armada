// Conductor JSON is an untrusted boundary. Never include its stdout/stderr in errors.
import { type ClaimRef, conductorSessionState, RuntimeError, type RuntimeErrorCode } from "@armada/core";
import { BUNDLED_CONDUCTOR, CONDUCTOR_INSTALL_FIX } from "../doctor.ts";
import type { ExecResult, Io } from "../io.ts";
import {
  type Archived,
  type ArchiveOptions,
  checkedMutation,
  type Delivery,
  type Launched,
  type LaunchRecovery,
  type LaunchSpec,
  type OutgoingMessage,
  type Peek,
  type PreflightCheck,
  type PreflightInput,
  type RuntimeAdapter,
  type RuntimeReading,
  redactRuntimeText,
} from "./adapter.ts";

const object = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(v) && redactRuntimeText(v) === v;
const invalid = () => new RuntimeError("Conductor returned an invalid response", "invalid", "conductor --help");
const safeLink = (v: unknown): string | null => {
  if (
    typeof v !== "string" ||
    [...v].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127) ||
    redactRuntimeText(v) !== v
  )
    return null;
  try {
    return new URL(v).protocol === "conductor:" ? v : null;
  } catch {
    return null;
  }
};
const timestamp = (v: unknown): string | null =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

/** The same argv is used by native launch and its read-only plan. */
export function conductorLaunchArguments(spec: LaunchSpec): string[] {
  const p = spec.profile;
  const base = spec.from.kind === "branch" ? spec.branch : spec.base;
  return [
    "workspace",
    "create",
    ...(spec.projectId ? ["--project-id", spec.projectId] : ["--repo-url", `https://github.com/${spec.repository}`]),
    "--branch",
    base,
    "--name",
    `${spec.ticket} ${spec.title.slice(0, 60)}`,
    "--session-name",
    spec.ticket,
    "--agent",
    p.agent,
    "--model",
    p.model,
    "--effort",
    p.effort,
    ...(p.fastMode ? ["--fast-mode"] : []),
    "--message-file",
    "-",
    "--env",
    `ARMADA_TICKET=${spec.ticket}`,
  ];
}

export class ConductorAdapter implements RuntimeAdapter {
  readonly name = "conductor";
  readonly guide = "armada-runtime-conductor";
  readonly can = {
    launch: true,
    resumeInPlace: true,
    deliver: true,
    observe: true,
    peek: true,
    cancel: true,
    archive: true,
  };
  private binary = "conductor";
  constructor(
    private readonly io: Io,
    private readonly secretValues: readonly string[] = [],
  ) {}
  parse(handle: string): { workspace: string; session: string } {
    const parts = handle.split("/");
    if (parts.length !== 2 || !id(parts[0]) || !id(parts[1]))
      throw new RuntimeError("invalid Conductor handle; expected workspace/session ids", "invalid", "armada status");
    return { workspace: parts[0], session: parts[1] };
  }
  private redact(text: string): string {
    return redactRuntimeText(text, this.secretValues);
  }
  private error(code: RuntimeErrorCode): RuntimeError {
    const sentences: Record<RuntimeErrorCode, string> = {
      unsupported: "Conductor cannot perform this operation",
      "not-found": "this terminal's Conductor sign-in cannot see the worker",
      gone: "the Conductor workspace is archived",
      mismatch: "Conductor session does not match the claimed workspace",
      stale: "the worker claim changed; left Conductor untouched",
      busy: "Conductor worker is still working; left its workspace untouched",
      dirty: "worker has remaining work",
      auth: "Conductor is not signed in",
      unavailable: "Conductor is unavailable",
      "unknown-outcome": "Conductor request timed out; inspect the session before retrying",
      invalid: "Conductor returned an invalid response",
    };
    return new RuntimeError(
      sentences[code],
      code,
      code === "auth" || code === "not-found" ? "conductor auth whoami" : "use the armada-runtime-conductor guide",
    );
  }
  private async exec(args: string[], input?: string, mutation = false, timeoutMs = 10_000): Promise<ExecResult> {
    if (!this.io.exec)
      throw new RuntimeError("Conductor CLI execution is unavailable on this machine", "unavailable", "armada doctor");
    const operation = args.slice(0, 2).join(" ");
    let r: ExecResult;
    try {
      r = await this.io.exec(this.binary, ["--json", ...args], {
        cwd: this.io.cwd,
        timeoutMs: mutation ? (args[0] === "workspace" && args[1] === "create" ? 120_000 : 60_000) : timeoutMs,
        maxOutputBytes: 2_000_000,
        input,
      });
    } catch (e) {
      if (
        this.binary === "conductor" &&
        this.io.platform === "darwin" &&
        (e as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        this.binary = BUNDLED_CONDUCTOR;
        return this.exec(args, input, mutation, timeoutMs);
      }
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        throw new RuntimeError("Conductor CLI is missing", "unavailable", CONDUCTOR_INSTALL_FIX);
      if (mutation) throw this.error("unknown-outcome");
      throw new RuntimeError(
        (e as NodeJS.ErrnoException).code === "EACCES"
          ? "Conductor CLI cannot be executed: permission denied"
          : `Conductor CLI could not execute ${operation}`,
        "unavailable",
        "armada doctor",
      );
    }
    if (r.timedOut)
      throw mutation
        ? this.error("unknown-outcome")
        : new RuntimeError(
            `Conductor ${operation} timed out after ${timeoutMs} ms`,
            "unavailable",
            "retry once Conductor answers",
          );
    if (r.outputExceeded)
      throw mutation
        ? this.error("unknown-outcome")
        : new RuntimeError(
            `Conductor ${operation} exceeded the 2000000-byte output limit`,
            "unavailable",
            "use the armada-runtime-conductor guide",
          );
    if (r.code !== 0) {
      const code =
        r.code === 3
          ? "auth"
          : r.code === 4
            ? "unavailable"
            : r.code === 1 && args[1] === "create"
              ? "unknown-outcome"
              : r.code === 2
                ? "invalid"
                : r.code === 1 && ["status", "message"].includes(args[1] ?? "")
                  ? "not-found"
                  : "unavailable";
      if (code === "unknown-outcome")
        throw new RuntimeError(
          "Conductor create failed without confirming whether a worker was created",
          code,
          "conductor model",
        );
      if (code === "unavailable" && !mutation)
        throw new RuntimeError(
          `Conductor ${r.code === 4 ? "server error" : "CLI failed"} during ${operation} (exit ${r.code})`,
          code,
          "use the armada-runtime-conductor guide",
        );
      throw this.error(code);
    }
    return r;
  }
  private async call(
    args: string[],
    input?: string,
    mutation = false,
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    const r = await this.exec(args, input, mutation, timeoutMs);
    try {
      const value = object(JSON.parse(r.stdout));
      if (!value) throw invalid();
      return value;
    } catch {
      throw mutation ? this.error("unknown-outcome") : invalid();
    }
  }
  async preflight(input: PreflightInput): Promise<PreflightCheck[]> {
    const checks: PreflightCheck[] = [];
    try {
      const rawVersion = (await this.exec(["--version"])).stdout.trim();
      const version = rawVersion.match(/^(\d+\.\d+\.\d+)(?:[-+][\w.-]+)?$/)?.[1];
      if (!version) throw invalid();
      checks.push({ level: "ok", message: `Conductor ${version} is available`, fix: null });
      await this.exec(["auth", "whoami"]);
      checks.push({ level: "ok", message: "Conductor is signed in", fix: null });
      const catalog = await this.call(["model"]);
      if (!Array.isArray(catalog.agents)) throw invalid();
      const p = input.profile;
      const agent = catalog.agents.map(object).find((a) => a?.agent === p.agent);
      if (
        !agent ||
        !Array.isArray(agent.models) ||
        !agent.models.includes(p.model) ||
        !Array.isArray(agent.efforts) ||
        !agent.efforts.includes(p.effort) ||
        (p.fastMode && (!Array.isArray(agent.fastModeModels) || !agent.fastModeModels.includes(p.model)))
      )
        throw new RuntimeError(
          "Conductor does not know this profile's agent, model, effort or fast mode",
          "invalid",
          "conductor model",
        );
      checks.push({ level: "ok", message: "Conductor profile is available", fix: null });
    } catch (e) {
      const error = e instanceof RuntimeError ? e : this.error("unavailable");
      checks.push({ level: "error", message: error.message, fix: error.next });
    }
    return checks;
  }
  private profile(spec: LaunchSpec): string[] {
    const p = spec.profile;
    return ["--agent", p.agent, "--model", p.model, "--effort", p.effort, ...(p.fastMode ? ["--fast-mode"] : [])];
  }
  async launch(spec: LaunchSpec): Promise<Launched> {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(spec.repository) ||
      !/^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/.test(spec.ticket)
    )
      throw invalid();
    if (
      Object.keys(spec.env).some((k) => k !== "ARMADA_TICKET") ||
      (spec.env.ARMADA_TICKET !== undefined && spec.env.ARMADA_TICKET !== spec.ticket)
    )
      throw invalid();
    let result: Record<string, unknown>;
    let workspace: string;
    if (spec.from.kind === "in-place") {
      const previous = spec.from.previous;
      if (!previous.releasedAt)
        throw new RuntimeError("release the previous worker before relaunching", "busy", "armada release");
      workspace = this.parse(previous.handle).workspace;
      result = await checkedMutation(
        previous,
        async () => {
          await this.session(previous);
          const ws = await this.workspace(workspace);
          if (ws.status !== "ready") throw this.error(ws.status === "archived" ? "gone" : "busy");
        },
        () =>
          this.call(
            [
              "session",
              "create",
              "--workspace",
              workspace,
              "--name",
              `${spec.ticket} (relaunch)`,
              ...this.profile(spec),
              "--message-file",
              "-",
            ],
            spec.prompt,
            true,
          ),
      );
    } else {
      const base = spec.from.kind === "branch" ? spec.branch : spec.base;
      if (!base || base.startsWith("-") || [...base].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
        throw invalid();
      if (spec.projectId && !id(spec.projectId)) throw invalid();
      result = await this.call(conductorLaunchArguments(spec), spec.prompt, true);
      if (!id(result.workspaceId)) throw this.error("unknown-outcome");
      workspace = result.workspaceId;
    }
    const session = spec.from.kind === "in-place" ? result.id : result.sessionId;
    if (!id(session)) throw this.error("unknown-outcome");
    const acknowledgement = object(result.initialMessage);
    if (
      !acknowledgement ||
      !id(acknowledgement.messageId) ||
      !["sent", "queued"].includes(String(acknowledgement.state))
    )
      throw new RuntimeError(
        "Conductor created the worker but did not confirm its initial message; do not launch it again",
        "unknown-outcome",
        `inspect ${workspace}/${session} with the armada-runtime-conductor guide and resume that session`,
      );
    return {
      handle: `${workspace}/${session}`,
      link: safeLink(result.deepLink),
      path: null,
      state: "idle",
    };
  }
  async recoverLaunch(spec: LaunchSpec, since: string): Promise<LaunchRecovery> {
    if (!timestamp(since)) throw invalid();
    // Names may change while create's response is in flight. Search stable repository/creation facts.
    const r = await this.call([
      "workspace",
      "list",
      "--mine",
      "--repo",
      spec.repository,
      "--since",
      since,
      "--limit",
      "10",
    ]);
    if (!Array.isArray(r.data) || typeof r.hasMore !== "boolean") throw invalid();
    const workers: Launched[] = [];
    const candidates: string[] = [];
    let complete = !r.hasMore;
    for (const value of r.data) {
      const w = object(value);
      if (!w || !id(w.id) || typeof w.repoUrl !== "string" || !timestamp(w.createdAt)) throw invalid();
      // --since filters activity, not creation. Older workspaces are not candidates for this create.
      if (
        Date.parse(String(w.createdAt)) < Date.parse(since) ||
        w.repoUrl
          .replace(/\.git$/, "")
          .replace(/\/$/, "")
          .toLowerCase() !== `https://github.com/${spec.repository}`.toLowerCase() ||
        w.state === "archived"
      )
        continue;
      candidates.push(w.id);
      let sessions: Record<string, unknown>;
      try {
        sessions = await this.call(["workspace", "session", w.id, "--limit", "10"]);
      } catch {
        complete = false;
        continue;
      }
      if (!Array.isArray(sessions.data) || typeof sessions.hasMore !== "boolean") {
        complete = false;
        continue;
      }
      const visible = sessions.data.map(object);
      if (visible.some((s) => !s || !id(s.id))) {
        complete = false;
        continue;
      }
      if (visible.length) {
        candidates.pop();
        candidates.push(...visible.map((s) => `${w.id}/${s?.id}`));
      }
      if (sessions.hasMore || visible.length !== 1) {
        complete = false;
        continue;
      }
      const session = visible[0];
      if (!session || !id(session.id)) {
        complete = false;
        continue;
      }
      // Repository/time finds renamed candidates too, but cannot prove which ticket created them.
      // Only matching requested names can be adopted automatically; retain all others for inspection.
      if (w.name !== `${spec.ticket} ${spec.title.slice(0, 60)}` || session.name !== spec.ticket) {
        complete = false;
        continue;
      }
      const handle = `${w.id}/${session.id}`;
      let status: Record<string, unknown>;
      try {
        status = await this.session({
          ticket: spec.ticket,
          runtime: "conductor",
          handle,
          claimedAt: null,
          releasedAt: null,
          launchId: null,
        });
      } catch {
        complete = false;
        continue;
      }
      workers.push({
        handle,
        link: safeLink(session.deepLink) ?? safeLink(w.deepLink),
        path: null,
        state: conductorSessionState(String(status.status)),
      });
    }
    return { workers, candidates: [...new Set(candidates)], complete };
  }
  private async session(target: ClaimRef, timeoutMs = 10_000) {
    const h = this.parse(target.handle);
    const result = await this.call(["session", "status", h.session], undefined, false, timeoutMs);
    if (!id(result.sessionId) || !id(result.workspaceId) || typeof result.status !== "string") throw invalid();
    if (result.sessionId !== h.session || result.workspaceId !== h.workspace) throw this.error("mismatch");
    return result;
  }
  private async workspace(workspace: string, timeoutMs = 10_000) {
    const result = await this.call(["workspace", "status", workspace], undefined, false, timeoutMs);
    if (!id(result.workspaceId) || typeof result.status !== "string") throw invalid();
    if (result.workspaceId !== workspace)
      throw new RuntimeError("Conductor workspace does not match the requested worker", "mismatch", "armada status");
    return result;
  }
  async deliver(target: ClaimRef, message: OutgoingMessage): Promise<Delivery> {
    const h = this.parse(target.handle);
    if (!id(message.key)) throw invalid();
    if (target.releasedAt) throw this.error("gone");
    const result = await checkedMutation(
      target,
      async () => {
        await this.session(target);
        if ((await this.workspace(h.workspace)).status === "archived")
          throw new RuntimeError(
            "the Conductor workspace is archived; no answer was delivered",
            "gone",
            `relaunch: armada relaunch ${target.ticket}`,
          );
      },
      () =>
        this.call(
          ["message", "create", "--session", h.session, "--message-file", "-", "--message-id", message.key],
          message.text,
          true,
        ),
    );
    if (!id(result.messageId) || !["sent", "queued"].includes(String(result.state))) throw invalid();
    return { via: "conductor", messageId: result.messageId, queued: result.state === "queued" };
  }
  async observe(target: ClaimRef): Promise<RuntimeReading> {
    const h = this.parse(target.handle);
    // Status reads authenticate themselves. An unrelated identity probe must not hide a readable worker.
    // The workspace remains readable even when its archived session is no longer available.
    const ws = await this.workspace(h.workspace, 5000);
    if (ws.status === "archived") return { state: "gone", detail: "archived", since: timestamp(ws.updatedAt) };
    const session = await this.session(target, 5000);
    return {
      state: conductorSessionState(String(session.status)),
      detail: String(session.status),
      since: timestamp(session.updatedAt),
    };
  }
  async peek(target: ClaimRef, options: { actions: number; cursor: string | null }): Promise<Peek> {
    if (
      !Number.isSafeInteger(options.actions) ||
      options.actions < 0 ||
      options.actions > 1000 ||
      (options.cursor !== null && !id(options.cursor))
    )
      throw invalid();
    const reading = await this.observe(target);
    const h = this.parse(target.handle);
    const actions: Peek["actions"] = [];
    let lastReply: Peek["lastReply"] = null;
    let cursor = options.cursor;
    let hasMore = false;
    let knownFormat = false;
    let unknownReply: Peek["lastReply"] = null;
    const tools = new Map<string, Peek["actions"][number]>();
    const actionResults: NonNullable<Peek["actionResults"]> = [];
    for (let page = 0; page < 20; page++) {
      const r = await this.call([
        "session",
        "message",
        h.session,
        ...(cursor ? ["--after", cursor] : []),
        "--limit",
        "100",
      ]);
      if (!Array.isArray(r.data) || r.data.length > 100 || typeof r.hasMore !== "boolean") throw invalid();
      const old = cursor;
      for (const value of r.data) {
        const event = object(value);
        if (!event || !id(event.id)) throw invalid();
        cursor = event.id;
        const at = timestamp(event.receivedAt);
        const raw = object(object(event.content)?.rawPayload);
        const content = object(event.content);
        if (typeof content?.text === "string") unknownReply = { at, text: this.redact(content.text) };
        if (!raw) continue;
        if (typeof raw.text === "string") unknownReply = { at, text: this.redact(raw.text) };
        const messageContent = object(raw.message)?.content;
        const messageText =
          typeof messageContent === "string"
            ? messageContent
            : Array.isArray(messageContent)
              ? messageContent
                  .map(object)
                  .filter((block) => block?.type === "text" && typeof block.text === "string")
                  .map((block) => String(block?.text))
                  .join("\n")
              : "";
        if (messageText) {
          const reply = { at, text: this.redact(messageText) };
          unknownReply = reply;
          if (raw.type === "assistant") lastReply = reply;
        }
        if (
          ["result", "assistant", "user"].includes(String(raw.type)) ||
          String(object(raw.event)?.type).startsWith("item.")
        )
          knownFormat = true;
        if (raw.type === "user") {
          const content = object(raw.message)?.content;
          if (Array.isArray(content))
            for (const value of content) {
              const result = object(value);
              const action = typeof result?.tool_use_id === "string" ? tools.get(result.tool_use_id) : null;
              if (result?.type === "tool_result" && id(result.tool_use_id)) {
                const code =
                  typeof result.content === "string"
                    ? result.content.match(/(?:Exit code|exit code|exited with code)[: ]+(\d+)/)?.[1]
                    : null;
                const exit = code ? Number(code) : result.is_error === true ? 1 : null;
                if (action) action.exit = exit;
                actionResults.push({ id: result.tool_use_id, exit });
                if (actionResults.length > options.actions) actionResults.shift();
              }
            }
        }
        if (raw.type === "result" && typeof raw.result === "string") lastReply = { at, text: this.redact(raw.result) };
        if (raw.type === "assistant") {
          const content = object(raw.message)?.content;
          if (Array.isArray(content))
            for (const value of content) {
              const tool = object(value);
              if (tool?.type === "tool_use") {
                const command = object(tool.input)?.command;
                const action: Peek["actions"][number] = {
                  ...(id(tool.id) ? { id: tool.id } : {}),
                  at,
                  kind: typeof command === "string" ? "command" : "tool",
                  text: this.redact(typeof command === "string" ? command : String(tool.name ?? "tool")),
                  exit: null,
                };
                actions.push(action);
                if (typeof tool.id === "string") tools.set(tool.id, action);
              }
            }
        }
        const codex = object(raw.event);
        const item = object(codex?.item);
        if (codex?.type !== "item.completed" || !item) continue;
        if (item.type === "agentMessage" && typeof item.text === "string") {
          lastReply = { at, text: this.redact(item.text) };
        } else if (item.type === "commandExecution" && typeof item.command === "string")
          actions.push({
            at,
            kind: "command",
            text: this.redact(item.command),
            exit: typeof item.exitCode === "number" ? item.exitCode : null,
          });
        else if (item.type === "mcpToolCall")
          actions.push({ at, kind: "tool", text: this.redact(`${item.server ?? ""} ${item.tool ?? ""}`.trim()) });
        if (actions.length > options.actions) actions.splice(0, actions.length - options.actions);
      }
      if (actions.length > options.actions) actions.splice(0, actions.length - options.actions);
      hasMore = r.hasMore;
      if (!hasMore) break;
      if (!cursor || old === cursor) throw invalid();
    }
    return {
      ...reading,
      detail: !knownFormat && unknownReply ? `${reading.detail} · unknown agent format` : reading.detail,
      link: `conductor://workspace?id=${h.workspace}`,
      lastReply: lastReply ?? (!knownFormat ? unknownReply : null),
      actions: knownFormat ? actions : [],
      actionResults,
      cursor,
      truncated: hasMore,
    };
  }
  private waitBound(ms: number) {
    if (!Number.isFinite(ms) || ms < 0 || ms > 600_000) throw invalid();
  }
  private async sleep(ms: number) {
    await (this.io.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms))))(ms);
  }
  private now() {
    return (this.io.now ?? (() => new Date()))().getTime();
  }
  async cancel(target: ClaimRef, options: { waitMs: number }) {
    this.waitBound(options.waitMs);
    const h = this.parse(target.handle);
    const before = await this.session(target);
    if (before.status !== "working") return { wasWorking: false, state: conductorSessionState(String(before.status)) };
    await checkedMutation(
      target,
      () => this.session(target),
      () => this.call(["session", "cancel", h.session], undefined, true),
    );
    const deadline = this.now() + options.waitMs;
    for (let attempt = 0; attempt <= Math.ceil(options.waitMs / 2000); attempt++) {
      const r = await this.session(target);
      if (r.status === "idle") return { wasWorking: true, state: "idle" as const };
      if (this.now() >= deadline) break;
      await this.sleep(Math.min(2000, Math.max(0, deadline - this.now())));
    }
    throw this.error("busy");
  }
  async archive(target: ClaimRef, options: ArchiveOptions): Promise<Archived> {
    this.waitBound(options.waitMs);
    if (!target.releasedAt)
      throw new RuntimeError(
        `cannot archive ${target.ticket} while it holds the ticket; release first`,
        "busy",
        `armada release --ticket ${target.ticket} --reason "<why>"`,
      );
    const h = this.parse(target.handle);
    if ((await this.workspace(h.workspace)).status === "archived")
      return { archived: false, alreadyGone: true, path: null };
    let r = await this.session(target);
    const deadline = this.now() + options.waitMs;
    if (r.status === "working" && options.whenWorking === "refuse") throw this.error("busy");
    if (options.whenWorking === "wait")
      for (let n = 0; r.status === "working" && n < Math.ceil(options.waitMs / 15_000) && this.now() < deadline; n++) {
        await this.sleep(Math.min(15_000, deadline - this.now()));
        r = await this.session(target);
      }
    if (r.status === "working") await this.cancel(target, { waitMs: 10_000 });
    const result = await checkedMutation(
      target,
      async () => {
        const session = await this.session(target);
        if (session.status === "working" || conductorSessionState(String(session.status)) === "unknown")
          throw this.error("busy");
      },
      () =>
        this.call(
          options.reason === "relaunched" ? ["session", "archive", h.session] : ["workspace", "archive", h.workspace],
          undefined,
          true,
        ),
    );
    if (result.status !== "archived") throw invalid();
    return { archived: true, alreadyGone: false, path: null };
  }
}
