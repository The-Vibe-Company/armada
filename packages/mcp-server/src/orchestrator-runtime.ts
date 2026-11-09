import type {
  ModelChoice,
  Orchestrator,
  OrchestratorCreate,
  OrchestratorDetail,
  OrchestratorEventPage,
  OrchestratorList,
  OrchestratorOperation,
  Provider,
} from "@armada/core";
import type { Caller } from "./caller.ts";
import { bootstrapOrchestrator } from "./orchestrator-bootstrap.ts";
import { createManagedOrchestratorRuntime } from "./orchestrator-managed-runtime.ts";
import type { OrchestratorRuntimeFoundation, OrchestratorRuntimeTransport } from "./orchestrator-runtime-foundation.ts";
import {
  OrchestratorRuntimeError,
  type OrchestratorRuntimeStore,
  type RuntimeIdentity,
  type RuntimeReservation,
} from "./orchestrator-runtime-store.ts";
import { createOrchestratorTransport } from "./orchestrator-transport.ts";

class NativeContinuityLost extends Error {}

/** Trusted server adapter: never populated from HTTP request fields or guest flags.
 * Each implementation needs operator-verified, version-bound native proof. */
export interface OrchestratorRuntimeBackend {
  provider: Provider;
  /** Persisted launch choice, never a new default selected on a later turn. */
  selection?: ModelChoice;
  projectDir: string;
  /** Trusted server broker URL, never accepted from owner request or prompt text. */
  mcpUrl: string;
  /** Actual owner-approved #673 consent, resolved with #603 accounts independently
   * of the parent harness. Never inferred from all owner accounts or a guest payload. */
  consent: Parameters<OrchestratorRuntimeFoundation["authority"]["installEpoch"]>[2];
  assertNativeProof(): Promise<void>;
  /** Reuses launchSandbox with private insertion/managed-parent binding in one SQL transaction.
   * Must pass the durable operation ID as provider fork idempotency/correlation key. */
  launch(reservation: RuntimeReservation): Promise<void>;
  /** Provider-native, no synthetic prompt. Absent means resume is unavailable. */
  resumeWithoutText?: (identity: RuntimeIdentity, operationId: string) => Promise<void>;
  /** Fresh fence before any effect, including membership/account changes during preparation. */
  revalidate(identity: RuntimeIdentity): Promise<void>;
}

export interface OrchestratorRuntimeOptions {
  store: OrchestratorRuntimeStore;
  authority: OrchestratorRuntimeFoundation["authority"];
  skillRevision: string;
  /** Trusted removed-owner cleanup lane; no user/model credential resolution. */
  managed?: Pick<Parameters<typeof createManagedOrchestratorRuntime>[0], "sql" | "resolveManaged">;
  /** Actual #663 lifecycle projection; absence is unavailable, never invented empty waits. */
  lifecycleDetail?: (
    ownerId: string,
    orgId: string,
    id: string,
  ) => Promise<Pick<OrchestratorDetail, "waits" | "delegation" | "childSandboxIds">>;
  /** Actual named-account/provider/golden/sizing authorization; no legacy account fallback. */
  resolveBackend(
    configuration: OrchestratorCreate,
    ownerId: string,
    identity?: RuntimeIdentity,
  ): Promise<OrchestratorRuntimeBackend>;
}

/** One owner policy surface for HTTP and MCP. Construction alone never enables a provider. */
export class OrchestratorRuntime {
  readonly lifecycleRuntime: ReturnType<typeof createManagedOrchestratorRuntime> | undefined;
  constructor(private readonly options: OrchestratorRuntimeOptions) {
    this.lifecycleRuntime = options.managed
      ? createManagedOrchestratorRuntime({ ...options.managed, authority: options.authority })
      : undefined;
  }

  private owner(caller: Caller, orgId: string): string {
    if (!caller.orgs.some((org) => org.orgId === orgId)) throw new OrchestratorRuntimeError("not_found");
    return caller.userId;
  }

