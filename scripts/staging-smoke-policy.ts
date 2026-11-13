export const BOAT_STAGING_NOTICE = "boat: not part of the release gate";

/** Filter before validating unused Boat account/model/golden fields. Never infer provider from text. */
export function stagingSmokeCases(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("invalid_smoke_cases");
  return value.filter(
    (row) => !(typeof row === "object" && row !== null && "provider" in row && row.provider === "boat"),
  );
}

/** Conflicting or absent provider evidence cannot authorize automatic cleanup. */
export function smokeReceiptProvider(value: unknown): "boat" | "modal" | "docker" | undefined {
  const result = value as {
    sandbox?: { provider?: unknown };
    provider?: unknown;
    manifest?: { definition?: { provider?: unknown } };
  } | null;
  const providers = [result?.sandbox?.provider, result?.provider, result?.manifest?.definition?.provider].filter(
    (provider) => provider !== undefined,
  );
  const provider = providers[0];
  return (provider === "boat" || provider === "modal" || provider === "docker") &&
    providers.every((candidate) => candidate === provider)
    ? provider
    : undefined;
}
