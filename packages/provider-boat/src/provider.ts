import type {
  CreateGoldenRequest,
  DeleteReceipt,
  EventPage,
  EventsRequest,
  ExecRequest,
  ExecResult,
  ForkRequest,
  Harness,
  HarnessCapabilities,
  InterruptRequest,
  ListRequest,
  Page,
  PrepareNativeHarnessCwdRequest,
  PromptReceipt,
  PromptRequest,
  PromptState,
  Provider,
  SandboxInfo,
  SandboxState,
  SnapshotInfo,
  SnapshotRequest,
  SshConnection,
  SshKeyRequest,
  SteerReceipt,
  SteerRequest,
} from "@armada/core";
import { buildEventPage, eventPageOptions, MACHINE_SIZE_CATALOG, ProviderError, parseMachineSize } from "@armada/core";
import {
  BoatApi,
  Configuration,
  type CreateSandboxRequest,
  type PromptRequestProviderEnum,
  type Sandbox,
  type SavedSnapshot,
  type StopOperationResponse,
} from "@boatdev/sdk";
import {
  parseVmResourceFiles,
  VM_RESOURCE_MAX_FILE_BYTES,
  VM_RESOURCE_PATHS,
} from "../../core/src/vm-resource-reading.ts";
import { invalidRequest, PROVIDER_ID, toProviderError, unexpectedAnswer } from "./errors.ts";
import { eventCursor, normalizeEvent, promptStatus } from "./events.ts";
import { installNativeCwdWrapper } from "./native-cwd.ts";

export const DEFAULT_BASE_URL = "https://boat.dev/api/v1";
/** boat's own default, sent explicitly so a launch never depends on it. */
export const DEFAULT_TTL_SECONDS = 3600;
/** The longest TTL boat accepts: 30 days. */
export const MAX_TTL_SECONDS = 2_592_000;

/**
 * What boat gives each harness. Neither has an approvals API. Claude Code takes a steer into the running
 * turn; boat answers a Codex steer with mode `fallback`, which stops the turn and carries on in the same conversation.
 */
const BOAT_HARNESS: HarnessCapabilities = {
  steer: "native",
  interrupt: true,
  resume: true,
  parallelConversations: true,
  reasoningEffort: true,
  fast: true,
  streamsPartials: true,
  toolEvents: true,
  approvals: false,
};

export const BOAT_CAPABILITIES: Readonly<Record<Harness, HarnessCapabilities>> = {
  claude: BOAT_HARNESS,
  codex: { ...BOAT_HARNESS, steer: "restart" },
};

const BOAT_PROVIDER_NAME: Record<Harness, PromptRequestProviderEnum> = {
  claude: "claude-code",
  codex: "codex",
};

const BOAT_STATES: Record<SandboxState, readonly string[]> = {
  starting: ["init", "provisioning", "provisioned", "cloning"],
  ready: ["ready", "idle"],
  running: ["running"],
  stopping: ["archiving"],
  stopped: ["archived"],
  failed: ["error", "cancelled"],
};

function sandboxState(providerState: string): SandboxState {
  for (const [state, names] of Object.entries(BOAT_STATES)) {
    if (names.includes(providerState)) return state as SandboxState;
  }
  // A state boat adds later is not ready for work until this adapter learns it.
  return "starting";
}

function sandboxInfo(sandbox: Sandbox): SandboxInfo {
  const info: SandboxInfo = {
    id: sandbox.id,
    name: sandbox.name,
    state: sandboxState(sandbox.state),
    providerState: sandbox.state,
    labels: sandbox.labels ?? {},
  };
  if (sandbox.error) info.error = sandbox.error;
  if (sandbox.createdAt) info.createdAt = sandbox.createdAt;
  if (sandbox.stoppedAt) info.stoppedAt = sandbox.stoppedAt;
  if (sandbox.archiveAfter) info.expiresAt = sandbox.archiveAfter;
  if (sandbox.sshEndpoint) info.sshEndpoint = sandbox.sshEndpoint;
  return info;
}

function snapshotInfo(snapshot: SavedSnapshot): SnapshotInfo {
  const info: SnapshotInfo = { name: snapshot.name, status: snapshot.status };
  if (snapshot.snapshotId) info.artifactId = snapshot.snapshotId;
  if (snapshot.error) info.error = snapshot.error;
  if (snapshot.sourceSandboxId) info.sourceSandboxId = snapshot.sourceSandboxId;
  if (snapshot.createdAt) info.createdAt = snapshot.createdAt;
  return info;
}

