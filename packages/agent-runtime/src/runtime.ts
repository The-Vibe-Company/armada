import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import type { ExecRequest, ExecResult } from "@armada/core";
import { validateHarnessCwd } from "./cwd.ts";
import { HarnessError } from "./errors.ts";
import { execCredentialValues, validateExecEnvironment } from "./exec-env.ts";
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
export class Runner {
  private active = new Map<
    string,
    { turn: Turn; done: Promise<void>; controller: AbortController; prompt: StoredPrompt }
  >();
  private barrier = false;
  private mcp: McpConfiguration | undefined;
  private nativeEpoch: NativeEpoch;
  private execEnvironment: Readonly<Record<string, string>>;
  private credentialFreeBuilder: boolean;
  private commands = new Set<Promise<unknown>>();
  private resumingNative = false;
  constructor(
    readonly journal: Journal,
    readonly grant: Grant,
    readonly drivers: Record<"claude" | "codex", Driver>,
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
    const execEnv = validateExecEnvironment(execution.execEnv, this.credentialFreeBuilder);
    journal.registerSecrets(execCredentialValues(execEnv));
    this.execEnvironment = Object.freeze({
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      GIT_TERMINAL_PROMPT: "0",
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
      const result = await this.dispatch(r);
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
    if (this.nativeEpoch?.active && !epochControl) throw Error("orchestrator_authority_managed");
    if (Date.now() >= this.grant.expiresAt) throw Error("unauthorized");
    if (this.barrier || this.journal.checkpointPending(this.grant)) throw Error("checkpoint_in_progress");
    const configuration = validateMcpConfiguration(value),
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
      { op: "configureMcp" | "resourceObservation" | "installOrchestratorEpoch" | "scrubOrchestratorEpoch" }
    >,
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
        !["claude", "codex"].includes(r.input.harness) ||
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
      const resume = this.drivers[r.input.harness].resumeSession?.bind(this.drivers[r.input.harness]);
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
    if (r.op === "health") return { generation: this.grant.generation, ready: !this.barrier };
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
          await a.turn.interrupt();
          await a.done;
        }),
      );
      await Promise.all(this.commands);
      await Promise.all(Object.values(this.drivers).map((d) => d.close()));
      await this.flushOutbox();
      const watermark = this.journal.events(0, Number.MAX_SAFE_INTEGER).at(-1)?.sequence ?? 0;
      if (this.journal.ack < watermark) throw Error("checkpoint_upstream_unacknowledged");
      await this.stripTransientAuth?.();
      this.journal.checkpointFence(this.grant, "complete");
      this.journal.flush();
      return { watermark, acknowledgedSequence: this.journal.ack, generation: this.grant.generation };
    }
    if (this.barrier) throw Error("checkpoint_in_progress");
    if (r.op === "exec") {
      const work = this.exec(r.input);
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
      if (r.input.conversationId) {
        const existing = this.journal.prompts().find((p) => p.conversationId === r.input.conversationId);
        if (existing && existing.request.harness !== r.input.harness) throw Error("conversation_harness_mismatch");
      }
      if (
        r.input.sandboxId !== this.grant.sandboxId ||
        !["claude", "codex"].includes(r.input.harness) ||
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
          await a.turn.interrupt();
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
      const turn = this.drivers[p.request.harness].start({
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
      const done = turn.done
        .then(
          (status) => {
            this.journal.transition(p, status);
          },
          (error: unknown) => {
            this.journal.transition(p, "failed", error instanceof HarnessError ? error.code : "harness_failed");
          },
        )
        .finally(() => {
          this.active.delete(p.conversationId);
          void this.flushOutbox().catch(() => {});
        });
      this.active.set(p.conversationId, { turn, controller, prompt: p, done });
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
  private async exec(r: ExecRequest): Promise<ExecResult> {
    if (r.sandboxId !== this.grant.sandboxId || typeof r.command !== "string") throw Error("invalid_request");
    const child = spawn("/bin/bash", ["-s"], {
      cwd: r.cwd ?? process.cwd(),
      detached: true,
      env: this.execEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
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
    return done;
  }
}
