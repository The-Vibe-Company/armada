/** Coordinator-only staging check: ONE launch, no automatic allocation retry. */
import type { AgentEvent } from "../packages/core/src/provider.ts";

if (process.env.ARMADA_RUNTIME_SMOKE !== "one_real_boat_launch")
  throw Error("Set ARMADA_RUNTIME_SMOKE=one_real_boat_launch explicitly.");
const origin = new URL(process.env.ARMADA_URL ?? "");
if (origin.protocol !== "https:" || origin.href !== `${origin.origin}/`)
  throw Error("ARMADA_URL must be an HTTPS origin.");
const token = process.env.ARMADA_TOKEN;
const golden = process.env.ARMADA_RUNTIME_GOLDEN;
const org = process.env.ARMADA_RUNTIME_ORG;
const credentialId = process.env.ARMADA_RUNTIME_CREDENTIAL_ID;
if (!token || !golden || !org || !credentialId) throw Error("Missing coordinator staging inputs.");
interface Reply {
  boatRuntime?: {
    enabled?: boolean;
    diagnosticsVersion?: number;
    followupVersion?: number;
    checkpointVersion?: number;
    resumeVersion?: number;
  };
  sandbox?: { id?: string; goldenId?: string; boatRuntime?: boolean };
  runtime?: { kind?: string; epoch?: string };
  promptId?: string;
  conversationId?: string;
  requestId?: string;
  resumed?: boolean;
  sourceCheckpoint?: { epoch?: string; watermark?: number };
  checkpoint?: { state?: string; watermark?: number; acknowledgedSequence?: number };
  source?: string;
  runtimeFailure?: { status: string; reason: string };
  cursor?: string | null;
  events?: AgentEvent[];
  sandboxes?: { id: string; status: string; stoppedAt?: string | null }[];
}
async function api(path: string, body: object): Promise<Reply> {
  const response = await fetch(new URL(`/api/v1/${path}`, origin), {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600000),
  });
  if (!response.ok) throw Error(`Staging operation ${path} refused (${response.status}); no launch retry.`);
  return (await response.json()) as Reply;
}
const options = await api("launch/options", {});
if (options.boatRuntime?.enabled !== true || options.boatRuntime.diagnosticsVersion !== 1)
  throw Error(
    "Use the armada-server origin with experimental Boat runtime diagnostics v1 enabled; no launch attempted.",
  );
const resumeMode = process.argv.includes("--resume");
const checkpointMode = process.argv.includes("--checkpoint") || resumeMode;
if (resumeMode && options.boatRuntime.resumeVersion !== 1)
  throw Error("Server has no verified runtime resume v1; no launch attempted.");
const followup = process.argv.includes("--followup") || checkpointMode;
if (checkpointMode && options.boatRuntime.checkpointVersion !== 1)
  throw Error("Server has no runtime checkpoint v1; no launch attempted.");
if (followup && options.boatRuntime.followupVersion !== 1)
  throw Error("Server has no runtime follow-up v1; no launch attempted.");
