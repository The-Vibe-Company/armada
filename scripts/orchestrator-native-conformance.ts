/** OPERATOR-ONLY postflight on a NEW owned nonproduction fixture. Never run in CI/default tests.
 * Requires prior operator-reviewed SDK/native/private-state proof; API history is NOT that proof.
 * No allocation, deletion, provider credentials, automatic fixture cleanup, or app-ID fallback. */
import type {
  OrchestratorDetail,
  OrchestratorEventPage,
  OrchestratorOperation,
} from "../packages/core/src/orchestrator.ts";

interface Fixture {
  origin: string;
  orgId: string;
  ownerId: string;
  orchestratorId: string;
  childId: string;
  provider: "boat" | "modal";
  harness: "claude" | "codex";
  createdAfter: string;
  environment: "nonproduction";
  nativeProofReviewed: true;
  probeToolName: string;
}
const OPT_IN = "operator_verified_new_owned_nonproduction_fixture";
class NativeConformanceFailure extends Error {
  constructor(readonly code: string) {
    super("Native conformance did not pass.");
  }
}
function fail(code: string): never {
  throw new NativeConformanceFailure(code);
}

async function main() {
  if (process.env.ARMADA_ORCHESTRATOR_NATIVE_CONFORMANCE !== OPT_IN) fail("native_conformance_not_enabled");
  const token = process.env.ARMADA_TOKEN;
  const path = Bun.argv[2];
  if (!token || !path || !process.env.ARMADA_CONFORMANCE_ORIGIN) fail("operator_fixture_and_owner_session_required");
  const file = Bun.file(path);
  if ((await file.size) > 16384) fail("invalid_operator_fixture");
  const fixture = JSON.parse(await file.text()) as Fixture;
  const origin = new URL(fixture.origin);
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const createdAfter = Date.parse(fixture.createdAfter);
  if (
    fixture.environment !== "nonproduction" ||
    fixture.nativeProofReviewed !== true ||
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.origin !== process.env.ARMADA_CONFORMANCE_ORIGIN ||
    ![fixture.orgId, fixture.ownerId, fixture.orchestratorId, fixture.childId].every(
      (id) => typeof id === "string" && uuid.test(id),
    ) ||
    !["boat", "modal"].includes(fixture.provider) ||
    !["claude", "codex"].includes(fixture.harness) ||
    !/^[a-zA-Z0-9_.:-]{1,160}$/.test(fixture.probeToolName) ||
    !Number.isFinite(createdAfter) ||
    createdAfter > Date.now() ||
    Date.now() - createdAfter > 3600_000
  )
    fail("invalid_or_stale_operator_fixture");

  async function api<T>(suffix: string, body?: unknown, key?: string): Promise<T> {
    const url = new URL(`/api/v1/orchestrators${suffix}`, origin);
    url.searchParams.set("orgId", fixture.orgId);
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) fail("native_conformance_api_refused_no_passing_proof");
    return response.json() as Promise<T>;
  }
  const capabilities = await api<{ version: number; enabled: boolean }>("/capabilities");
  if (capabilities.version !== 1 || capabilities.enabled !== true) fail("native_backend_not_enabled_or_proven");
  const detail = () => api<OrchestratorDetail>(`/${fixture.orchestratorId}`);
  const initial = await detail();
  const parent = initial.orchestrator;
  if (
    initial.version !== 1 ||
    parent.ownerId !== fixture.ownerId ||
    parent.configuration.orgId !== fixture.orgId ||
    parent.configuration.provider !== fixture.provider ||
    parent.configuration.harness !== fixture.harness ||
    parent.state !== "ready" ||
    Date.parse(parent.createdAt) < createdAfter ||
    !initial.childSandboxIds.includes(fixture.childId)
  )
    fail("fixture_not_new_owned_or_correlated");

  async function mutate(action: "message" | "stop" | "resume", text?: string) {
    const current = (await detail()).orchestrator;
    const operation = await api<OrchestratorOperation>(
      `/${fixture.orchestratorId}/${action}`,
      { orgId: fixture.orgId, expectedRevision: current.revision, ...(text === undefined ? {} : { text }) },
      crypto.randomUUID(),
    );
    const deadline = performance.now() + 120_000;
    let receipt = operation;
    while (receipt.state === "pending" && performance.now() < deadline) {
      await Bun.sleep(1000);
      receipt = (await detail()).operations.find((op) => op.id === operation.id) ?? receipt;
    }
    if (receipt.id !== operation.id || receipt.state !== "succeeded") fail("native_operation_not_confirmed");
  }
  const nonce = crypto.randomUUID();
  const marker = `native-probe-${crypto.randomUUID()}`;
  const started = performance.now();
  await mutate(
    "message",
    `${marker}. Use the configured scoped tool ${fixture.probeToolName} to read owned child ${fixture.childId} now. ` +
      `Remain in THIS SAME native turn for at least 16 minutes using a local timer, then read that same child with that same scoped tool again. ` +
      `Remember memory marker ${nonce} in native conversation context, then finish. Never output credentials or change/delete any resource.`,
  );
  let cursor: string | null = null;
  let promptId: string | undefined;
  let nativeStart: number | undefined;
  let toolAfter15 = false;
  let finished = false;
  const deadline = started + 40 * 60_000;
  while (performance.now() < deadline && !(toolAfter15 && finished)) {
    const suffix: string = `/${fixture.orchestratorId}/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page: OrchestratorEventPage = await api<OrchestratorEventPage>(suffix);
    if (page.version !== 1) fail("unsupported_native_event_version");
    for (const item of page.events) {
      if (item.kind !== "agent") continue;
      const event = item.event;
      if (event.kind === "prompt" && event.text.includes(marker) && event.promptId) {
        promptId = event.promptId;
        nativeStart ??= event.at;
      }
      if (!promptId || event.promptId !== promptId) continue;
      if (
        event.kind === "message" &&
        nativeStart !== undefined &&
        event.at - nativeStart >= 900_000 &&
        performance.now() - started >= 900_000 &&
        event.tools.some((tool) => tool.name === fixture.probeToolName && tool.result && !tool.result.isError)
      )
        toolAfter15 = true;
      if (event.kind === "prompt" && event.status === "finished") finished = true;
      if (event.kind === "prompt" && ["failed", "interrupted"].includes(event.status)) fail("native_probe_interrupted");
    }
    cursor = page.cursor;
    if (!page.hasMore && !(toolAfter15 && finished)) await Bun.sleep(1000);
  }
  if (!toolAfter15 || !finished) fail("same_native_turn_scoped_tool_after_15_minutes_not_proven");
  const live = (await detail()).orchestrator;
  if (!live.conversationId) fail("native_conversation_identity_missing");
  await mutate("stop");
  const stopped = (await detail()).orchestrator;
  if (
    stopped.state !== "stopped" ||
    stopped.continuity !== "native" ||
    stopped.conversationId !== live.conversationId ||
    stopped.sandboxId !== live.sandboxId
  )
    fail("checkpoint_native_identity_not_proven");
  await mutate("resume"); // Actual no-text route. Never send a synthetic prompt to activate a machine.
  const resumed = (await detail()).orchestrator;
  if (
    resumed.state !== "ready" ||
    resumed.continuity !== "native" ||
    resumed.conversationId !== live.conversationId ||
    resumed.sandboxId !== live.sandboxId
  )
    fail("no_text_native_resume_not_proven");
  // Supplemental context challenge; SDK checkpoint/native-state proof is independently required.
  const followup = `native-followup-${crypto.randomUUID()}`;
  await mutate(
    "message",
    `${followup}. State the memory marker from the previous turn using native context, without searching transcript files. Do not change any resources.`,
  );
  let recalled = false;
  let followupPromptId: string | undefined;
  const recallDeadline = performance.now() + 180_000;
  while (performance.now() < recallDeadline && !recalled) {
    const page: OrchestratorEventPage = await api<OrchestratorEventPage>(
      `/${fixture.orchestratorId}/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    if (page.version !== 1) fail("unsupported_native_event_version");
    for (const item of page.events) {
      if (item.kind !== "agent") continue;
      const event = item.event;
      if (event.kind === "prompt" && event.text.includes(followup) && event.promptId) followupPromptId = event.promptId;
      if (
        followupPromptId &&
        event.promptId === followupPromptId &&
        event.kind === "message" &&
        event.text.includes(nonce)
      )
        recalled = true;
    }
    cursor = page.cursor;
    if (!page.hasMore && !recalled) await Bun.sleep(1000);
  }
  if (!recalled) fail("native_context_continuation_not_observed");
  console.log(
    JSON.stringify({
      status: "passed",
      provider: fixture.provider,
      harness: fixture.harness,
      scopedToolsAfter15Minutes: true,
      sameConversation: true,
      supplementalPostflight: true,
      independentNativeProofRequired: true,
    }),
  );
}

if (import.meta.main)
  await main().catch((error: unknown) => {
    const code = error instanceof NativeConformanceFailure ? error.code : "native_conformance_unavailable";
    console.error(`Orchestrator native conformance did not pass (${code}). Inspect the owned fixture privately.`);
    process.exitCode = 1;
  });
