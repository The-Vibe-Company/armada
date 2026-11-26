import { isHarness, ProviderError } from "@armada/core";
import type { Sql } from "@armada/core/server";
import { currentRequestId, recordOperatorFailure } from "./request-observability.ts";
import { type createRuntimeEnrolments, RuntimeEnrolmentDenied, type RuntimeTicketGuard } from "./runtime-enrolment.ts";
import { logRuntimeStage } from "./runtime-progress.ts";
import { runtimeWakes, waitForTimeout } from "./wake-bus.ts";

interface BootstrapInput {
  sandboxId: string;
  serverUrl: string;
  cacheDir: string;
  artifact: { sha256: string; bytes: number };
  enrolmentToken: string;
}
interface Ports {
  /** Bounded host transport; contains only the ticket and public install metadata. */
  bootstrap(input: BootstrapInput): Promise<void>;
  /** Agent bridge bound to this same persisted owner/logical sandbox. */
  health(signal: AbortSignal, epoch: string): Promise<{ runtime: "armada"; epoch: string }>;
}
const ENROL_FALLBACK_MS = 1_000;

interface StartupClock {
  now(): number;
  wait(signal: AbortSignal): Promise<void>;
}
const clock: StartupClock = {
  now: () => performance.now(),
  wait: (signal: AbortSignal) => waitForTimeout(ENROL_FALLBACK_MS, signal),
};

/** Fresh/quiescent sandbox only, under the existing exclusive launch/lifecycle lease.
 * The caller owns allocation cleanup on failure. Never retry a consumed ticket.
 */
