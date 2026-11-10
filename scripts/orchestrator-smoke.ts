/** Operator-only CLI smoke; never invoked by verify or CI. Allocates real compute.
 * ARMADA_TOKEN stays in the subprocess environment, never argv or the receipt.
 * Usage: bun scripts/orchestrator-smoke.ts https://origin org golden boat|modal claude|codex model account [repo]
 */
import type {
  OrchestratorDetail,
  OrchestratorEventPage,
  OrchestratorOperation,
} from "../packages/core/src/orchestrator.ts";

const runId = crypto.randomUUID();
let id: string | null = null;
let cursor: string | null = null;
let step = "validate";
const operations: { step: string; id: string; key: string }[] = [];
class SmokeFailure extends Error {}
function fail(code: string): never {
  throw new SmokeFailure(code);
}

async function main() {
  const [address = "", org = "", golden = "", provider = "", harness = "", model = "", account = "", repo, ...extra] =
    Bun.argv.slice(2);
  if (
    !address ||
    !org ||
    !golden ||
    !["boat", "modal"].includes(provider) ||
    !harness ||
    !model ||
    !account ||
    !["claude", "codex"].includes(harness) ||
    extra.length
  )
    fail("usage_origin_org_golden_provider_harness_model_account_optional_repo");
  const origin = new URL(address);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    fail("https_origin_required");
  if (!process.env.ARMADA_TOKEN) fail("ARMADA_TOKEN_required");
  if (process.env.ARMADA_ORCHESTRATOR_SMOKE !== "create_real_compute") fail("explicit_compute_opt_in_required");
  const deadline = Date.now() + 15 * 60_000;
  async function cli<T>(args: string[]): Promise<T> {
    if (Date.now() >= deadline) fail("smoke_deadline_exceeded");
    const child = Bun.spawn([process.env.ARMADA_BIN ?? "armada", "orchestrator", ...args, "--json"], {
      env: { ...process.env, ARMADA_URL: origin.origin },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), Math.min(60_000, deadline - Date.now()));
    try {
      // Drain both streams, but do not emit diagnostics that might contain secrets.
      const [output, , code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) fail("cli_failed_no_automatic_mutation_retry");
      const value = JSON.parse(output);
      if (value?.version !== 1) fail("unsupported_response");
      return value as T;
    } finally {
      clearTimeout(timer);
    }
  }
  const detail = () => cli<OrchestratorDetail>(["detail", id ?? fail("missing_id"), "--org", org]);
  async function settle(operation: OrchestratorOperation, state: "ready" | "stopped") {
    if (operation.state === "failed" || operation.state === "uncertain") fail("operation_not_successful");
    for (;;) {
      const current = await detail();
      const receipt = current.operations.find((item) => item.id === operation.id);
      if (receipt?.state === "failed" || receipt?.state === "uncertain") fail("operation_not_successful");
      if (current.orchestrator.state === "blocked") fail("orchestrator_blocked");
      if (receipt?.state === "succeeded" && current.orchestrator.state === state) return current;
      await Bun.sleep(1000);
    }
  }
  async function mutate(action: "send" | "stop" | "resume", text?: string) {
    step = action;
    const current = await detail();
    const key = `${runId}-${operations.length}-${action}`;
    // Retain key before dispatch: a lost response must not provoke a fresh-key retry.
    const record = { step, id: "", key };
    operations.push(record);
    const receipt = await cli<OrchestratorOperation>([
      action,
      id ?? fail("missing_id"),
      ...(text === undefined ? [] : [text]),
      "--org",
      org,
      "--expected-revision",
      String(current.orchestrator.revision),
      "--idempotency-key",
      key,
    ]);
    record.id = receipt.id;
    return receipt;
  }
  step = "capabilities";
  const capabilities = await cli<{
    version: 1;
    enabled: boolean;
    pairs?: { provider: string; harness: string; enabled: boolean }[];
  }>(["capabilities"]);
  if (
    !capabilities.enabled ||
    !capabilities.pairs?.some((pair) => pair.provider === provider && pair.harness === harness && pair.enabled)
  )
    fail("selected_pair_disabled");
  step = "create";
  const key = `${runId}-create`;
  const record = { step, id: "", key };
  operations.push(record);
  const create = await cli<OrchestratorOperation>([
    "create",
    `smoke-${runId}`,
    "--org",
    org,
    "--golden",
    golden,
    "--provider",
    provider,
    "--agent",
    harness,
    "--model",
    model,
    "--model-account",
    account,
    ...(repo === undefined ? [] : ["--repo", repo]),
    "--idempotency-key",
    key,
  ]);
  id = create.orchestratorId;
  record.id = create.id;
  await settle(create, "ready");
  const marker = `SMOKE_${runId}`;
  await settle(await mutate("send", `Reply with exactly ${marker} and do not use tools.`), "ready");
  step = "events_until_settled";
  let matched = false;
  let finished = false;
  const messages = new Map<string, string>();
  const seen = new Set<string>();
  for (;;) {
    const page = await cli<OrchestratorEventPage>([
      "events",
      id,
      "--org",
      org,
      ...(cursor === null ? [] : ["--cursor", cursor]),
    ]);
    for (const item of page.events) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      if (item.kind !== "agent") continue;
      const event = item.event;
      if (event.kind === "message") {
        const identity = event.messageId ?? event.promptId ?? "assistant";
        const text = event.textMode === "delta" ? (messages.get(identity) ?? "") + event.text : event.text;
        messages.set(identity, text);
        if (text.includes(marker)) matched = true;
      }
      if (event.kind === "prompt" && (event.status === "failed" || event.status === "interrupted"))
        fail("native_turn_failed");
      if (event.kind === "prompt" && event.status === "finished") finished = true;
    }
    if (page.hasMore && (page.cursor === null || page.cursor === cursor)) fail("cursor_not_advancing");
    cursor = page.cursor ?? cursor;
    if (!page.hasMore && matched && finished) break;
    await Bun.sleep(1000);
  }
  await settle(await mutate("stop"), "stopped");
  const before = (await detail()).orchestrator;
  const resumed = (await settle(await mutate("resume"), "ready")).orchestrator;
  if (
    !before.conversationId ||
    resumed.conversationId !== before.conversationId ||
    resumed.sandboxId !== before.sandboxId ||
    resumed.continuity !== (provider === "boat" ? "unverified" : "native")
  )
    fail(provider === "boat" ? "unexpected_continuity_or_identity" : "native_continuity_not_verified");
  await settle(await mutate("stop"), "stopped");
  step = "complete";
}

try {
  await main();
  console.log(JSON.stringify({ pass: true, runId, orchestratorId: id, cursor, operations }));
} catch (error) {
  console.log(
    JSON.stringify({
      pass: false,
      runId,
      step,
      orchestratorId: id,
      cursor,
      operations,
      reason: error instanceof SmokeFailure ? error.message : "invalid_input_or_unavailable",
      recovery:
        "Do not rerun blindly. Inspect detail and reconcile original keys; compute may remain running. No automatic delete or mutation retry was attempted.",
    }),
  );
  process.exitCode = 1;
}