  async list(caller: Caller, orgId: string, cursor?: string, limit?: number): Promise<OrchestratorList> {
    const page = await this.options.store.list(this.owner(caller, orgId), orgId, cursor, limit);
    return { version: 1, items: page.items.map(wireOrchestrator), cursor: page.cursor };
  }
  async detail(caller: Caller, orgId: string, id: string): Promise<OrchestratorDetail> {
    const ownerId = this.owner(caller, orgId);
    const identity = await this.options.store.read(ownerId, orgId, id);
    if (!this.options.lifecycleDetail) throw new OrchestratorRuntimeError("unavailable");
    const lifecycle = await this.options.lifecycleDetail(ownerId, orgId, id);
    return {
      version: 1,
      orchestrator: wireOrchestrator(identity),
      operations: await this.options.store.operations(ownerId, orgId, id),
      ...lifecycle,
    };
  }
  async events(
    caller: Caller,
    orgId: string,
    id: string,
    cursor?: string,
    limit?: number,
  ): Promise<OrchestratorEventPage> {
    const identity = await this.options.store.read(this.owner(caller, orgId), orgId, id);
    // Validate owner-scoped reconnect cursor before any upstream read.
    await this.options.store.events(identity.ownerId, orgId, id, cursor, limit);
    // Stopped history never contacts a provider or activates compute.
    if (identity.state === "ready" && identity.conversationId && identity.providerSandboxId) {
      const backend = await this.options.resolveBackend(identity.configuration, identity.ownerId, identity);
      await backend.assertNativeProof();
      const upstream = await this.options.store.providerCursor(identity);
      const page = await backend.provider.events({
        sandboxId: identity.providerSandboxId,
        conversationId: identity.conversationId,
        limit: 500,
        ...(upstream ? { cursor: upstream } : {}),
      });
      if (!(await this.options.store.appendEvents(identity, page, upstream)))
        throw new OrchestratorRuntimeError("conflict");
    }
    return this.options.store.events(identity.ownerId, orgId, id, cursor, limit);
  }

  async reconcile(
    caller: Caller,
    input: {
      orgId: string;
      action: OrchestratorOperation["kind"];
      key: string;
      id?: string;
      expectedRevision?: number;
      text?: string;
      configuration?: OrchestratorCreate;
    },
  ) {
    if (input.action === "create" && (!input.configuration || input.configuration.orgId !== input.orgId))
      throw new OrchestratorRuntimeError("invalid_request");
    const operation = await this.options.store.lookupRequest({
      ownerId: this.owner(caller, input.orgId),
      orgId: input.orgId,
      action: input.action,
      key: input.key,
      ...(input.id ? { id: input.id } : {}),
      ...(input.action === "create"
        ? { configuration: input.configuration! }
        : {
            payload: {
              expectedRevision: input.expectedRevision,
              ...(input.text === undefined ? {} : { text: input.text }),
            },
          }),
    });
    return { version: 1, admission: operation ? "recorded" : "unknown", operation };
  }

  async create(caller: Caller, configuration: OrchestratorCreate, key: string): Promise<OrchestratorOperation> {
    if (!this.lifecycleRuntime) throw new OrchestratorRuntimeError("unavailable");
    const ownerId = this.owner(caller, configuration.orgId);
    const prior = await this.options.store.lookupRequest({
      ownerId,
      orgId: configuration.orgId,
      action: "create",
      key,
      configuration,
    });
    if (prior) return prior;
    const backend = await this.options.resolveBackend(configuration, ownerId);
    await backend.assertNativeProof();
    const reservation = await this.options.store.create({
      ownerId,
      configuration,
      key,
      skillRevision: this.options.skillRevision,
    });
    if (!reservation.fresh) return reservation.operation;
    return this.execute(reservation, async () => {
      await backend.revalidate(reservation.identity);
      await backend.launch(reservation);
      const identity = await this.options.store.preparing(reservation);
      reservation.identity = identity;
      await this.prepare(backend, identity);
      return { parentState: "ready" as const };
    });
  }

