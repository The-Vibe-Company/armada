import { createHash, timingSafeEqual } from "node:crypto";
import type { ExecRequest, ExecResult, Harness } from "@armada/core";
import { HARNESSES, validateReadableVariables } from "@armada/core";
import { PRIVATE_SKILL_FAILURES } from "../../core/src/private-skill-error.ts";
import { ChildOwner } from "./children.ts";
import { validateHarnessCwd } from "./cwd.ts";
import { HarnessError } from "./errors.ts";
import { execCredentialValues, validateExecEnvironment, validateExecReadables } from "./exec-env.ts";
import { checkpointIdentityKey } from "./identity.ts";
import type { Journal } from "./journal.ts";
import { mcpDigest, mcpSecretValues, validateMcpConfiguration } from "./mcp.ts";
import { NativeEpoch } from "./native-epoch.ts";
import { groupState, type ProcessIdentity, processIdentity } from "./processes.ts";
import {
  AUTH_HEADER,
  type ConfigureMcpResult,
  type Driver,
  type Grant,
  type IngestClient,
  type McpConfiguration,
  type RunnerExecutionOptions,
  type RunnerRequest,
  type StoredPrompt,
  type Turn,
} from "./protocol.ts";
import { sampleVmResources } from "./resource-sampler.ts";
import { installRuntimeSkills } from "./skills.ts";
import { executeWorkspace, validateWorkspaceExec } from "./workspace-exec.ts";
export class Runner {
  private execChildren = new ChildOwner();
  private execReleases = new Set<Promise<void>>();
  private closing = false;
  private active = new Map<
    string,
    { turn: Turn; done: Promise<void>; controller: AbortController; prompt: StoredPrompt; terminal: boolean }
  >();
  private barrier = false;
  private installingSkills = false;
  private preparingWorkspace = false;
  private mcp: McpConfiguration | undefined;
  private nativeEpoch: NativeEpoch;
  private execEnvironment: Readonly<Record<string, string>>;
  private credentialFreeBuilder: boolean;
  private exclusiveNativeAuth = false;
  private publishNativeAuth: (() => Promise<void>) | undefined;
  private refreshNativeSecrets: (() => void) | undefined;
  private commands = new Set<Promise<unknown>>();
  private resumingNative = false;
  private readableDigests = new Map<string, string>();
  private configureGitHub: RunnerExecutionOptions["configureGitHub"];
  constructor(
    readonly journal: Journal,
    readonly grant: Grant,
    readonly drivers: Partial<Record<Harness, Driver>>,
    private ingest?: IngestClient,
    mcp?: McpConfiguration,
    private stripTransientAuth?: () => Promise<void>,
    private readonly execution: RunnerExecutionOptions = {},
  ) {
    if (
      !grant.token ||
      grant.token.length < 16 ||
      !grant.sandboxId ||
      !grant.generation ||
      !Number.isFinite(grant.expiresAt)
    )
      throw Error("invalid_runner_grant");
    if (execution.credentialFreeBuilder !== undefined && typeof execution.credentialFreeBuilder !== "boolean")
      throw Error("invalid_exec_environment");
    this.credentialFreeBuilder = execution.credentialFreeBuilder ?? false;
    this.configureGitHub = execution.configureGitHub;
    this.refreshNativeSecrets = execution.refreshNativeSecrets;
    this.publishNativeAuth = execution.publishNativeAuth;
    this.exclusiveNativeAuth = execution.exclusiveNativeAuth ?? false;
    const execEnv = validateExecEnvironment(execution.execEnv, this.credentialFreeBuilder);
    journal.registerSecrets(execCredentialValues(execEnv));
    this.execEnvironment = Object.freeze({
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      GIT_TERMINAL_PROMPT: "0",
      ...validateExecReadables(execution.readableVariables, this.credentialFreeBuilder),
      ...execEnv,
      ...(execution.ghConfigDir ? { GH_CONFIG_DIR: execution.ghConfigDir } : {}),
    });
    journal.assertRestoreSource(grant);
    this.barrier = journal.checkpointPending(grant);
    journal.bindIdentity(grant);
    this.nativeEpoch = new NativeEpoch(
      grant.generation,
      journal,
      checkpointIdentityKey(grant),
      () =>
        this.active.size === 0 &&
        this.commands.size === 0 &&
        !this.resumingNative &&
        !this.barrier &&
        !this.journal.checkpointPending(this.grant),
      () => this.mcp,
      (configuration) => {
        this.configureMcp(configuration, true);
      },
    );
    if (mcp) this.configureMcp(mcp);
    for (const row of journal.db.query("SELECT pid,body FROM processes").all() as { pid: number; body: string }[]) {
      const state = JSON.parse(row.body);
      if (state.status === "running" || state.status === "running_after_restart")
        journal.db.query("UPDATE processes SET body=? WHERE pid=?").run(
          JSON.stringify({
            ...state,
            status: groupState(row.pid, state.identity) === "live" ? "running_after_restart" : "unknown_after_restart",
          }),
          row.pid,
        );
    }
    for (const p of journal.prompts())
      if (p.status === "running" || p.status === "queued")
        journal.transition(p, "failed", "runner_restarted_outcome_unknown");
  }
  /** Dial-out has no independent process lifetime: only bounded synchronous commands may run. */
  handleDialout(request: RunnerRequest, signal?: AbortSignal): Promise<Response> {
    if (
      request.op === "exec" &&
      (!request.input ||
        request.input.detached ||
        typeof request.input.command !== "string" ||
        !request.input.command.trim() ||
        Buffer.byteLength(request.input.command) > 262144 ||
        (request.input.timeoutSeconds !== undefined &&
          (!Number.isInteger(request.input.timeoutSeconds) ||
            request.input.timeoutSeconds < 1 ||
            request.input.timeoutSeconds > 600)))
    )
      return Promise.resolve(
        Response.json({ version: 1, requestId: request.requestId, error: "invalid_request" }, { status: 400 }),
      );
    return this.handle(
      new Request("http://runtime/v1", {
        ...(signal ? { signal } : {}),
        method: "POST",
        headers: { [AUTH_HEADER]: this.grant.token },
        body: JSON.stringify(request),
      }),
    );
  }
  /** Revoke admission first, then terminate owned groups before draining their RPCs. */
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.execReleases]);
    await Promise.all([this.execChildren.close(), ...Object.values(this.drivers).map((driver) => driver.close())]);
    await Promise.allSettled([...this.commands]);
  }
  async handle(request: Request): Promise<Response> {
    const token = request.headers.get(AUTH_HEADER) ?? "";
    if (
      Date.now() >= this.grant.expiresAt ||
      Buffer.byteLength(token) !== Buffer.byteLength(this.grant.token) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(this.grant.token))
    )
      return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      if (Number(request.headers.get("content-length") ?? 0) > 1048576) throw Error("request_too_large");
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 1048576) throw Error("request_too_large");
      let r: RunnerRequest;
      try {
        r = JSON.parse(raw) as RunnerRequest;
      } catch {
        throw Error("invalid_request");
      }
      if (this.closing) throw Error("sandbox_not_ready");
      if (!r || typeof r !== "object" || Array.isArray(r)) throw Error("invalid_request");
      if (r.version !== 1 || r.sandboxId !== this.grant.sandboxId || typeof r.requestId !== "string" || !r.requestId)
        throw Error("invalid_request");
      if (r.op === "installOrchestratorEpoch" || r.op === "scrubOrchestratorEpoch") {
        if (this.credentialFreeBuilder) throw Error("builder_credentials_forbidden");
        const allowed =
          r.op === "installOrchestratorEpoch"
            ? ["version", "requestId", "sandboxId", "op", "token", "binding", "url"]
            : ["version", "requestId", "sandboxId", "op", "tokenHash"];
        if (
          Object.keys(r).some((key) => !allowed.includes(key)) ||
          (r.op === "installOrchestratorEpoch" &&
            Object.keys(r.binding ?? {}).some((key) => !["epoch", "physicalGeneration"].includes(key)))
        )
          throw Error("invalid_request");
        if (r.requestId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(r.requestId)) throw Error("invalid_request");
        let result: { acknowledged: boolean };
        if (r.op === "installOrchestratorEpoch") result = this.nativeEpoch.install(r.token, r.binding, r.url);
        else {
          this.nativeEpoch.scrub(r.tokenHash);
          result = { acknowledged: true };
        }
        // Never put this private request/body or bearer in the replay cache.
        return new Response(this.journal.redact(JSON.stringify({ version: 1, requestId: r.requestId, result })), {
          headers: { "content-type": "application/json" },
        });
      }
      if (r.op === "testModelConnection") {
        if (
          this.credentialFreeBuilder ||
          this.barrier ||
          this.journal.checkpointPending(this.grant) ||
          this.resumingNative ||
          this.active.size ||
          this.commands.size ||
          !this.execution.testModelConnection ||
          !["claude", "codex"].includes(r.harness) ||
          typeof r.model !== "string" ||
          !r.model ||
          r.model.length > 200 ||
          r.requestId.length > 128 ||
          Object.keys(r).some((key) => !["version", "requestId", "sandboxId", "op", "harness", "model"].includes(key))
        )
          throw Error("model_connection_test_denied");
        const work = this.execution.testModelConnection(r.harness, r.model, request.signal);
        this.commands.add(work);
        try {
          const result = await work;
          // This health check is fresh and transient: no prompt, event or replay-cache row.
          return Response.json({ version: 1, requestId: r.requestId, result });
        } finally {
          this.commands.delete(work);
        }
      }
      if (r.op === "configureReadableVariables") {
        if (
          this.credentialFreeBuilder ||
          this.barrier ||
          this.journal.checkpointPending(this.grant) ||
          !(HARNESSES as readonly string[]).includes(r.harness) ||
          Object.keys(r).some((k) => !["version", "requestId", "sandboxId", "op", "harness", "variables"].includes(k))
        )
          throw Error("invalid_request");
        const variables = validateReadableVariables(r.variables);
        const digest = JSON.stringify(Object.entries(variables).sort());
        const previous = this.readableDigests.get(r.harness);
        if (previous !== undefined && previous !== digest) throw Error("invalid_request");
        if (previous === digest)
          return Response.json({ version: 1, requestId: r.requestId, result: { acknowledged: true } });
        const bootstrap = this.drivers[r.harness]?.configureReadableVariables;
        if (!bootstrap) throw Error("invalid_request");
        bootstrap.call(this.drivers[r.harness], variables);
        this.readableDigests.set(r.harness, digest);
        return Response.json({ version: 1, requestId: r.requestId, result: { acknowledged: true } });
      }
      if (r.op === "configureGitHub") {
        // Private configuration is never persisted in request receipts or returned to callers.
        if (
          this.credentialFreeBuilder ||
          this.barrier ||
          this.journal.checkpointPending(this.grant) ||
          !this.configureGitHub
        )
          throw Error("github_configuration_denied");
        if (Object.keys(r).some((key) => !["version", "requestId", "sandboxId", "op", "configuration"].includes(key)))
          throw Error("github_configuration_denied");
        if (
          r.configuration &&
          (r.configuration.generation !== this.grant.generation || r.configuration.expiresAt > this.grant.expiresAt)
        )
          throw Error("github_configuration_denied");
        try {
          await this.configureGitHub(r.configuration);
        } catch {
          throw Error("github_configuration_denied");
        }
        return Response.json({ version: 1, requestId: r.requestId, result: { acknowledged: true } });
      }
      if (r.op === "configureMcp") {
        if (r.requestId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(r.requestId)) throw Error("invalid_request");
        if (Object.keys(r).some((k) => !["version", "requestId", "sandboxId", "op", "configuration"].includes(k)))
          throw Error("invalid_mcp_configuration");
        const result = this.configureMcp(r.configuration);
        return Response.json({ version: 1, requestId: r.requestId, result });
      }
      if (r.op === "resourceObservation") {
        if (Object.keys(r).some((key) => !["version", "requestId", "sandboxId", "op"].includes(key)))
          throw Error("invalid_request");
        if (this.barrier || this.journal.checkpointPending(this.grant)) throw Error("checkpoint_in_progress");
        // Observation is fresh read-only data: never replay cached request outcomes or journal it.
        const result = await sampleVmResources();
        return Response.json({ version: 1, requestId: r.requestId, result });
      }
      const old = this.journal.db.query("SELECT body FROM requests WHERE id=?").get(r.requestId) as {
        body: string;
      } | null;
      if (old && r.op !== "checkpoint")
        return new Response(old.body, { headers: { "content-type": "application/json" } });
      const mutating = !["events", "health", "getPrompt", "getExec", "checkpoint", "observeOrchestrator"].includes(
        r.op,
      );
      // Fence before side effects. A crash leaves an explicit unknown outcome, never a duplicate turn.
      if (mutating)
        this.journal.db
          .query("INSERT INTO requests VALUES(?,?)")
          .run(r.requestId, JSON.stringify({ version: 1, requestId: r.requestId, error: "request_outcome_unknown" }));
      const result = await this.dispatch(r, request.signal);
      const body = this.journal.redact(JSON.stringify({ version: 1, requestId: r.requestId, result }));
      if (!["events", "health", "getPrompt", "getExec", "checkpoint", "observeOrchestrator"].includes(r.op))
        this.journal.db.query("INSERT OR REPLACE INTO requests VALUES(?,?)").run(r.requestId, body);
      return new Response(body, { headers: { "content-type": "application/json" } });
    } catch (error) {
      return Response.json(
        { error: this.journal.redact(error instanceof Error ? error.message : "runner_error") },
        { status: error instanceof Error && error.message === "unauthorized" ? 401 : 409 },
      );
    }
  }
  private configureMcp(value: unknown, epochControl = false): ConfigureMcpResult {
    if (Date.now() >= this.grant.expiresAt) throw Error("unauthorized");
    if (this.barrier || this.journal.checkpointPending(this.grant)) throw Error("checkpoint_in_progress");
    const validated = validateMcpConfiguration(value);
    const configuration = !epochControl ? (this.nativeEpoch?.connections(validated) ?? validated) : validated,
      values = mcpSecretValues(configuration);
    if (this.credentialFreeBuilder && Object.keys(configuration.servers).length)
      throw Error("builder_credentials_forbidden");
    if (values.some((v) => v === configuration.revision)) throw Error("invalid_mcp_configuration");
    const prefix = `mcp:v2:${checkpointIdentityKey(this.grant)}:`,
      key = prefix + mcpDigest(configuration.revision),
      digest = mcpDigest(configuration);
    const previous = this.journal.db.query("SELECT value FROM metadata WHERE key=?").get(key) as {
      value: string;
    } | null;
    const current = this.journal.db.query("SELECT value FROM metadata WHERE key=?").get(`${prefix}current`) as {
      value: string;
    } | null;
    if (previous && previous.value !== digest) throw Error("mcp_revision_conflict");
    if (previous && current && current.value !== key) throw Error("stale_mcp_revision");
    if (
      !previous &&
      Number(
        (
          this.journal.db
            .query("SELECT count(*) AS n FROM metadata WHERE substr(key,1,?)=? AND key<>?")
            .get(prefix.length, prefix, `${prefix}current`) as { n: number }
        ).n,
      ) >= 4096
    )
      throw Error("mcp_revision_limit");
    if (Date.now() >= this.grant.expiresAt) throw Error("unauthorized");
    // Register before SQL metadata, snapshot replacement, events, native stderr or any acknowledgement.
    this.journal.registerSecrets(values);
    this.journal.db.transaction(() => {
      this.journal.db.query("INSERT OR REPLACE INTO metadata VALUES(?,?)").run(key, digest);
      this.journal.db.query("INSERT OR REPLACE INTO metadata VALUES(?,?)").run(`${prefix}current`, key);
    })();
    this.mcp = configuration;
    return { revision: configuration.revision };
  }
  private async dispatch(
    r: Exclude<
      RunnerRequest,
      {
        op:
          | "configureMcp"
          | "configureGitHub"
          | "configureReadableVariables"
          | "testModelConnection"
          | "resourceObservation"
          | "installOrchestratorEpoch"
          | "scrubOrchestratorEpoch";
      }
    >,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (r.op === "observeOrchestrator") {
      if (
        r.conversationId !== undefined &&
        (typeof r.conversationId !== "string" || !r.conversationId || r.conversationId.length > 256)
      )
        throw Error("invalid_request");
      const watermark = Number(
        (this.journal.db.query("SELECT coalesce(max(seq),0) AS watermark FROM events").get() as { watermark: number })
          .watermark,
      );
      let state: "active" | "quiescent" | "unknown" =
        this.barrier || this.journal.checkpointPending(this.grant) ? "unknown" : "quiescent";
      const processes: Array<{ pid: number; state: string }> = [];
      for (const row of this.journal.db.query("SELECT pid,body FROM processes").all() as {
        pid: number;
        body: string;
      }[]) {
        const saved = JSON.parse(row.body) as { status: string; identity?: ProcessIdentity };
        if (!["running", "running_after_restart", "unknown_after_restart"].includes(saved.status)) continue;
        const status = groupState(row.pid, saved.identity);
        processes.push({ pid: row.pid, state: status });
        if (status === "unverifiable") state = "unknown";
        else if (status === "live" && state !== "unknown") state = "active";
      }
      if ((this.active.size > 0 || this.commands.size > 0) && state !== "unknown") state = "active";
      const acknowledgedSequence = this.journal.ack;
      if (state === "quiescent" && acknowledgedSequence < watermark) state = "unknown";
      const evidence = createHash("sha256")
        .update(
          JSON.stringify({
            generation: this.grant.generation,
            watermark,
            acknowledgedSequence,
            active: [...this.active.keys()].sort(),
            commands: this.commands.size,
            processes,
          }),
        )
        .digest("hex");
      return {
        physicalGeneration: this.grant.generation,
        state,
        evidence,
        eventWatermark: watermark,
        acknowledgedSequence,
        nativeSessionId: r.conversationId ? (this.journal.session(r.conversationId) ?? null) : null,
      };
    }
    if (r.op === "resumeNativeSession") {
      if (this.credentialFreeBuilder || this.barrier || this.active.size || this.commands.size || this.resumingNative)
        throw Error("native_resume_unavailable");
      if (
        Object.keys(r).some(
          (key) =>
            !["version", "requestId", "sandboxId", "op", "conversationId", "expectedSessionId", "input"].includes(key),
        ) ||
        !r.input ||
        typeof r.input !== "object" ||
        Array.isArray(r.input) ||
        typeof r.input.model !== "string" ||
        !r.input.model ||
        r.input.model.length > 256 ||
        (r.input.reasoningEffort !== undefined && typeof r.input.reasoningEffort !== "string") ||
        Object.keys(r.input).some(
          (key) => !["sandboxId", "harness", "model", "reasoningEffort", "cwd"].includes(key),
        ) ||
        r.input.sandboxId !== this.grant.sandboxId ||
        !(HARNESSES as readonly string[]).includes(r.input.harness) ||
        typeof r.conversationId !== "string" ||
        !r.conversationId ||
        r.conversationId.length > 256 ||
        typeof r.expectedSessionId !== "string" ||
        !r.expectedSessionId ||
        r.expectedSessionId.length > 256
      )
        throw Error("invalid_native_resume");
      const saved = this.journal.db
        .query("SELECT harness,session FROM sessions WHERE conversation=?")
        .get(r.conversationId) as { harness: string; session: string } | null;
      if (!saved || saved.harness !== r.input.harness || saved.session !== r.expectedSessionId)
        throw Error("native_session_identity_changed");
      const resume = this.drivers[r.input.harness]?.resumeSession?.bind(this.drivers[r.input.harness]);
      if (!resume) throw Error("native_resume_unsupported");
      this.resumingNative = true;
      // Consume actual604's sync redactor refresh and async private publication
      // from the SAME execution object. A native handshake can rotate auth even
      // without inference; its ACK must wait for publication, including failures.
      const refresh = () => {
        const callback = Reflect.get(this.execution, "refreshNativeSecrets");
        if (callback === undefined) return;
        if (typeof callback !== "function" || Reflect.apply(callback, this.execution, []) !== undefined)
          throw Error("native_auth_state_unacknowledged");
      };
      const publish = async () => {
        const callback = Reflect.get(this.execution, "publishNativeAuth");
        if (callback === undefined) return;
        if (typeof callback !== "function") throw Error("native_auth_state_unacknowledged");
        await Reflect.apply(callback, this.execution, []);
      };
      const work = Promise.resolve().then(async () => {
        try {
          refresh();
        } catch {
          throw Error("native_auth_state_unacknowledged");
        }
        const outcome = await Promise.resolve()
          .then(() =>
            resume({
              request: r.input,
              sessionId: saved.session,
              signal: AbortSignal.timeout(Math.max(1, Math.min(90000, this.grant.expiresAt - Date.now()))),
              ...(this.mcp ? { mcp: this.mcp } : {}),
            }),
          )
          .then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, error }),
          );
        try {
          refresh();
          await publish();
        } catch {
          throw Error("native_auth_state_unacknowledged");
        }
        if (!outcome.ok) throw outcome.error;
        return outcome.value;
      });
      this.commands.add(work);
      try {
        const result = await work;
        if (
          result.sessionId !== saved.session ||
          this.journal.session(r.conversationId) !== saved.session ||
          Date.now() >= this.grant.expiresAt
        )
          throw Error("native_session_identity_changed");
        return {
          physicalGeneration: this.grant.generation,
          conversationId: r.conversationId,
          nativeSessionId: saved.session,
          verified: true,
        };
      } finally {
        this.commands.delete(work);
        this.resumingNative = false;
      }
    }
    if (r.op === "health")
      return {
        ...(this.execution.restoredFrom ? { restoredFrom: this.execution.restoredFrom } : {}),
        generation: this.grant.generation,
        mcpVersion: 1,
        skillsVersion: 1,
        workspaceVersion: 1,
        ready: !this.barrier,
        pid: process.pid,
      };
    if (r.op === "getPrompt") {
      const p = this.journal.get(r.promptId);
      if (!p) throw Error("not_found");
      return {
        promptId: p.promptId,
        conversationId: p.conversationId,
        status: p.status,
        done: !["running", "queued"].includes(p.status),
      };
    }
    if (r.op === "events") {
      const after = Number(r.cursor ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw Error("invalid_cursor");
      const limit = Math.max(1, Math.min(r.limit ?? 100, 1000));
      const rows = this.journal.events(after, limit + 1, r.conversationId);
      const page = rows.slice(0, limit);
      return {
        events: page.map((x) => x.event),
        cursor: String(page.at(-1)?.sequence ?? after),
        hasMore: rows.length > limit,
      };
    }
    if (r.op === "getExec") {
      const row = this.journal.db.query("SELECT body FROM processes WHERE pid=?").get(r.processId) as {
        body: string;
      } | null;
      if (!row) throw Error("not_found");
      const value = JSON.parse(row.body);
      if (value.status === "running_after_restart" && groupState(r.processId, value.identity) !== "live") {
        value.status = "unknown_after_restart";
        this.journal.db.query("UPDATE processes SET body=? WHERE pid=?").run(JSON.stringify(value), r.processId);
      }
      return value;
    }
    if (r.op === "checkpoint") {
      this.nativeEpoch.assertEmpty();
      this.barrier = true;
      this.journal.checkpointFence(this.grant, "preparing");
      for (const row of this.journal.db.query("SELECT pid,body FROM processes").all() as {
        pid: number;
        body: string;
      }[]) {
        const value = JSON.parse(row.body) as { identity?: ProcessIdentity; quiesced?: boolean };
        if (value.quiesced) continue;
        const state = groupState(row.pid, value.identity);
        if (state === "live") throw Error("checkpoint_exec_processes_live");
        if (state === "unverifiable") throw Error("checkpoint_exec_identity_unverifiable");
        this.journal.db
          .query("UPDATE processes SET body=? WHERE pid=?")
          .run(JSON.stringify({ ...value, quiesced: true }), row.pid);
      }
      await Promise.all(
        [...this.active.values()].map(async (a) => {
          if (!a.terminal) await a.turn.interrupt();
          await a.done;
        }),
      );
      await Promise.all(this.commands);
      await Promise.all(Object.values(this.drivers).map((d) => d.close()));
      await this.flushOutbox();
      const watermark = this.journal.events(0, Number.MAX_SAFE_INTEGER).at(-1)?.sequence ?? 0;
      if (this.journal.ack < watermark) throw Error("checkpoint_upstream_unacknowledged");
      await this.configureGitHub?.(null);
      await this.stripTransientAuth?.();
      this.journal.checkpointFence(this.grant, "complete");
      this.journal.flush();
      return { watermark, acknowledgedSequence: this.journal.ack, generation: this.grant.generation };
    }
    if (this.barrier) throw Error("checkpoint_in_progress");
    if (this.preparingWorkspace && !["getPrompt", "events", "getExec"].includes(r.op))
      throw Error("workspace_setup_in_progress");
    if (this.installingSkills && !["getPrompt", "events", "getExec"].includes(r.op))
      throw Error("skills_install_in_progress");
    if (r.op === "workspaceExec") {
      if (
        this.credentialFreeBuilder ||
        this.active.size ||
        this.commands.size ||
        this.resumingNative ||
        this.journal.db.query("SELECT 1 FROM prompts LIMIT 1").get()
      )
        throw Error("workspace_launch_only");
      const input = validateWorkspaceExec(r.input);
      this.preparingWorkspace = true;
      const workspaceEvent = (status: "running" | "finished" | "failed", exitCode?: number | null) =>
        this.journal.append({
          id: `workspace_${r.requestId}_${status}`,
          at: Date.now(),
          kind: "other",
          type: "armada/workspaceStep",
          data: {
            phase: input.phase,
            index: input.index,
            attempt: input.attempt,
            status,
            ...(exitCode !== undefined ? { exitCode } : {}),
          },
        });
      workspaceEvent("running");
      const work = (async () => {
        await this.execution.prepareWorkspace?.();
        return executeWorkspace(input, this.journal, this.execEnvironment, signal);
      })();
      this.commands.add(work);
      try {
        const result = await work;
        workspaceEvent(!result.timedOut && result.exitCode === 0 ? "finished" : "failed", result.exitCode);
        return result;
      } catch (error) {
        workspaceEvent("failed");
        throw error;
      } finally {
        this.commands.delete(work);
        this.preparingWorkspace = false;
      }
    }
    if (r.op === "installSkills") {
      if (
        this.credentialFreeBuilder ||
        this.active.size ||
        this.commands.size ||
        this.resumingNative ||
        !r.input ||
        !(HARNESSES as readonly string[]).includes(r.input.harness) ||
        !this.drivers[r.input.harness]
      )
        throw Error("skills_install_denied");
      if (Object.keys(r.input).some((k) => !["harness", "references", "cwd", "key"].includes(k)))
        throw Error("skills_install_denied");
      const cwd = validateHarnessCwd(r.input.cwd);
      this.installingSkills = true;
      const work = installRuntimeSkills({ ...r.input, cwd }, this.journal, this.execEnvironment, signal);
      this.commands.add(work);
      try {
        return { receipts: await work };
      } catch (error) {
        const reason =
          error instanceof Error &&
          [
            ...PRIVATE_SKILL_FAILURES,
            "skillpack_credential_missing",
            "skillpack_credential_refused",
            "skillpack_skill_unavailable",
          ].includes(error.message as never)
            ? error.message
            : "skillpack_install_state_invalid";
        return { failure: { reason } };
      } finally {
        this.commands.delete(work);
        this.installingSkills = false;
      }
    }
    if (r.op === "exec") {
      this.refreshNativeSecrets?.();
      const work = this.exec(r.input, signal);
      this.commands.add(work);
      try {
        return await work;
      } finally {
        this.commands.delete(work);
      }
    }
    if (r.op === "prompt") {
      if (this.resumingNative) throw Error("native_resume_in_progress");
      if (this.credentialFreeBuilder) throw Error("builder_model_prompts_forbidden");
      if (
        this.exclusiveNativeAuth &&
        r.input.harness === "codex" &&
        [...this.active.values()].some((value) => value.prompt.request.harness === "codex")
      )
        throw Error("native_auth_writer_busy");
      if (r.input.conversationId) {
        const existing = this.journal.prompts().find((p) => p.conversationId === r.input.conversationId);
        if (existing && existing.request.harness !== r.input.harness) throw Error("conversation_harness_mismatch");
      }
      if (
        r.input.sandboxId !== this.grant.sandboxId ||
        !(HARNESSES as readonly string[]).includes(r.input.harness) ||
        typeof r.input.text !== "string" ||
        !r.input.text.trim()
      )
        throw Error("invalid_request");
      if (r.input.cwd !== undefined) validateHarnessCwd(r.input.cwd);
      const conversationId = r.input.conversationId ?? crypto.randomUUID();
      if (this.active.has(conversationId)) throw Error("conversation_busy");
      const p: StoredPrompt = { promptId: crypto.randomUUID(), conversationId, status: "queued", request: r.input };
      this.journal.transition(p, "queued");
      this.start(p);
      return { promptId: p.promptId, conversationId, status: this.journal.get(p.promptId)?.status ?? "failed" };
    }
    const targets = r.conversationId
      ? [this.active.get(r.conversationId)].filter((x) => x !== undefined)
      : [...this.active.values()];
    if (r.op === "interrupt") {
      await Promise.all(
        targets.map(async (a) => {
          if (!a.terminal) await a.turn.interrupt();
          await a.done;
        }),
      );
      return {};
    }
    if (r.op === "steer") {
      const a = targets[0];
      if (!a || targets.length !== 1) throw Error("no_running_turn");
      await a.turn.steer(r.text);
      this.journal.append({
        id: crypto.randomUUID(),
        at: Date.now(),
        kind: "steer",
        text: r.text,
        conversationId: a.prompt.conversationId,
        promptId: a.prompt.promptId,
      });
      return { conversationId: a.prompt.conversationId, promptId: a.prompt.promptId };
    }
    throw Error("invalid_operation");
  }
  private start(p: StoredPrompt) {
    const controller = new AbortController();
    this.journal.transition(p, "running");
    try {
      const sessionId = this.journal.session(p.conversationId);
      const driver = this.drivers[p.request.harness];
      if (!driver) throw Error("unsupported_harness");
      const turn = driver.start({
        request: p.request,
        signal: controller.signal,
        ...(sessionId ? { sessionId } : {}),
        ...(this.mcp ? { mcp: this.mcp } : {}),
        session: (id) => this.journal.saveSession(p.conversationId, p.request.harness, id),
        emit: (event) =>
          this.journal.append({
            ...event,
            id: crypto.randomUUID(),
            at: Date.now(),
            conversationId: p.conversationId,
            promptId: p.promptId,
          }),
      });
      const active = { turn, controller, prompt: p, done: Promise.resolve(), terminal: false };
      const done = turn.done
        .then(
          async (status) => {
            active.terminal = true;
            await this.publishNativeAuth?.();
            this.journal.transition(p, status);
          },
          async (error: unknown) => {
            active.terminal = true;
            await this.publishNativeAuth?.();
            this.journal.transition(p, "failed", error instanceof HarnessError ? error.code : "harness_failed");
          },
        )
        .catch(() => this.journal.transition(p, "failed", "native_auth_state_unacknowledged"))
        .finally(() => {
          this.active.delete(p.conversationId);
          void this.flushOutbox().catch(() => {});
        });
      active.done = done;
      this.active.set(p.conversationId, active);
    } catch {
      this.journal.transition(p, "failed", "harness_start_failed");
    }
  }
  private flushing: Promise<void> | undefined;
  flushOutbox(): Promise<void> {
    if (!this.flushing)
      this.flushing = this.drainOutbox().finally(() => {
        this.flushing = undefined;
      });
    return this.flushing;
  }
  private async drainOutbox() {
    if (!this.ingest) return;
    for (;;) {
      const pending = this.journal.events(this.journal.ack, 100);
      if (!pending.length) return;
      const batch = {
        sandboxId: this.grant.sandboxId,
        generation: this.grant.generation,
        events: [] as typeof pending,
      };
      // Modal ingest caps the entire JSON body at 1 MiB, not 100 events.
      // Count UTF-8 bytes (including envelope, sequence wrappers and commas);
      // never truncate or skip a journal entry to make a batch fit.
      let bytes = Buffer.byteLength(JSON.stringify(batch));
      for (const item of pending) {
        const size = Buffer.byteLength(JSON.stringify(item)) + (batch.events.length ? 1 : 0);
        if (bytes + size > 1048576) break;
        batch.events.push(item);
        bytes += size;
      }
      if (!batch.events.length) throw Error("ingest_event_too_large");
      const { events } = batch;
      const result: unknown = await this.ingest.append(batch);
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        !("acknowledgedSequence" in result) ||
        typeof result.acknowledgedSequence !== "number" ||
        !Number.isSafeInteger(result.acknowledgedSequence) ||
        result.acknowledgedSequence < 0
      )
        throw Error("invalid_ingest_ack");
      if (
        result.acknowledgedSequence < this.journal.ack ||
        result.acknowledgedSequence > (events.at(-1)?.sequence ?? 0)
      )
        throw Error("invalid_ingest_ack");
      if (result.acknowledgedSequence === this.journal.ack) throw Error("ingest_no_progress");
      this.journal.ack = result.acknowledgedSequence;
    }
  }
  private async exec(r: ExecRequest, signal?: AbortSignal): Promise<ExecResult> {
    signal?.throwIfAborted();
    if (r.sandboxId !== this.grant.sandboxId || typeof r.command !== "string") throw Error("invalid_request");
    const child = this.execChildren.spawn("/bin/bash", ["-s"], {
      cwd: r.cwd ?? process.cwd(),
      env: this.execEnvironment,
    });
    child.stdin.on("error", () => {});
    child.stdin.end(r.command);
    let stdout = "",
      stderr = "",
      truncated = false,
      timedOut = false;
    const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString();
      if (stream === "stdout") {
        stdout += text;
        if (stdout.length > 65536) {
          stdout = stdout.slice(0, 65536);
          truncated = true;
        }
      } else {
        stderr += text;
        if (stderr.length > 65536) {
          stderr = stderr.slice(0, 65536);
          truncated = true;
        }
      }
    };
    child.stdout.on("data", (c) => collect("stdout", c));
    child.stderr.on("data", (c) => collect("stderr", c));
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const pid = child.pid as number;
    const terminate = () => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    };
    signal?.addEventListener("abort", terminate, { once: true });
    if (signal?.aborted) terminate();
    const save = (value: unknown) =>
      this.journal.db
        .query("INSERT OR REPLACE INTO processes VALUES(?,?)")
        .run(pid, this.journal.redact(JSON.stringify(value)));
    const identity = processIdentity(pid);
    save({ pid, status: "running", identity });
    const timer = setTimeout(
      () => {
        timedOut = true;
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      },
      (r.timeoutSeconds ?? 3600) * 1000,
    );
    const done = new Promise<ExecResult>((resolve) =>
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        // Synchronous commands own their whole process group, including background descendants.
        terminate();
        signal?.removeEventListener("abort", terminate);
        try {
          this.refreshNativeSecrets?.();
        } catch {
          const safe: ExecResult = {
            detached: false,
            exitCode: null,
            stdout: "",
            stderr: "Native auth state could not be safely redacted.",
            timedOut: false,
            truncated: true,
          };
          save({ pid, status: "exited", identity, ...safe });
          resolve(safe);
          return;
        }
        const result: ExecResult = {
          detached: false,
          exitCode,
          stdout: this.journal.redact(stdout),
          stderr: this.journal.redact(stderr),
          timedOut,
          truncated,
        };
        save({ pid, status: "exited", identity, ...result });
        resolve(result);
      }),
    );
    this.commands.add(done);
    void done.finally(() => this.commands.delete(done));
    if (r.detached) return { detached: true, processId: pid };
    const result = await done;
    if (!this.closing) {
      const release = this.execChildren.release(child);
      this.execReleases.add(release);
      try {
        await release;
      } finally {
        this.execReleases.delete(release);
      }
    }
    return result;
  }
}