export function createRuntimeStartup(
  authority: ReturnType<typeof createRuntimeEnrolments>,
  ports: Ports,
  time: StartupClock = clock,
) {
  return async (input: {
    ownerId: string;
    sandboxId: string;
    providerSandboxId: string;
    serverUrl: string;
    cacheDir: string;
    artifact: { sha256: string; bytes: number };
    configuration: Record<string, unknown>;
    commandGrantExpiresAt?: number;
    expectedGeneration?: number;
    assertClaim?: (tx?: Sql) => Promise<void>;
    ticketGuard?: RuntimeTicketGuard;
    signal?: AbortSignal;
    onEnrolled?: (epoch: string) => void;
    /** Readiness budget AFTER the bounded host bootstrap returns. */
    readinessTimeoutMs?: number;
  }): Promise<{ runtime: "armada"; epoch: string }> => {
    const timeout = input.readinessTimeoutMs ?? 90_000;
    if (
      !isHarness(input.configuration.selectedHarness) ||
      !Number.isSafeInteger(timeout) ||
      timeout < 1 ||
      timeout > 120_000
    )
      throw new ProviderError({
        provider: "boat",
        code: "invalid_request",
        message: "Invalid runtime startup selection.",
        retryable: false,
      });
    const { ownerId, sandboxId, providerSandboxId, serverUrl, cacheDir, signal } = input;
    const artifact = { ...input.artifact };
    let phase: "bootstrap" | "enrolment" | "readiness" = "bootstrap";
    let diagnosticPhase: "ticket" | "bootstrap" | "enrolment" | "readiness" = "ticket";
    let epoch = "0";
    const startedAt = time.now();
    const requestId = currentRequestId();
    const entering = (phase: typeof diagnosticPhase | "readiness_fence", at: number) => {
      try {
        console.info(
          JSON.stringify({
            event: "armada.runtime.startup_phase",
            requestId,
            sandboxId,
            epoch,
            phase,
            elapsedMs: at - startedAt,
          }),
        );
      } catch {}
    };
    let wake: ReturnType<typeof runtimeWakes.watch> | undefined;
    try {
      signal?.throwIfAborted();
      entering("ticket", startedAt);
      const ticket = await authority.issue({
        ownerId,
        sandboxId,
        expectedProviderSandboxId: providerSandboxId,
        configuration: input.configuration,
        ...(input.assertClaim ? { assertClaim: input.assertClaim } : {}),
        ...(input.ticketGuard ? { ticketGuard: input.ticketGuard } : {}),
        ...(input.expectedGeneration === undefined ? {} : { expectedGeneration: input.expectedGeneration }),
        ...(input.commandGrantExpiresAt !== undefined ? { commandGrantExpiresAt: input.commandGrantExpiresAt } : {}),
      });
      epoch = ticket.epoch;
      signal?.throwIfAborted();
      diagnosticPhase = "bootstrap";
      const bootstrapAt = time.now();
      entering("bootstrap", bootstrapAt);
      await input.assertClaim?.();
      signal?.throwIfAborted();
      wake = runtimeWakes.watch(`enrol:${sandboxId}`);
      await ports.bootstrap({
        sandboxId: providerSandboxId,
        serverUrl,
        cacheDir,
        artifact,
        enrolmentToken: ticket.enrolmentToken,
      });
      signal?.throwIfAborted();
      diagnosticPhase = phase = "enrolment";
      const bootstrapDoneAt = time.now();
      entering("enrolment", bootstrapDoneAt);
      const deadline = bootstrapDoneAt + timeout;
      const budget = AbortSignal.timeout(timeout);
      const admission = signal ? AbortSignal.any([signal, budget]) : budget;
      while (true) {
        admission.throwIfAborted();
        if (time.now() >= deadline) throw Error("runtime_startup_deadline");
        const enrolled = (
          await authority.query(
            `select 1 from public.runtime_enrolments
             where sandbox_id=$1 and lifecycle_generation=$2 and runtime_hash is not null`,
            [sandboxId, ticket.lifecycleGeneration],
          )
        ).rows.length;
        if (!enrolled) {
          await wake.wait(admission, ENROL_FALLBACK_MS, (_ms, waitSignal) => time.wait(waitSignal));
          continue;
        }
        let epoch: string;
        try {
          epoch = await authority.withOwner(
            sandboxId,
            ownerId,
            async (_tx, scope) => scope.epoch,
            ticket.lifecycleGeneration,
          );
        } catch (error) {
          // A freshly issued ticket deliberately has no live runtime grant yet.
          // All other failures are errors, not a reason to retry host startup.
          if (!(error instanceof RuntimeEnrolmentDenied)) throw error;
          await wake.wait(admission, ENROL_FALLBACK_MS, (_ms, waitSignal) => time.wait(waitSignal));
          continue;
        }
        if (epoch !== ticket.epoch) throw Error("runtime_startup_replaced");
        input.onEnrolled?.(epoch);
        diagnosticPhase = phase = "readiness";
        const enrolledAt = time.now();
        entering("readiness", enrolledAt);
        const ready = await ports.health(admission, ticket.epoch);
        admission.throwIfAborted();
        if (time.now() >= deadline || ready.runtime !== "armada" || ready.epoch !== ticket.epoch)
          throw Error("runtime_startup_wrong_health");
        entering("readiness_fence", time.now());
        // Do not publish a health response after stop/replacement while in flight.
        await authority.withOwner(
          sandboxId,
          ownerId,
          async (tx, scope) => {
            if (scope.epoch !== ticket.epoch) throw Error("runtime_startup_replaced");
            await input.assertClaim?.(tx);
          },
          ticket.lifecycleGeneration,
        );
        admission.throwIfAborted();
        const readyAt = time.now();
        if (readyAt >= deadline) throw Error("runtime_startup_deadline");
        try {
          console.info(
            JSON.stringify({
              event: "armada.runtime.startup_timing",
              sandboxId,
              epoch: ticket.epoch,
              stages: [
                { stage: "issue_ticket", ms: bootstrapAt - startedAt },
                { stage: "bootstrap", ms: bootstrapDoneAt - bootstrapAt },
                { stage: "enrolment_wait", ms: enrolledAt - bootstrapDoneAt },
                { stage: "health", ms: readyAt - enrolledAt },
              ],
            }),
          );
        } catch {}
        return { runtime: "armada", epoch: ticket.epoch };
      }
    } catch (error) {
      recordOperatorFailure(`runtime.startup.${diagnosticPhase}`, error, { sandboxId });
      logRuntimeStage({ sandboxId, epoch }, `startup_failed_${phase}`);
      throw new ProviderError({
        provider: "boat",
        code: "sandbox_not_ready",
        message: `Armada runtime startup failed (${phase}).`,
        retryable: false,
      });
    } finally {
      wake?.close();
    }
  };
}
