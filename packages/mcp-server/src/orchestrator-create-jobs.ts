import type { OrchestratorOperation } from "@armada/core";
import type { OrchestratorDiagnosticLog } from "./orchestrator-diagnostics.ts";
import { OrchestratorDiagnostics } from "./orchestrator-diagnostics.ts";
import type { OrchestratorRuntimeStore, RuntimeReservation } from "./orchestrator-runtime-store.ts";

/** A durable queue plus tracked execution, not a detached request continuation.
 * Only queued entries can be claimed. Running/fork-dispatched entries are never
 * reexecuted; lease expiry records uncertainty for explicit owner recovery. */
export class OrchestratorCreateJobs {
  private stopped = false;
  private claiming: Promise<boolean> | undefined;
  private readonly work = new Set<Promise<unknown>>();
  private readonly wakes = new Set<Promise<unknown>>();
  constructor(
    private readonly store: OrchestratorRuntimeStore,
    private readonly execute: (reservation: RuntimeReservation) => Promise<OrchestratorOperation>,
    private readonly log?: OrchestratorDiagnosticLog,
  ) {}

  wake(): void {
    if (this.stopped) return;
    const wake = (async () => {
      if (this.claiming) await this.claiming;
      if (!this.stopped) await this.reconcileOne();
    })();
    this.wakes.add(wake);
    void wake
      .catch((error) => new OrchestratorDiagnostics(this.log, "create").report("error", error))
      .finally(() => this.wakes.delete(wake));
  }
  reconcileOne(signal?: AbortSignal): Promise<boolean> {
    if (this.stopped || signal?.aborted || this.work.size > 0) return Promise.resolve(false);
    if (this.claiming) return this.claiming;
    const claim = (async () => {
      signal?.throwIfAborted();
      const reservation = await this.store.claimCreateJob();
      if (!reservation) {
        const revoked = await this.store.failRevokedQueuedCreate();
        const settled = revoked ?? (await this.store.reconcileExpiredCreateJob());
        if (!settled) return false;
        const diagnostics = new OrchestratorDiagnostics(this.log, "create");
        diagnostics.bind({ operationId: settled.id, orchestratorId: settled.orchestratorId });
        diagnostics.stage("create_reconciliation");
        diagnostics.report(
          settled.state === "failed" ? "failed" : "uncertain",
          undefined,
          revoked ? "create_authority_revoked" : "create_worker_interrupted",
        );
        return true;
      }
      const heartbeat = setInterval(() => {
        void this.store.renewCreateJob(reservation).catch(() => {});
      }, 30_000);
      heartbeat.unref();
      const task = this.execute(reservation)
        .catch(async (error) => {
          const diagnostics = new OrchestratorDiagnostics(this.log, "create");
          diagnostics.bind({
            operationId: reservation.operation.id,
            orchestratorId: reservation.identity.id,
            sandboxId: reservation.identity.sandboxId,
          });
          diagnostics.stage("failure_publication");
          diagnostics.report("uncertain", error);
          try {
            await this.store.markCreateUncertain(reservation);
          } catch (publicationError) {
            diagnostics.report("publication_failed", publicationError);
          }
        })
        .finally(() => {
          clearInterval(heartbeat);
          this.work.delete(task);
        });
      this.work.add(task);
      return true;
    })();
    this.claiming = claim;
    void claim
      .finally(() => {
        if (this.claiming === claim) this.claiming = undefined;
      })
      .catch(() => {});
    return claim;
  }
  stopAdmission(): void {
    this.stopped = true;
  }
  async drain(): Promise<void> {
    while (this.claiming || this.wakes.size || this.work.size)
      await Promise.allSettled([...(this.claiming ? [this.claiming] : []), ...this.wakes, ...this.work]);
  }
}