const memory = `ARMADA_MEMORY_${crypto.randomUUID().replaceAll("-", "")}`;
const marker = `ARMADA_RUNTIME_${crypto.randomUUID().replaceAll("-", "")}`;
let id: string | undefined;
let goldenId: string | undefined;
let failure: unknown;
let checkpointInput: { id: string; request_id: string; runtimeVersion: 1 } | undefined;
let checkpointReceipt: Reply | undefined;
let verifyStoppedHistory: (() => Promise<void>) | undefined;
let verifyPrompt: ((id: string, expected: string) => Promise<void>) | undefined;
let initialConversation: string | undefined;
let firstPrompt: string | undefined, followupPrompt: string | undefined;
function validateCheckpoint(candidate: Reply, epoch: string | undefined, requestId: string) {
  const proof = candidate.checkpoint;
  if (
    !epoch ||
    candidate.requestId !== requestId ||
    candidate.runtime?.kind !== "armada" ||
    candidate.runtime.epoch !== epoch ||
    proof?.state !== "complete" ||
    typeof proof.watermark !== "number" ||
    !Number.isSafeInteger(proof.watermark) ||
    proof.watermark < 0 ||
    proof.acknowledgedSequence !== proof.watermark
  )
    throw Error("Missing complete runtime checkpoint acknowledgement. Do not claim resume.");
}
try {
  const launched = await api("sandbox/launch-runtime-v1", {
    runtimeVersion: 1,
    boatRuntime: true,
    provider: "boat",
    harness: "codex",
    golden,
    org,
    credentialId,
    ...(process.env.ARMADA_RUNTIME_MODEL ? { model: process.env.ARMADA_RUNTIME_MODEL } : {}),
    prompt: `${followup ? `Remember token ${memory}. ` : ""}Reply exactly ${marker}. Do not use tools or change files.`,
    connections: [],
    skipSkillDefaults: true,
    ttlSeconds: 900,
  });
  id = launched.sandbox?.id;
  goldenId = launched.sandbox?.goldenId;
  if (
    !id ||
    launched.sandbox?.boatRuntime !== true ||
    launched.runtime?.kind !== "armada" ||
    !/^[1-9][0-9]{0,18}$/.test(launched.runtime?.epoch ?? "") ||
    !launched.promptId
  )
    throw Error("Missing runtime launch acknowledgement.");
  const verify = async (promptId: string, expected: string) => {
    const deadline = Date.now() + 300000;
    let cursor: string | undefined;
    let answer = false,
      finished = false;
    while (Date.now() < deadline && (!answer || !finished)) {
      const page = await api("logs/read", { id, all: true, ...(cursor ? { cursor } : {}) });
      if (page.runtimeFailure?.status === "failed")
        throw Error(
          "Armada runtime failed; inspect logs/read.runtimeFailure.reason and sandbox statusReason. No launch retry.",
        );
      if (page.source !== "armada-runtime") throw Error("History did not come from the Armada journal archive.");
      for (const event of page.events ?? []) {
        if (event.promptId !== promptId) continue;
        if (
          event.kind === "message" &&
          event.responseKind !== "tool_result" &&
          event.partial === false &&
          event.text.trim() === expected
        )
          answer = true;
        if (event.kind === "prompt" && event.status === "finished") finished = true;
        if (event.kind === "prompt" && ["failed", "interrupted"].includes(event.status))
          throw Error("Runtime prompt did not finish successfully.");
      }
      cursor = page.cursor ?? cursor;
      if (!answer || !finished) await Bun.sleep(1000);
    }
    if (!answer || !finished) throw Error("Timed out waiting for archived runtime answer/terminal event.");
  };
  verifyPrompt = verify;
  initialConversation = launched.conversationId;
  firstPrompt = launched.promptId;
  await verify(launched.promptId, marker);
  let nextPromptId: string | undefined;
  if (followup) {
    if (!launched.conversationId) throw Error("Launch did not return a conversation ID.");
    const requestId = crypto.randomUUID();
    console.log(
      JSON.stringify({
        operation: "runtime_followup",
        sandboxId: id,
        conversationId: launched.conversationId,
        requestId,
      }),
    );
    const sent = await api("sandbox/send", {
      id,
      request_id: requestId,
      conversation_id: launched.conversationId,
      prompt:
        "Reply exactly with the token I asked you to remember in my previous message. Do not use tools or change files.",
    });
    if (
      !sent.promptId ||
      sent.promptId === launched.promptId ||
      sent.conversationId !== launched.conversationId ||
      sent.requestId !== requestId ||
      sent.runtime?.kind !== "armada" ||
      sent.runtime.epoch !== launched.runtime.epoch
    )
      throw Error(
        "Missing same-conversation/epoch runtime follow-up acknowledgement. Reconcile with the original request_id; do not launch again.",
      );
    await verify(sent.promptId, memory);
    nextPromptId = sent.promptId;
    followupPrompt = sent.promptId;
  }
  if (checkpointMode) {
    checkpointInput = { id, request_id: crypto.randomUUID(), runtimeVersion: 1 };
    console.log(
      JSON.stringify({ operation: "runtime_checkpoint", sandboxId: id, requestId: checkpointInput.request_id }),
    );
    const candidate = await api("sandbox/checkpoint-runtime-v1", checkpointInput);
    validateCheckpoint(candidate, launched.runtime.epoch, checkpointInput.request_id);
    checkpointReceipt = candidate;
    const first = launched.promptId,
      second = nextPromptId;
    verifyStoppedHistory = async () => {
      await verify(first, marker);
      if (second) await verify(second, memory);
    };
  }
  console.log(
    JSON.stringify({
      sandboxId: id,
      source: "armada-runtime",
      epoch: launched.runtime.epoch,
      promptId: launched.promptId,
      answer: "verified",
      ...(checkpointReceipt ? { checkpoint: "verified", watermark: checkpointReceipt.checkpoint?.watermark } : {}),
      ...(nextPromptId
        ? { followup: "verified", followupPromptId: nextPromptId, conversationId: launched.conversationId }
        : {}),
    }),
  );
} catch (error) {
  failure = error;
}
const stopKnown = async () => {
  if (id) {
    await api("sandbox/stop", { id });
    const deadline = Date.now() + 180000;
    let stopped = false;
    while (Date.now() < deadline) {
      const page = await api("sandbox/list", { owner: "me", ...(goldenId ? { golden: goldenId } : {}), limit: 200 });
      if (
        page.sandboxes?.some(
          (row) =>
            row.id === id &&
            (row.status === "stopped" ||
              (row.status === "failed" &&
                typeof row.stoppedAt === "string" &&
                Number.isFinite(Date.parse(row.stoppedAt)))),
        )
      ) {
        stopped = true;
        break;
      }
      await Bun.sleep(1000);
    }
    if (!stopped) throw Error(`Stop not confirmed for ${id}; coordinator must inspect it. Do not launch again.`);
    console.log(
      checkpointReceipt
        ? "Runtime compute stopped after acknowledged checkpoint; resume was not tested in this phase."
        : "Experimental runtime compute stopped; resume/work preservation unsupported.",
    );
    if (checkpointInput && checkpointReceipt) {
      const cached = await api("sandbox/checkpoint-runtime-v1", checkpointInput);
      if (
        cached.requestId !== checkpointInput.request_id ||
        cached.runtime?.kind !== "armada" ||
        cached.runtime.epoch !== checkpointReceipt.runtime?.epoch ||
        cached.checkpoint?.state !== "complete" ||
        cached.checkpoint.watermark !== checkpointReceipt.checkpoint?.watermark ||
        cached.checkpoint.acknowledgedSequence !== cached.checkpoint.watermark
      )
        throw Error("Stopped checkpoint receipt did not survive. Do not claim resume.");
      await verifyStoppedHistory?.();
      console.log("Runtime checkpoint and stopped history verified.");
    }
  }
};
try {
  await stopKnown();
} catch (error) {
  failure ??= error;
}
if (resumeMode && !failure && id && checkpointReceipt && initialConversation && verifyPrompt) {
  const source = checkpointReceipt;
  const previousEpoch = source.runtime?.epoch;
  const check = verifyPrompt;
  const priorHistory = verifyStoppedHistory;
  checkpointReceipt = undefined;
  checkpointInput = undefined;
  let resumed: Reply | undefined;
  try {
    const requestId = crypto.randomUUID();
    console.log(
      JSON.stringify({ operation: "runtime_resume", sandboxId: id, conversationId: initialConversation, requestId }),
    );
    resumed = await api("sandbox/resume-runtime-v1", {
      id,
      request_id: requestId,
      runtimeVersion: 1,
      conversation_id: initialConversation,
      prompt:
        "Again reply exactly with the token I originally asked you to remember. Do not use tools or change files.",
    });
    if (
      !previousEpoch ||
      !resumed.promptId ||
      [firstPrompt, followupPrompt].includes(resumed.promptId) ||
      resumed.requestId !== requestId ||
      resumed.resumed !== true ||
      resumed.conversationId !== initialConversation ||
      resumed.runtime?.kind !== "armada" ||
      !/^[1-9][0-9]{0,18}$/.test(resumed.runtime.epoch ?? "") ||
      BigInt(resumed.runtime.epoch ?? "0") !== BigInt(previousEpoch) + 1n ||
      resumed.sourceCheckpoint?.epoch !== previousEpoch ||
      resumed.sourceCheckpoint.watermark !== source.checkpoint?.watermark
    )
      throw Error(
        "Missing restored same-conversation/new-epoch acknowledgement. Reconcile the original request_id; do not activate again.",
      );
    await check(resumed.promptId, memory);
    await priorHistory?.();
    const third = resumed.promptId;
    verifyStoppedHistory = async () => {
      await priorHistory?.();
      await check(third, memory);
    };
    checkpointInput = { id, request_id: crypto.randomUUID(), runtimeVersion: 1 };
    console.log(
      JSON.stringify({ operation: "runtime_checkpoint", sandboxId: id, requestId: checkpointInput.request_id }),
    );
    const candidate = await api("sandbox/checkpoint-runtime-v1", checkpointInput);
    validateCheckpoint(candidate, resumed.runtime.epoch, checkpointInput.request_id);
    checkpointReceipt = candidate;
  } catch (error) {
    failure ??= error;
  }
  try {
    await stopKnown();
  } catch (error) {
    failure ??= error;
  }
  if (!failure && resumed) {
    console.log(
      JSON.stringify({
        sandboxId: id,
        conversationId: initialConversation,
        resume: "verified",
        source: "armada-runtime",
        previousEpoch,
        epoch: resumed.runtime?.epoch,
        promptId: resumed.promptId,
      }),
    );
    console.log("Runtime resume and stopped history verified.");
  }
}

if (failure) throw failure;