export interface BoatProviderOptions {
  /** Server-owned output boundary; rejection releases no provider event bodies. */
  sanitizeEvents?: (provider: Provider, sandboxId: string, events: EventPage["events"]) => Promise<EventPage["events"]>;

  /** The boat API key. It stays in this object: no error or event carries it. */
  apiKey: string;
  /** Recheck/fence stopped authority before resume; false skips a stale observed resume. */
  beforeResume?: (provider: Provider, sandboxId: string) => Promise<boolean>;
  /** Called only after explicit physical readiness, before Boat creates the native turn. */
  beforeStop?: (provider: Provider, sandboxId: string) => Promise<void>;
  afterPrompt?: (provider: Provider, sandboxId: string) => Promise<void>;
  beforePrompt?: (provider: Provider, sandboxId: string) => Promise<void>;
  /** Scrub Armada-owned transient configuration before the snapshot request, fail closed on I/O. */
  beforeSnapshot?: (provider: Provider, sandboxId: string) => Promise<void>;
  baseUrl?: string;
  /** Seconds before boat stops a sandbox by itself, when a call names none. */
  defaultTtlSeconds?: number;
  /** For tests; the SDK's own fetch otherwise. */
  fetch?: typeof fetch;
  /** For tests: how a command refused while its sandbox restores its disk waits before it is sent again. */
  sleep?: (ms: number) => Promise<void>;
}

/** boat refuses a command with this message before running it while a resumed or forked sandbox mounts its disk. */
const RESTORING = "sandbox_restoring";
const RESTORE_RETRIES = 5;
const RESTORE_WAIT_MS = 2000;

function ttl(requested: number | undefined, fallback: number): number {
  const seconds = requested ?? fallback;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TTL_SECONDS) {
    throw invalidRequest(`ttlSeconds must be a whole number of seconds from 1 to ${MAX_TTL_SECONDS}.`);
  }
  return seconds;
}

function page<T>(items: T[], pageInfo: { nextCursor: string | null; hasMore: boolean } | undefined): Page<T> {
  return { items, cursor: pageInfo?.hasMore ? pageInfo.nextCursor : null };
}

/** The boat.dev placement, over `@boatdev/sdk`. Every failure is a `ProviderError`. */
export interface BoatProvider extends Provider {
  /** Ordinary VM activation only. Does not restore or verify a native harness session. */
  resumeBestEffort(sandboxId: string): Promise<void>;
  /** One ordinary stop dispatch followed by bounded reads of its exact archival operation. */
  stopBestEffort(sandboxId: string): Promise<void>;
  /** Terminal managed retirement only: caller must durably fence activation and
   * withhold unsynchronized native output before using this cloud-only port. */
  retireBestEffort?(sandboxId: string): Promise<void>;
  conversations(
    sandboxId: string,
  ): Promise<readonly { id: string; running: boolean; lastHarness: string | null; lastModel: string | null }[]>;
}

