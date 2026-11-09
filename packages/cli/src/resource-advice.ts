import type { ResourceAdvice } from "@armada/core";

/** Only positive, sufficiently supported advice earns space in human output. */
export function resourceAdviceText(advice: ResourceAdvice): string | null {
  if (
    advice.version !== 1 ||
    advice.confidence !== "moderate" ||
    advice.reason !== "headroom_observed" ||
    !advice.recommendedSize ||
    advice.window.sufficient < 1 ||
    advice.window.maxSessions !== 10 ||
    !advice.window.from ||
    !advice.window.to
  )
    return null;
  const observations = advice.observations;
  const measured = [
    observations.cpuPeakBusyCores === null ? null : `CPU peak ${observations.cpuPeakBusyCores.toFixed(2)} busy cores`,
    observations.memoryPeakBytes === null
      ? null
      : `memory peak ${Math.ceil(observations.memoryPeakBytes / 1024 / 1024)} MiB`,
  ].filter((value) => value !== null);
  return [
    `Resource recommendation: ${advice.recommendedSize} for future launches (headroom observed; ${advice.confidence} confidence).`,
    `${advice.window.sufficient}/${advice.window.considered} comparable sessions in the last-10 window ${advice.window.from}–${advice.window.to}; ${measured.join(", ") || "see measured evidence in the advice JSON"}.`,
    "No running machine or default was changed.",
  ].join("\n");
}

/** Optional launch guidance is bounded and fail-open, including rolling older servers. */
export async function printOptionalResourceAdvice(
  client: import("./armada-api.ts").ArmadaApiClient,
  id: string,
  org: string | undefined,
  err: (text: string) => void,
): Promise<void> {
  try {
    const { advice } = await client.request<import("@armada/core").ResourceAdviceResponse>("/api/v1/sandbox/advice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id,
        ...(org === undefined ? {} : { org }),
      } satisfies import("@armada/core").ResourceAdviceRequest),
      signal: AbortSignal.timeout(2_000),
    });
    const text = resourceAdviceText(advice);
    if (text) err(`${text}\n`);
  } catch {
    // Telemetry is not required for successful launch/status; no recurring missing-data warnings.
  }
}