  async mutate(
    caller: Caller,
    input: {
      orgId: string;
      id: string;
      action: "message" | "steer" | "stop" | "resume";
      key: string;
      expectedRevision: number;
      text?: string;
    },
  ): Promise<OrchestratorOperation> {
    if (input.action === "resume" && !this.lifecycleRuntime) throw new OrchestratorRuntimeError("unavailable");
    const ownerId = this.owner(caller, input.orgId);
    const identity = await this.options.store.read(ownerId, input.orgId, input.id);
    if (
      (input.action === "message" || input.action === "steer") &&
      (!input.text?.trim() || input.text.length > 100_000)
    )
      throw new OrchestratorRuntimeError("invalid_request");
    const prior = await this.options.store.lookupRequest({
      ownerId,
      orgId: input.orgId,
      id: input.id,
      action: input.action,
      key: input.key,
      payload: { expectedRevision: input.expectedRevision, ...(input.text === undefined ? {} : { text: input.text }) },
    });
    if (prior) return prior;
    const backend =
      input.action === "stop"
        ? undefined
        : await this.options.resolveBackend(identity.configuration, ownerId, identity);
    if (backend) await backend.assertNativeProof();
    if (input.action === "stop" && identity.state !== "stopped" && !this.lifecycleRuntime)
      throw new OrchestratorRuntimeError("unavailable");
    if (input.action === "resume" && !backend?.resumeWithoutText) throw new OrchestratorRuntimeError("unavailable");
    const reservation = await this.options.store.reserve({
      ownerId,
      orgId: input.orgId,
      id: input.id,
      action: input.action,
      key: input.key,
      expectedRevision: input.expectedRevision,
      payload: { expectedRevision: input.expectedRevision, ...(input.text === undefined ? {} : { text: input.text }) },
    });
    if (!reservation.fresh) return reservation.operation;
    return this.execute(reservation, async () => {
      const current = reservation.identity;
      if (input.action === "stop") {
        if (current.state === "stopped") return { parentState: "stopped" as const };
        if (!this.lifecycleRuntime || !current.sandboxId || !current.providerSandboxId || current.generation === null)
          throw new OrchestratorRuntimeError("unavailable");
        const stopped = await this.lifecycleRuntime.stopOwner(
          {
            orchestratorId: current.id,
            sandboxId: current.sandboxId,
            providerSandboxId: current.providerSandboxId,
            generation: String(current.generation),
          },
          reservation.operation.id,
        );
        if (
          stopped.operationId !== reservation.operation.id ||
          stopped.orchestratorId !== current.id ||
          stopped.sandboxId !== current.sandboxId ||
          stopped.providerSandboxId !== current.providerSandboxId ||
          stopped.generation !== String(current.generation)
        )
          throw new OrchestratorRuntimeError("unavailable");
        if (stopped.continuity === "lost") throw new NativeContinuityLost();
        if (stopped.state !== "stopped" || (stopped.continuity !== "native" && current.conversationId !== null))
          throw new OrchestratorRuntimeError("unavailable");
        return {
          parentState: "stopped" as const,
          continuity: stopped.continuity === "native" ? ("native" as const) : ("unverified" as const),
        };
      }
      if (!backend) throw new OrchestratorRuntimeError("unavailable");
      await backend.revalidate(current);
      if (input.action === "resume") {
        if (current.state === "ready") return { parentState: "ready" as const };
        if (current.state !== "stopped" || !current.conversationId || current.continuity !== "native")
          throw new OrchestratorRuntimeError("conflict");
        await this.options.authority.revoke(current.id);
        await backend.resumeWithoutText?.(current, reservation.operation.id);
        const restored = await this.options.store.preparing(reservation);
        if (restored.conversationId !== current.conversationId) throw new OrchestratorRuntimeError("conflict");
        reservation.identity = restored;
        await this.configureAuthority(backend, restored);
        return { parentState: "ready" as const };
      }
      if (current.state !== "ready" || !current.providerSandboxId) throw new OrchestratorRuntimeError("conflict");
      const machine = await backend.provider.get(current.providerSandboxId);
      if (machine.state !== "ready" && machine.state !== "running") throw new OrchestratorRuntimeError("conflict");
      const configuration = { ...current.configuration, ...backend.selection };
      const receipt =
        input.action === "steer"
          ? await backend.provider.steer({
              sandboxId: current.providerSandboxId,
              text: input.text ?? "",
              ...(current.conversationId ? { conversationId: current.conversationId } : {}),
            })
          : await backend.provider.prompt({
              sandboxId: current.providerSandboxId,
              harness: configuration.harness,
              text: input.text ?? "",
              model: configuration.model,
              ...(configuration.reasoningEffort ? { reasoningEffort: configuration.reasoningEffort } : {}),
              ...(current.conversationId ? { conversationId: current.conversationId } : {}),
            });
      return { conversationId: receipt.conversationId };
    });
  }

