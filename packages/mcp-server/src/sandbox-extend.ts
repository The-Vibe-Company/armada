import {
  PROVIDER_LIMITS,
  type Provider,
  ProviderError,
  SANDBOX_STOP_MARGIN_SECONDS,
  type SandboxRecord,
  type SandboxStore,
  sandboxActivity,
} from "@armada/core/server";

/** Caller resolves owner/admin interior access (or scoped own-child authority) before entry. */
export async function extendSandbox(
  store: SandboxStore,
  sandbox: SandboxRecord,
  provider: Provider,
  ttlSeconds: number,
  renewLeases?: () => Promise<void>,
) {
  const max = PROVIDER_LIMITS[sandbox.provider].maxTtlSeconds - SANDBOX_STOP_MARGIN_SECONDS;
  const refuse = (message: string): never => {
    throw new ProviderError({ provider: provider.id, code: "invalid_request", retryable: false, message });
  };
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > max)
    refuse(`TTL must be a whole number of seconds from 1 to ${max}.`);
  if (!["ready", "running"].includes(sandbox.status)) refuse("Only running or idle sandboxes can be extended.");
  if (!provider.extendLifetime) refuse("Provider does not support lifetime extension.");
  const requested = new Date(Date.now() + ttlSeconds * 1000);
  if (sandbox.expiresAt && requested.getTime() <= new Date(sandbox.expiresAt).getTime())
    refuse("The requested deadline must extend the existing lifetime.");
  const result = await sandboxActivity(store, sandbox, {}, async (signal) => {
    signal.throwIfAborted();
    const hard = await provider.extendLifetime!({
      sandboxId: sandbox.providerSandboxId,
      ttlSeconds: ttlSeconds + SANDBOX_STOP_MARGIN_SECONDS,
    });
    signal.throwIfAborted();
    if (!Number.isFinite(hard.getTime()) || hard.getTime() < requested.getTime() + SANDBOX_STOP_MARGIN_SECONDS * 1000) {
      // A capped PATCH may have shortened the old physical deadline. Never leave a
      // later SQL deadline behind or retain an activity lease that blocks preservation.
      const unsafe =
        !Number.isFinite(hard.getTime()) ||
        !sandbox.expiresAt ||
        hard.getTime() < new Date(sandbox.expiresAt).getTime() + SANDBOX_STOP_MARGIN_SECONDS * 1000;
      return {
        result: null,
        patch: unsafe
          ? {
              status: "stopping" as const,
              statusReason: "expired",
              expiresAt: new Date().toISOString(),
              stopRequested: true,
            }
          : {},
      };
    }
    await renewLeases?.();
    const expiresAt = requested.toISOString();
    return { result: { id: sandbox.id, expiresAt, ttlSeconds }, patch: { expiresAt, effectiveTtlSeconds: ttlSeconds } };
  });
  if (result === null)
    return refuse(
      "Provider could not confirm the requested lifetime; an unsafe shortened lifetime is scheduled for preservation and stop. Refresh status.",
    );
  return result;
}
