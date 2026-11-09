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
import { ProviderError } from "@armada/core";
import {
  BoatApi,
  Configuration,
  type CreateSandboxRequest,
  type PromptRequestProviderEnum,
  type Sandbox,
  type SavedSnapshot,
} from "@boatdev/sdk";
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
  if (snapshot.error) info.error = snapshot.error;
  if (snapshot.sourceSandboxId) info.sourceSandboxId = snapshot.sourceSandboxId;
  if (snapshot.createdAt) info.createdAt = snapshot.createdAt;
  return info;
}

export interface BoatProviderOptions {
  /** The boat API key. It stays in this object: no error or event carries it. */
  apiKey: string;
  /** Recheck/fence stopped authority before resume; false skips a stale observed resume. */
  beforeResume?: (provider: Provider, sandboxId: string) => Promise<boolean>;
  /** Called only after explicit physical readiness, before Boat creates the native turn. */
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
export function createBoatProvider(options: BoatProviderOptions): Provider {
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

  const provider: Provider = {
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
      return start(
        {
          from: request.from,
          ttlSeconds: ttl(request.ttlSeconds, defaultTtl),
          ...(request.name ? { name: request.name } : {}),
          ...(request.labels ? { labels: request.labels } : {}),
          ...(request.env ? { env: request.env } : {}),
          ...(request.noEnv ? { noEnv: true } : {}),
        },
        request.idempotencyKey,
      );
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
      if (request.harness === "codex" && options.beforePrompt) {
        await installNativeCwdWrapper(
          async (r) => {
            const result = await provider.exec(r);
            if (result.detached || result.exitCode !== 0)
              throw invalidRequest("Native MCP bridge installation failed.");
          },
          request.sandboxId,
          "codex",
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

    async getPrompt(request: { sandboxId: string; promptId: string }): Promise<PromptState> {
      const response = await call(() => api.promptRunStatus(request));
      const run = response.promptRun;
      const status = promptStatus(run?.status);
      if (!run || status === undefined) throw unexpectedAnswer("prompt status");
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
      const response = await call(() =>
        api.events({
          sandboxId: request.sandboxId,
          sort: "asc",
          ...(request.cursor ? { cursor: request.cursor } : {}),
          ...(request.conversationId ? { conversation: request.conversationId } : {}),
          ...(request.limit ? { limit: request.limit } : {}),
        }),
      );
      const raw = response.events ?? [];
      const last = raw.at(-1);
      const cursor = (last && eventCursor(last)) ?? response.pageInfo?.nextCursor ?? request.cursor;
      return {
        events: raw.map(normalizeEvent),
        ...(cursor ? { cursor } : {}),
        hasMore: response.pageInfo?.hasMore === true,
      };
    },

    async stop(request: { sandboxId: string }): Promise<void> {
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