  private async prepare(backend: OrchestratorRuntimeBackend, identity: RuntimeIdentity): Promise<void> {
    if (!identity.providerSandboxId) throw new OrchestratorRuntimeError("unavailable");
    await bootstrapOrchestrator(backend.provider, {
      sandboxId: identity.providerSandboxId,
      projectDir: backend.projectDir,
      skillRevision: identity.skillRevision,
      configureAuthority: () => this.configureAuthority(backend, identity),
    });
  }

  private async transport(
    backend: OrchestratorRuntimeBackend,
    identity: RuntimeIdentity,
  ): Promise<OrchestratorRuntimeTransport> {
    if (!identity.providerSandboxId) throw new OrchestratorRuntimeError("unavailable");
    const machine = await backend.provider.get(identity.providerSandboxId);
    if (!machine.physicalGeneration) throw new OrchestratorRuntimeError("unavailable");
    return createOrchestratorTransport({
      provider: backend.provider,
      providerSandboxId: identity.providerSandboxId,
      physicalGeneration: machine.physicalGeneration,
      lifecycleGeneration: String(identity.generation),
      mcpUrl: backend.mcpUrl,
    });
  }

  private async configureAuthority(backend: OrchestratorRuntimeBackend, identity: RuntimeIdentity): Promise<void> {
    await backend.revalidate(identity);
    await this.options.authority.installEpoch(identity.id, await this.transport(backend, identity), backend.consent);
  }

  private async execute(
    reservation: RuntimeReservation,
    effect: () => Promise<{
      parentState?: "ready" | "stopped";
      conversationId?: string;
      continuity?: "native" | "unverified";
    }>,
  ): Promise<OrchestratorOperation> {
    try {
      const result = await effect();
      if (!(await this.options.store.complete(reservation, { state: "succeeded", ...result })))
        throw new OrchestratorRuntimeError("conflict");
      return { ...reservation.operation, state: "succeeded" };
    } catch (error) {
      const lost = error instanceof NativeContinuityLost;
      const state = lost ? ("failed" as const) : ("uncertain" as const);
      const errorCode = lost ? "native_continuity_lost" : "runtime_uncertain";
      // Never retry ambiguous effects or leak raw provider/transport exceptions. Reconciliation
      // must inspect this exact receipt; a new request remains blocked by uncertain state.
      const published = await this.options.store.complete(reservation, {
        state,
        parentState: "blocked",
        errorCode,
        ...(lost
          ? { continuity: "lost" as const }
          : ["stop", "resume"].includes(reservation.operation.kind)
            ? { continuity: reservation.identity.continuity === "lost" ? ("lost" as const) : ("unverified" as const) }
            : {}),
      });
      if (!published) throw new OrchestratorRuntimeError("conflict", "unknown", reservation.operation);
      return { ...reservation.operation, state, errorCode };
    }
  }
}

function wireOrchestrator(identity: RuntimeIdentity): Orchestrator {
  return {
    version: 1,
    id: identity.id,
    ownerId: identity.ownerId,
    configuration: identity.configuration,
    state: identity.state,
    revision: identity.revision,
    sandboxId: identity.sandboxId,
    conversationId: identity.conversationId,
    continuity: identity.continuity,
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
    lastActivityAt: identity.lastActivityAt,
    idleDeadline: identity.idleDeadline,
    skillRevision: identity.skillRevision,
    blockedReason: identity.blockedReason,
  };
}
