import type {
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
import type { OrchestratorRuntimeFoundation, OrchestratorRuntimeTransport } from "./orchestrator-runtime-foundation.ts";
import {
  OrchestratorRuntimeError,
  type OrchestratorRuntimeStore,
  type RuntimeIdentity,
  type RuntimeReservation,
} from "./orchestrator-runtime-store.ts";
import { createOrchestratorTransport } from "./orchestrator-transport.ts";

/** Trusted server adapter: never populated from HTTP request fields or guest flags.
 * Each implementation needs operator-verified, version-bound native proof. */
export interface OrchestratorRuntimeBackend {
  provider: Provider;
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
  resumeWithoutText?: (identity: RuntimeIdentity) => Promise<void>;
  /** Requires committed native checkpoint plus durable event acknowledgement, not physical exit. */
  checkpointAndStop(identity: RuntimeIdentity): Promise<void>;
  /** Fresh fence before any effect, including membership/account changes during preparation. */
  revalidate(identity: RuntimeIdentity): Promise<void>;
}

export interface OrchestratorRuntimeOptions {
  store: OrchestratorRuntimeStore;
  authority: OrchestratorRuntimeFoundation["authority"];
  skillRevision: string;
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
  constructor(private readonly options: OrchestratorRuntimeOptions) {}

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

  async create(caller: Caller, configuration: OrchestratorCreate, key: string): Promise<OrchestratorOperation> {
    const ownerId = this.owner(caller, configuration.orgId);
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
    const ownerId = this.owner(caller, input.orgId);
    const identity = await this.options.store.read(ownerId, input.orgId, input.id);
    if (
      (input.action === "message" || input.action === "steer") &&
      (!input.text?.trim() || input.text.length > 100_000)
    )
      throw new OrchestratorRuntimeError("invalid_request");
    const backend = await this.options.resolveBackend(identity.configuration, ownerId, identity);
    await backend.assertNativeProof();
    if (input.action === "resume" && !backend.resumeWithoutText) throw new OrchestratorRuntimeError("unavailable");
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
      await backend.revalidate(current);
      if (input.action === "stop") {
        if (current.state === "stopped") return { parentState: "stopped" as const };
        // Admission is already closed by the pending receipt. Revoke before any checkpoint I/O.
        await this.options.authority.scrubBeforeCheckpoint(current.id, await this.transport(backend, current));
        await backend.checkpointAndStop(current);
        return { parentState: "stopped" as const };
      }
      if (input.action === "resume") {
        if (current.state === "ready") return { parentState: "ready" as const };
        if (current.state !== "stopped" || !current.conversationId || current.continuity !== "native")
          throw new OrchestratorRuntimeError("conflict");
        await this.options.authority.revoke(current.id);
        await backend.resumeWithoutText?.(current);
        const restored = await this.options.store.preparing(reservation);
        if (restored.conversationId !== current.conversationId) throw new OrchestratorRuntimeError("conflict");
        reservation.identity = restored;
        await this.configureAuthority(backend, restored);
        return { parentState: "ready" as const };
      }
      if (current.state !== "ready" || !current.providerSandboxId) throw new OrchestratorRuntimeError("conflict");
      const machine = await backend.provider.get(current.providerSandboxId);
      if (machine.state !== "ready" && machine.state !== "running") throw new OrchestratorRuntimeError("conflict");
      const configuration = current.configuration;
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
    }>,
  ): Promise<OrchestratorOperation> {
    try {
      const result = await effect();
      if (!(await this.options.store.complete(reservation, { state: "succeeded", ...result })))
        throw new OrchestratorRuntimeError("conflict");
      return { ...reservation.operation, state: "succeeded" };
    } catch {
      // Never retry ambiguous effects or leak raw provider/transport exceptions. Reconciliation
      // must inspect this exact receipt; a new request remains blocked by uncertain state.
      const published = await this.options.store.complete(reservation, {
        state: "uncertain",
        parentState: "blocked",
        errorCode: "runtime_uncertain",
      });
      if (!published) throw new OrchestratorRuntimeError("conflict");
      return { ...reservation.operation, state: "uncertain", errorCode: "runtime_uncertain" };
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
