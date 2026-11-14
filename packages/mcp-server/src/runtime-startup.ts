import { setTimeout as delay } from "node:timers/promises";
import { isHarness, ProviderError } from "@armada/core";
import { type createRuntimeEnrolments, RuntimeEnrolmentDenied } from "./runtime-enrolment.ts";
import { logRuntimeStage } from "./runtime-progress.ts";

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
  health(signal: AbortSignal): Promise<{ runtime: "armada"; epoch: string }>;
}
interface StartupClock {
  now(): number;
  wait(signal: AbortSignal): Promise<void>;
}
const clock: StartupClock = {
  now: () => Date.now(),
  wait: (signal: AbortSignal) => delay(250, undefined, { signal }),
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
    signal?: AbortSignal;
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
    let epoch = "0";
    try {
      signal?.throwIfAborted();
      const ticket = await authority.issue({ ownerId, sandboxId, configuration: input.configuration });
      epoch = ticket.epoch;
      signal?.throwIfAborted();
      await ports.bootstrap({
        sandboxId: providerSandboxId,
        serverUrl,
        cacheDir,
        artifact,
        enrolmentToken: ticket.enrolmentToken,
      });
      signal?.throwIfAborted();
      phase = "enrolment";
      const deadline = time.now() + timeout;
      const budget = AbortSignal.timeout(timeout);
      const admission = signal ? AbortSignal.any([signal, budget]) : budget;
      while (true) {
        admission.throwIfAborted();
        if (time.now() >= deadline) throw Error("runtime_startup_deadline");
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
          await time.wait(admission);
          continue;
        }
        if (epoch !== ticket.epoch) throw Error("runtime_startup_replaced");
        phase = "readiness";
        const ready = await ports.health(admission);
        admission.throwIfAborted();
        if (time.now() >= deadline || ready.runtime !== "armada" || ready.epoch !== ticket.epoch)
          throw Error("runtime_startup_wrong_health");
        // Do not publish a health response after stop/replacement while in flight.
        await authority.withOwner(
          sandboxId,
          ownerId,
          async (_tx, scope) => {
            if (scope.epoch !== ticket.epoch) throw Error("runtime_startup_replaced");
          },
          ticket.lifecycleGeneration,
        );
        admission.throwIfAborted();
        if (time.now() >= deadline) throw Error("runtime_startup_deadline");
        return { runtime: "armada", epoch: ticket.epoch };
      }
    } catch {
      logRuntimeStage({ sandboxId, epoch }, `startup_failed_${phase}`);
      // Bootstrap/configuration/transport diagnostics may contain credentials.
      throw new ProviderError({
        provider: "boat",
        code: "sandbox_not_ready",
        message: `Armada runtime startup failed (${phase}).`,
        retryable: false,
      });
    }
  };
}
