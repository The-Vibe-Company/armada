/** Read-only probe of the public production API, independent of compute smoke configuration. */
export async function checkProductionHealth(origin: string) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("Production health origin must be an explicit HTTPS origin");
  const response = await fetch(new URL("/healthz", url), {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { "cache-control": "no-cache" },
  });
  if (!response.ok) throw new Error("Production health returned a non-success status");
  const body = await response.json();
  if (body?.ok !== true || typeof body.version !== "string" || !body.version)
    throw new Error("Production health response is not Armada readiness");
}

if (import.meta.main) {
  try {
    await checkProductionHealth(process.env.ARMADA_PRODUCTION_ORIGIN ?? "");
    console.log("Production Armada readiness passed");
  } catch {
    console.error(
      "::error::Production Armada readiness failed (or origin missing); investigate production immediately.",
    );
    process.exitCode = 1;
  }
}