export function createBoatProvider(options: BoatProviderOptions): BoatProvider {
  const defaultTtl = options.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const api = new BoatApi(
    new Configuration({
      basePath: options.baseUrl ?? DEFAULT_BASE_URL,
      accessToken: options.apiKey,
      ...(options.fetch ? { fetchApi: options.fetch } : {}),
    }),
  );

  async function call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw await toProviderError(error);
    }
  }

  async function start(body: CreateSandboxRequest, idempotencyKey: string | undefined): Promise<SandboxInfo> {
    const response = await call(() =>
      api.create({ createSandboxRequest: body, ...(idempotencyKey ? { idempotencyKey } : {}) }),
    );
    if (!response.sandbox?.id) throw unexpectedAnswer("sandbox");
    return sandboxInfo(response.sandbox);
  }

  async function archive(sandboxId: string): Promise<void> {
    const signal = AbortSignal.timeout(150_000);
    // The generated SandboxActionResponse omits the documented top-level stop.
    // Read the raw acceptance so the exact operation fence is not discarded.
    const response = await call(async () => {
      const accepted = await api.stopRaw({ sandboxId }, { signal });
      return (await accepted.raw.json()) as {
        id?: string;
        stop?: { id?: string };
        sandbox?: { stop?: { id?: string } };
      };
    });
    if (response.id !== sandboxId) throw unexpectedAnswer("stop operation");
    const stopId = response.stop?.id ?? response.sandbox?.stop?.id;
    if (!stopId) throw unexpectedAnswer("stop operation");
    for (let attempt = 0; attempt < 120; attempt++) {
      signal.throwIfAborted();
      const observed: StopOperationResponse = await call(() => api.getStop({ sandboxId, stopId }, { signal }));
      if (observed.id !== sandboxId || observed.stop?.id !== stopId) throw unexpectedAnswer("stop operation");
      if (observed.stop.status === "completed") return;
      if (!["pending", "failing"].includes(observed.stop.status))
        throw invalidRequest("Sandbox archival was superseded.");
      await sleep(1000);
    }
    throw invalidRequest("Sandbox archival remains unconfirmed.");
  }

  const provider: BoatProvider = {
    id: PROVIDER_ID,
    harnesses: ["claude", "codex"],
    capabilities: BOAT_CAPABILITIES,
    maxGoldens: 1,
    async backendIdentity() {
      const response = await call(() => api.me({ signal: AbortSignal.timeout(10_000) }));
      if (!response.user.id) throw unexpectedAnswer("account identity");
      return { id: response.user.id };
    },

    async createGolden(request: CreateGoldenRequest): Promise<SandboxInfo> {
      // noEnv is not optional: a golden must not inherit the boat account's model credentials.
      // There is no `env` and no `environment` here, so nothing from the account is copied onto the disk.
      return start(
        {
          ttlSeconds: ttl(request.ttlSeconds, defaultTtl),
          noEnv: true,
          ...(request.name ? { name: request.name } : {}),
          ...(request.labels ? { labels: request.labels } : {}),
        },
        request.idempotencyKey,
      );
    },

    async prepareNativeHarnessCwd(request: PrepareNativeHarnessCwdRequest): Promise<void> {
      await installNativeCwdWrapper(
        async (execRequest) => {
          const response = await call(() =>
            api.command({
              sandboxId: execRequest.sandboxId,
              commandRequest: {
                command: execRequest.command,
                ...(execRequest.timeoutSeconds === undefined ? {} : { timeoutSeconds: execRequest.timeoutSeconds }),
              },
            }),
          );
          if ("processId" in response || !("exitCode" in response)) throw unexpectedAnswer("command result");
          if (response.exitCode !== 0) {
            throw new ProviderError({
              provider: PROVIDER_ID,
              code: "unknown",
              message: response.stderr || "Native harness preparation failed.",
              retryable: false,
            });
          }
        },
        request.sandboxId,
        request.harness,
        request.cwd,
      );
    },

    async sshKey(request: SshKeyRequest): Promise<SshConnection> {
      const response = await call(() =>
        api.sshKey({ sandboxId: request.sandboxId, sshKeyRequest: { key: request.key } }),
      );
      if (!response.sshEndpoint || !response.hostKey) throw unexpectedAnswer("SSH connection");
      return { sshEndpoint: response.sshEndpoint, hostKey: response.hostKey };
    },

    async snapshot(request: SnapshotRequest): Promise<SnapshotInfo> {
      await options.beforeSnapshot?.(provider, request.sandboxId);
      const response = await call(() =>
        api.saveSavedSnapshot({ savedSnapshotSaveRequest: { sandboxId: request.sandboxId, name: request.name } }),
      );
      if (!response.snapshot?.name) throw unexpectedAnswer("snapshot");
      return snapshotInfo(response.snapshot);
    },

    async getSnapshot(name: string): Promise<SnapshotInfo> {
      const response = await call(() => api.getSavedSnapshot({ name }));
      if (!response.snapshot?.name) throw unexpectedAnswer("snapshot");
      return snapshotInfo(response.snapshot);
    },

    async deleteSnapshot(name: string): Promise<void> {
      await call(() => api.deleteSavedSnapshot({ name }));
    },

    async fork(request: ForkRequest): Promise<SandboxInfo> {
      let type: CreateSandboxRequest["type"];
      if (request.size !== undefined) {
        try {
          type = MACHINE_SIZE_CATALOG[parseMachineSize(request.size)].boatType;
        } catch {
          throw invalidRequest("Size must be small, medium, large or xlarge.");
        }
      }
      return start(
        {
          from: request.from,
          ...(type === undefined ? {} : { type }),
          ttlSeconds: ttl(request.ttlSeconds, defaultTtl),
          ...(request.name ? { name: request.name } : {}),
          ...(request.labels ? { labels: request.labels } : {}),
          ...(request.env ? { env: request.env } : {}),
          ...(request.noEnv ? { noEnv: true } : {}),
        },
        request.idempotencyKey,
      );
    },

    async observeResources(sandboxId) {
      // Fixed supported file reads, never commands, model prompts or account-wide OTLP.
      const signal = AbortSignal.timeout(5000);
      const before = await api.get({ sandboxId }, { signal });
      if (!before.sandbox || !["ready", "running"].includes(sandboxInfo(before.sandbox).state)) return null;
      const files: (string | null)[] = [];
      for (const path of VM_RESOURCE_PATHS) {
        try {
          const response = await api.readFile({ sandboxId, path, encoding: "utf8" }, { signal });
          files.push(
            response.ok &&
              response.success &&
              response.path === path &&
              response.encoding === "utf8" &&
              typeof response.content === "string" &&
              Buffer.byteLength(response.content) < VM_RESOURCE_MAX_FILE_BYTES
              ? response.content
              : null,
          );
        } catch {
          files.push(null);
        }
        if (signal.aborted) return null;
      }
      const reading = parseVmResourceFiles(files);
      if (!reading) return null;
      const after = await api.get({ sandboxId }, { signal });
      if (!after.sandbox || !["ready", "running"].includes(sandboxInfo(after.sandbox).state)) return null;
      return {
        version: 1 as const,
        providerSandboxId: sandboxId,
        physicalId: `${sandboxId}/${reading.bootId}`,
        generation: reading.bootId,
        scope: "dedicated-vm" as const,
        runtimeProvenance: "boat-dedicated-vm" as const,
        reading,
        limitations: ["sampled-memory-not-peak", "hypervisor-throttling-unavailable"] as const,
      };
    },
    async get(sandboxId: string, requestOptions?: { signal?: AbortSignal }): Promise<SandboxInfo> {
      const response = await call(() =>
        api.get(
          { sandboxId },
          {
            signal: requestOptions?.signal
              ? AbortSignal.any([requestOptions.signal, AbortSignal.timeout(10_000)])
              : AbortSignal.timeout(10_000),
          },
        ),
      );
      if (!response.sandbox?.id) throw unexpectedAnswer("sandbox");
      return sandboxInfo(response.sandbox);
    },

    async resumeBestEffort(sandboxId: string): Promise<void> {
      const signal = AbortSignal.timeout(150_000);
      // Only the trusted managed adapter calls this port after its own owner,
      // account and operation fence. Ordinary MCP resume hooks deliberately hide
      // managed parents; managed MCP is prepared by that adapter after activation.
      await call(() => api.resume({ sandboxId }, { signal }));
      let info = await provider.get(sandboxId, { signal });
      for (let attempt = 0; info.state === "starting" && attempt < 120; attempt++) {
        signal.throwIfAborted();
        await sleep(1000);
        info = await provider.get(sandboxId, { signal });
      }
      if (!["ready", "running"].includes(info.state)) throw invalidRequest("Sandbox activation failed.");
    },
    async stopBestEffort(sandboxId: string): Promise<void> {
      await options.beforeStop?.(provider, sandboxId);
      await archive(sandboxId);
    },
    async retireBestEffort(sandboxId: string): Promise<void> {
      await archive(sandboxId);
    },
    async conversations(sandboxId: string) {
      const response = await call(() => api.conversations({ sandboxId }, { signal: AbortSignal.timeout(10_000) }));
      return response.conversations.map(({ id, running, lastHarness, lastModel }) => ({
        id,
        running,
        lastHarness,
        lastModel,
      }));
    },

    async list(request: ListRequest = {}): Promise<Page<SandboxInfo>> {
      const states = request.states?.flatMap((state) => BOAT_STATES[state]);
      const labels = Object.entries(request.labels ?? {}).map(([key, value]) => `${key}=${value}`);
      const response = await call(() =>
        api.sandboxes({
          sort: "desc",
          ...(request.limit ? { limit: request.limit } : {}),
          ...(request.cursor ? { cursor: request.cursor } : {}),
          ...(states?.length ? { state: states.join(",") } : {}),
          ...(labels.length ? { label: labels } : {}),
        }),
      );
      return page((response.sandboxes ?? []).map(sandboxInfo), response.pageInfo);
    },

    async prompt(request: PromptRequest): Promise<PromptReceipt> {
      let resumed = false;
      const workflow = AbortSignal.timeout(90_000);
      const signal = request.signal ? AbortSignal.any([workflow, request.signal]) : workflow;
      signal.throwIfAborted();
      if (request.text.trim() === "") throw invalidRequest("A prompt needs text.");
      if (options.beforePrompt || options.beforeResume) {
        let info = await provider.get(request.sandboxId, { signal });
        if (info.state === "stopped") {
          const shouldResume = await options.beforeResume?.(provider, request.sandboxId);
          if (shouldResume !== false) {
            try {
              await call(() => api.resume({ sandboxId: request.sandboxId }, { signal }));
            } catch (error) {
              if (!(error instanceof ProviderError) || error.status !== 409) throw error;
              const concurrent = await provider.get(request.sandboxId, { signal });
              if (!["starting", "ready", "running"].includes(concurrent.state)) throw error;
            }
          }
          resumed = true;
          info = await provider.get(request.sandboxId, { signal });
        }
        for (let attempt = 0; info.state === "starting" && attempt < 120; attempt++) {
          signal.throwIfAborted();
          await sleep(1000);
          info = await provider.get(request.sandboxId, { signal });
        }
        if (info.state !== "ready" && info.state !== "running")
          throw invalidRequest("Sandbox is not ready for native MCP configuration.");
        signal.throwIfAborted();
        await options.beforePrompt?.(provider, request.sandboxId);
      }
      if (options.beforePrompt && (request.harness === "codex" || provider.configureGitHub)) {
        await installNativeCwdWrapper(
          async (r) => {
            const result = await provider.exec(r);
            if (result.detached || result.exitCode !== 0)
              throw invalidRequest("Native MCP bridge installation failed.");
          },
          request.sandboxId,
          request.harness,
        );
      }
      signal.throwIfAborted();
      const response = await call(() =>
        api.prompt(
          {
            sandboxId: request.sandboxId,
            promptRequest: {
              provider: BOAT_PROVIDER_NAME[request.harness],
              prompt: request.text,
              ...(request.conversationId ? { conversationId: request.conversationId } : { _new: true }),
              ...(request.model ? { model: request.model } : {}),
              ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
              ...(request.fast !== undefined ? { fast: request.fast } : {}),
            },
          },
          { signal },
        ),
      );
      const conversationId = response.conversationId ?? response.promptRun?.conversationId;
      if (!response.promptId || !conversationId) throw unexpectedAnswer("prompt receipt");
      return {
        promptId: response.promptId,
        conversationId,
        status: promptStatus(response.status) ?? "queued",
        ...(resumed ? { resumed: true } : {}),
      };
    },

    async getPrompt(request: { sandboxId: string; promptId: string; signal?: AbortSignal }): Promise<PromptState> {
      request.signal?.throwIfAborted();
      const deadline = AbortSignal.timeout(10_000);
      const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
      const response = await call(() => api.promptRunStatus(request, { signal }));
      signal.throwIfAborted();
      const run = response.promptRun;
      const status = promptStatus(run?.status);
      if (!run || status === undefined) throw unexpectedAnswer("prompt status");
      if (run.done) await options.afterPrompt?.(provider, request.sandboxId);
      return {
        promptId: run.promptId,
        status,
        done: run.done,
        ...(run.conversationId ? { conversationId: run.conversationId } : {}),
      };
    },

    async steer(request: SteerRequest): Promise<SteerReceipt> {
      if (request.text.trim() === "") throw invalidRequest("A steer needs text.");
      const response = await call(() =>
        api.steer({
          sandboxId: request.sandboxId,
          steerRequest: {
            message: request.text,
            ...(request.conversationId ? { conversation: request.conversationId } : {}),
          },
          ...(request.conversationId ? { conversation: request.conversationId } : {}),
        }),
      );
      return {
        conversationId: response.conversationId,
        promptId: response.promptId,
        ...(response.mode ? { mode: response.mode } : {}),
      };
    },

    async interrupt(request: InterruptRequest): Promise<void> {
      await call(() =>
        api.interrupt({
          sandboxId: request.sandboxId,
          ...(request.conversationId ? { conversation: request.conversationId } : {}),
        }),
      );
    },

    async exec(request: ExecRequest): Promise<ExecResult> {
      const commandRequest = {
        command: request.command,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.timeoutSeconds ? { timeoutSeconds: request.timeoutSeconds } : {}),
        ...(request.detached ? { detached: true } : {}),
      };
      for (let attempt = 1; ; attempt++) {
        try {
          const response = await call(() => api.command({ sandboxId: request.sandboxId, commandRequest }));
          if ("processId" in response) return { detached: true, processId: response.processId };
          if (!("exitCode" in response)) throw unexpectedAnswer("command result");
          return {
            detached: false,
            exitCode: response.exitCode,
            stdout: response.stdout,
            stderr: response.stderr,
            timedOut: response.timedOut,
            truncated: response.stdoutTruncated === true || response.stderrTruncated === true,
          };
        } catch (error) {
          const restoring = error instanceof Error && "details" in error && isRestoring(error.details);
          if (!restoring || attempt >= RESTORE_RETRIES) throw error;
          await sleep(RESTORE_WAIT_MS);
        }
      }
    },

    async events(request: EventsRequest): Promise<EventPage> {
      request.signal?.throwIfAborted();
      const { limit, backward } = eventPageOptions(request, "boat");
      const response = await call(() =>
        api.events(
          {
            sandboxId: request.sandboxId,
            sort: backward ? "desc" : "asc",
            ...(request.cursor ? { cursor: request.cursor } : {}),
            ...(request.conversationId ? { conversation: request.conversationId } : {}),
            limit,
          },
          request.signal ? { signal: request.signal } : undefined,
        ),
      );
      request.signal?.throwIfAborted();
      const raw = response.events ?? [];
      const normalized = options.sanitizeEvents
        ? await options.sanitizeEvents(provider, request.sandboxId, raw.map(normalizeEvent))
        : raw.map(normalizeEvent);
      const page = buildEventPage(
        raw.map((event, index) => ({
          cursor: eventCursor(event) ?? response.pageInfo?.nextCursor ?? request.cursor ?? "",
          event: normalized[index]!,
        })),
        request,
        response.pageInfo?.hasMore === true,
        "boat",
      );
      if ((backward || page.hasMore) && raw.some((event) => !eventCursor(event))) {
        throw new ProviderError({
          provider: "boat",
          code: "invalid_request",
          retryable: false,
          message: "Boat events lack a stable pagination boundary.",
        });
      }
      // Boat can advance an empty forward page over filtered journal records.
      if (!raw.length && !backward && response.pageInfo?.nextCursor) page.cursor = response.pageInfo.nextCursor;
      return page;
    },

    async quiesce(request) {
      const active = (conversation: { id: string; running: boolean }) =>
        (!request.conversationId || conversation.id === request.conversationId) && conversation.running;
      // Idle reviewers have no turn to interrupt. Avoid making preservation
      // depend on the harness accepting an unnecessary interruption.
      if (!(await provider.conversations(request.sandboxId)).some(active)) return;
      await provider.interrupt(request);
      const conversations = await provider.conversations(request.sandboxId);
      if (
        conversations.some(
          (conversation) =>
            (!request.conversationId || conversation.id === request.conversationId) && conversation.running,
        )
      )
        throw new ProviderError({
          provider: PROVIDER_ID,
          code: "sandbox_not_ready",
          message: "Agent interruption is pending; refusing to stop before turns settle.",
          retryable: true,
        });
    },

    async extendLifetime(request) {
      const before = await provider.get(request.sandboxId);
      if (!["ready", "running"].includes(before.state)) throw invalidRequest("Only running compute can be extended.");
      const response = await call(() =>
        api.update(
          { sandboxId: request.sandboxId, updateSandboxRequest: { ttlSeconds: ttl(request.ttlSeconds, defaultTtl) } },
          { signal: AbortSignal.timeout(10_000) },
        ),
      );
      if (!response.sandbox) throw unexpectedAnswer("sandbox");
      const info = sandboxInfo(response.sandbox);
      if (!info.expiresAt) throw unexpectedAnswer("expiry");
      return info.expiresAt;
    },

    async stop(request: { sandboxId: string }): Promise<void> {
      await options.beforeStop?.(provider, request.sandboxId);
      await call(() => api.stop({ sandboxId: request.sandboxId }, { signal: AbortSignal.timeout(10_000) }));
    },

    async delete(request: { sandboxId: string }): Promise<DeleteReceipt> {
      const response = await call(() =>
        api.deleteSandbox({ sandboxId: request.sandboxId, xAsciiConfirmDelete: request.sandboxId }),
      );
      return {
        status: response.operation?.status ?? "pending",
        ...(response.operation?.id ? { operationId: response.operation.id } : {}),
      };
    },
  };
  return provider;
}

function isRestoring(details: unknown): boolean {
  return (
    typeof details === "object" &&
    details !== null &&
    (details as Record<string, unknown>).retryable === true &&
    (details as Record<string, unknown>).message === RESTORING
  );
}
