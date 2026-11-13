/** Coordinator-only staging check: exactly one Modal allocation, never retried. */
import type { AgentEvent } from "../packages/core/src/provider.ts";

if (process.env.ARMADA_RUNTIME_SMOKE !== "one_real_modal_launch")
  throw Error("Set ARMADA_RUNTIME_SMOKE=one_real_modal_launch explicitly.");
const origin = new URL(process.env.ARMADA_URL ?? "");
if (origin.protocol !== "https:" || origin.href !== `${origin.origin}/`)
  throw Error("ARMADA_URL must be an HTTPS origin.");
const token = process.env.ARMADA_TOKEN;
const golden = process.env.ARMADA_RUNTIME_GOLDEN;
const org = process.env.ARMADA_RUNTIME_ORG;
const credentialId = process.env.ARMADA_RUNTIME_CREDENTIAL_ID;
if (!token || !golden || !org || !credentialId) throw Error("Missing coordinator staging inputs.");

interface Reply {
  modalRuntime?: { version?: number; enabled?: boolean };
  sandbox?: { id?: string; provider?: string; runtimeTransport?: string };
  runtime?: { kind?: string; epoch?: string };
  promptId?: string;
  requestId?: string;
  checkpoint?: { state?: string; watermark?: number; acknowledgedSequence?: number };
  source?: string;
  cursor?: string | null;
  events?: AgentEvent[];
  runtimeFailure?: unknown;
  sandboxes?: { id: string; status: string; stoppedAt?: string | null }[];
}
async function api(path: string, body: object): Promise<Reply> {
  let response: Response;
  try {
    response = await fetch(new URL(`/api/v1/${path}`, origin), {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600000),
    });
  } catch {
    throw Error(`Staging ${path} transport outcome unknown; inspect existing allocations before retrying.`);
  }
  if (!response.ok) throw Error(`Staging ${path} refused (${response.status}); no allocation retry.`);
  try {
    return (await response.json()) as Reply;
  } catch {
    throw Error(`Staging ${path} returned an invalid receipt; no allocation retry.`);
  }
}
const options = await api("launch/options", {});
if (options.modalRuntime?.version !== 1 || options.modalRuntime.enabled !== true)
  throw Error("Modal dial-out v1 staging opt-in is unavailable; no launch attempted.");
const answer = `ARMADA_MODAL_${crypto.randomUUID().replaceAll("-", "")}`;
let id: string | undefined;
let epoch: string | undefined;
let promptId: string | undefined;
let failure: unknown;
try {
  const launched = await api("sandbox/launch-modal-runtime-v1", {
    runtimeVersion: 1,
    runtimeTransport: "dialout",
    provider: "modal",
    harness: "codex",
    org,
    golden,
    credentialId,
    ...(process.env.ARMADA_RUNTIME_MODEL ? { model: process.env.ARMADA_RUNTIME_MODEL } : {}),
    connections: [],
    skills: [],
    skipSkillDefaults: true,
    ttlSeconds: 900,
    prompt: `Reply exactly ${answer}. Do not use tools or change files.`,
  });
  id = launched.sandbox?.id;
  epoch = launched.runtime?.epoch;
  promptId = launched.promptId;
  if (
    !id ||
    launched.sandbox?.provider !== "modal" ||
    launched.sandbox.runtimeTransport !== "dialout" ||
    launched.runtime?.kind !== "armada" ||
    !/^[1-9][0-9]{0,18}$/.test(epoch ?? "") ||
    !promptId
  )
    throw Error("Missing Modal enrolled launch acknowledgement; reconcile existing allocation, never launch again.");
  let cursor: string | undefined;
  let foundAnswer = false;
  let finished = false;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline && (!foundAnswer || !finished)) {
    const page = await api("logs/read", { id, limit: 1000, ...(cursor ? { cursor } : {}) });
    if (page.source !== "armada-runtime") throw Error("Modal answer was not read from the common runtime archive.");
    if (page.runtimeFailure) throw Error("Modal enrolled runtime failed; inspect server diagnostics.");
    for (const event of page.events ?? []) {
      if (event.promptId !== promptId) continue;
      if (
        event.kind === "message" &&
        event.partial === false &&
        event.responseKind !== "tool_result" &&
        !event.parentToolUseId &&
        !event.retracted &&
        event.text.trim() === answer
      )
        foundAnswer = true;
      if (event.kind === "prompt" && event.status === "finished") finished = true;
      if (event.kind === "prompt" && ["failed", "interrupted"].includes(event.status))
        throw Error("Modal runtime prompt did not finish successfully.");
    }
    cursor = page.cursor ?? cursor;
    if (!foundAnswer || !finished) await Bun.sleep(1000);
  }
  if (!foundAnswer || !finished)
    throw Error("Timed out waiting for this Modal prompt's archived answer and finished event.");
  const requestId = crypto.randomUUID();
  const checkpoint = await api("sandbox/checkpoint-runtime-v1", { id, runtimeVersion: 1, request_id: requestId });
  const proof = checkpoint.checkpoint;
  if (
    checkpoint.requestId !== requestId ||
    checkpoint.runtime?.kind !== "armada" ||
    checkpoint.runtime.epoch !== epoch ||
    proof?.state !== "complete" ||
    !Number.isSafeInteger(proof.watermark) ||
    (proof.watermark ?? -1) < 0 ||
    proof.acknowledgedSequence !== proof.watermark
  )
    throw Error("Modal checkpoint lacks the current epoch and durable journal ACK.");
  console.log(
    JSON.stringify({
      sandboxId: id,
      promptId,
      epoch,
      source: "armada-runtime",
      answer: "verified",
      checkpoint: "verified",
    }),
  );
} catch (error) {
  failure = error;
}
if (id) {
  try {
    await api("sandbox/stop", { id }); // Exactly one stop dispatch, including inference/checkpoint failure.
    let stopped = false;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline && !stopped) {
      const listed = await api("sandbox/list", { owner: "me", org, limit: 200 });
      stopped =
        listed.sandboxes?.some(
          (row) =>
            row.id === id &&
            (row.status === "stopped" ||
              (row.status === "failed" &&
                typeof row.stoppedAt === "string" &&
                Number.isFinite(Date.parse(row.stoppedAt)))),
        ) === true;
      if (!stopped) await Bun.sleep(1000);
    }
    if (!stopped) throw Error(`Stop unconfirmed for ${id}; coordinator must inspect it, never launch again.`);
    console.log("Modal runtime compute stopped; resume and disk preservation are not supported by this check.");
  } catch {
    // Cleanup uncertainty is never hidden behind an earlier inference failure.
    throw Error(`Modal cleanup unconfirmed for ${id}; coordinator must inspect it, never launch again.`);
  }
}
if (failure) throw failure;
