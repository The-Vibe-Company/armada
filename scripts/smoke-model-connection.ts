/** Private staging smoke. Runner access comes from stdin, never argv or logs. */
async function main() {
  if (process.env.ARMADA_MODEL_CONNECTION_SMOKE !== "use_staging_runner") throw Error("smoke_not_enabled");
  const input = JSON.parse(await Bun.stdin.text());
  for (const key of ["url", "connectToken", "grant", "sandboxId", "model"])
    if (typeof input[key] !== "string" || !input[key]) throw Error("invalid_smoke_configuration");
  if (!["codex", "claude"].includes(input.harness)) throw Error("invalid_smoke_configuration");
  const url = new URL(input.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search)
    throw Error("invalid_smoke_configuration");
  const requestId = crypto.randomUUID();
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.connectToken}`,
      "x-armada-runner-grant": input.grant,
    },
    body: JSON.stringify({
      version: 1,
      requestId,
      sandboxId: input.sandboxId,
      op: "testModelConnection",
      harness: input.harness,
      model: input.model,
    }),
  });
  if (!response.ok) throw Error("runner_refused_test");
  const envelope = (await response.json()) as { version?: unknown; requestId?: unknown; result?: { ok?: unknown } };
  if (envelope.version !== 1 || envelope.requestId !== requestId || typeof envelope.result?.ok !== "boolean")
    throw Error("invalid_runner_response");
  // Do not dump envelopes, errors, headers or access configuration in smoke output.
  if (envelope.result.ok) console.log("MODEL_CONNECTION_OK");
  else throw Error("model_connection_test_failed");
}
if (import.meta.main)
  void main().catch(() => {
    console.error("MODEL_CONNECTION_SMOKE_FAILED");
    process.exitCode = 1;
  });
