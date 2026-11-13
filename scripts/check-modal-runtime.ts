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
  provider?: import("../packages/core/src/sandbox-provider.ts").SandboxProviderId;
  githubReady?: boolean;
  status?: string;
  revision?: string;
  configured?: boolean;
  credentialRequests?: number;
  goldens?: { id: string; name: string; provider: string; orgId: string }[];
  modalRuntime?: { version?: number; enabled?: boolean; followupVersion?: number; resumeVersion?: number };
  sandbox?: { id?: string; provider?: string; runtimeTransport?: string };
  runtime?: { kind?: string; epoch?: string };
  promptId?: string;
  conversationId?: string;
  requestId?: string;
  resumed?: boolean;
  sourceCheckpoint?: { epoch?: string; watermark?: number };
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
if (
  options.modalRuntime?.version !== 1 ||
  options.modalRuntime.enabled !== true ||
  options.modalRuntime.followupVersion !== 1
)
  throw Error("Modal dial-out v1 with same-conversation follow-up is unavailable; no launch attempted.");
const resumeMode = process.argv.includes("--resume");
if (resumeMode && options.modalRuntime.resumeVersion !== 1)
  throw Error("Modal retained resume v1 is unavailable; no launch attempted.");
const githubMode = process.argv.includes("--github");
const repository = process.env.ARMADA_RUNTIME_GITHUB_REPOSITORY ?? "";
if (githubMode) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw Error("GitHub check requires existing ARMADA_RUNTIME_GITHUB_REPOSITORY=owner/repo; no launch attempted.");
  const choices = (await api("golden/list", { org })).goldens?.filter(
    (row) => row.provider === "modal" && (row.id === golden || row.name === golden),
  );
  if (choices?.length !== 1 || !choices[0])
    throw Error("No unique authorized Modal golden for GitHub preflight; no launch attempted.");
  const preflight = await api("sandbox/github-preflight-v1", {
    runtimeVersion: 1,
    org: choices[0].orgId,
    golden: choices[0].name,
    repository,
  });
  if (preflight.githubReady !== true || preflight.provider !== "modal")
    throw Error("Modal GitHub preflight unavailable; no launch attempted.");
}
const answer = `ARMADA_MODAL_${crypto.randomUUID().replaceAll("-", "")}`;
const memory = `ARMADA_MEMORY_${crypto.randomUUID().replaceAll("-", "")}`;
let id: string | undefined;
let epoch: string | undefined;
let promptId: string | undefined;
let failure: unknown;
let conversationId: string | undefined;
let followupPromptId: string | undefined;
let checkpointRequestId: string | undefined;
let checkpointReceipt: Reply | undefined;
let shouldStop = false;
const githubToolPrompts = new Set<string>();
const githubInstruction = `Run gh api repos/${repository} --jq .full_name successfully. After the tool succeeds, reply exactly with the token I originally asked you to remember. Do not change files.`;
const configureGitHub = async (expectedEpoch: string) => {
  const receipt = await api("github/refresh", { id });
  if (
    receipt.status !== "connected" ||
    receipt.runtime?.kind !== "armada" ||
    receipt.runtime.epoch !== expectedEpoch ||
    !receipt.revision
  )
    throw Error("GitHub configuration lacks current runtime epoch/revision.");
  return receipt.revision;
};
const verifyGitHub = async (expectedPromptId: string, expectedEpoch: string, revision: string) => {
  const audit = await api("github/runtime-status", { id });
  if (
    !githubToolPrompts.has(expectedPromptId) ||
    audit.configured !== true ||
    audit.runtime?.kind !== "armada" ||
    audit.runtime.epoch !== expectedEpoch ||
    audit.revision !== revision ||
    !Number.isSafeInteger(audit.credentialRequests) ||
    (audit.credentialRequests ?? 0) < 1
  )
    throw Error("Missing archived gh command and current-epoch credential acquisition proof.");
};
const verifyPrompt = async (expectedPromptId: string, expectedAnswer: string) => {
  let cursor: string | undefined;
  let foundAnswer = false;
  let finished = false;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline && (!foundAnswer || !finished)) {
    const page = await api("logs/read", { id, limit: 1000, ...(cursor ? { cursor } : {}) });
    if (page.source !== "armada-runtime") throw Error("Modal answer was not read from the common runtime archive.");
    if (page.runtimeFailure) throw Error("Modal enrolled runtime failed; inspect server diagnostics.");
    for (const event of page.events ?? []) {
      if (event.promptId !== expectedPromptId) continue;
      if (githubMode && event.kind === "message" && !event.parentToolUseId && !event.retracted) {
        for (const tool of event.tools) {
          const command = (tool.input as { command?: unknown } | undefined)?.command;
          if (
            tool.name === "commandExecution" &&
            typeof command === "string" &&
            command.includes("gh api") &&
            command.includes(`repos/${repository}`) &&
            tool.result?.isError === false &&
            typeof tool.result.output === "string" &&
            tool.result.output.toLowerCase().includes(repository.toLowerCase())
          )
            githubToolPrompts.add(expectedPromptId);
        }
      }
      if (
        event.kind === "message" &&
        event.partial === false &&
        event.responseKind !== "tool_result" &&
        !event.parentToolUseId &&
        !event.retracted &&
        event.text.trim() === expectedAnswer
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
};

const validateCheckpoint = (receipt: Reply, expectedEpoch: string, requestId: string, watermark?: number) => {
  const proof = receipt.checkpoint;
  if (
    receipt.requestId !== requestId ||
    receipt.runtime?.kind !== "armada" ||
    receipt.runtime.epoch !== expectedEpoch ||
    proof?.state !== "complete" ||
    !Number.isSafeInteger(proof.watermark) ||
    (proof.watermark ?? -1) < 0 ||
    proof.acknowledgedSequence !== proof.watermark ||
    (watermark !== undefined && proof.watermark !== watermark)
  )
    throw Error("Modal checkpoint lacks the current epoch and durable journal ACK.");
};
const checkpoint = async (expectedEpoch: string) => {
  const requestId = crypto.randomUUID();
  console.log(JSON.stringify({ operation: "runtime_checkpoint", sandboxId: id, requestId }));
  const receipt = await api("sandbox/checkpoint-runtime-v1", { id, runtimeVersion: 1, request_id: requestId });
  validateCheckpoint(receipt, expectedEpoch, requestId);
  return { requestId, receipt };
};
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
    prompt: `Remember token ${memory}. Reply exactly ${answer}. Do not use tools or change files.`,
  });
  id = launched.sandbox?.id;
  shouldStop = Boolean(id);
  conversationId = launched.conversationId;
  epoch = launched.runtime?.epoch;
  promptId = launched.promptId;
  if (
    !id ||
    launched.sandbox?.provider !== "modal" ||
    launched.sandbox.runtimeTransport !== "dialout" ||
    launched.runtime?.kind !== "armada" ||
    !/^[1-9][0-9]{0,18}$/.test(epoch ?? "") ||
    !promptId ||
    !launched.conversationId
  )
    throw Error("Missing Modal enrolled launch acknowledgement; reconcile existing allocation, never launch again.");
  await verifyPrompt(promptId, answer);
  const githubRevision = githubMode ? await configureGitHub(epoch ?? "") : undefined;
  const followupRequestId = crypto.randomUUID();
  console.log(
    JSON.stringify({
      operation: "runtime_followup",
      sandboxId: id,
      conversationId: launched.conversationId,
      requestId: followupRequestId,
    }),
  );
  const followed = await api("sandbox/send", {
    id,
    prompt: githubMode
      ? githubInstruction
      : "Reply exactly with the token I originally asked you to remember. Do not use tools or change files.",
    request_id: followupRequestId,
    conversation_id: launched.conversationId,
  });
  if (
    followed.requestId !== followupRequestId ||
    followed.runtime?.kind !== "armada" ||
    followed.runtime.epoch !== epoch ||
    !followed.promptId ||
    followed.promptId === promptId ||
    followed.conversationId !== launched.conversationId
  )
    throw Error(
      "Missing same-conversation/current-epoch Modal follow-up acknowledgement; reconcile request_id, never send again.",
    );
  await verifyPrompt(followed.promptId, memory);
  if (githubRevision) await verifyGitHub(followed.promptId, epoch ?? "", githubRevision);
  followupPromptId = followed.promptId;
  const firstCheckpoint = await checkpoint(epoch ?? "");
  checkpointRequestId = firstCheckpoint.requestId;
  checkpointReceipt = firstCheckpoint.receipt;
  console.log(
    JSON.stringify({
      sandboxId: id,
      promptId,
      followupPromptId: followed.promptId,
      conversationId: launched.conversationId,
      followup: "verified",
      epoch,
      source: "armada-runtime",
      answer: "verified",
      checkpoint: "verified",
      ...(githubMode ? { github: "verified" } : {}),
    }),
  );
} catch (error) {
  failure = error;
}
const stopKnown = async () => {
  if (id && shouldStop) {
    shouldStop = false; // Dispatch once even when its transport outcome is unknown.
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
      console.log("Modal runtime compute stopped; no resume is claimed by this stop alone.");
    } catch {
      // Cleanup uncertainty is never hidden behind an earlier inference failure.
      throw Error(`Modal cleanup unconfirmed for ${id}; coordinator must inspect it, never launch again.`);
    }
  }
};
try {
  await stopKnown();
} catch (error) {
  failure = error;
}
if (
  resumeMode &&
  !failure &&
  id &&
  epoch &&
  promptId &&
  followupPromptId &&
  conversationId &&
  checkpointReceipt &&
  checkpointRequestId
) {
  const sourceEpoch = epoch;
  const sourceWatermark = checkpointReceipt.checkpoint?.watermark ?? -1;
  let resumedReceipt: Reply | undefined;
  try {
    const stoppedCheckpoint = await api("sandbox/checkpoint-runtime-v1", {
      id,
      runtimeVersion: 1,
      request_id: checkpointRequestId,
    });
    validateCheckpoint(stoppedCheckpoint, sourceEpoch, checkpointRequestId, sourceWatermark);
    await verifyPrompt(promptId, answer);
    await verifyPrompt(followupPromptId, memory);
    const requestId = crypto.randomUUID();
    console.log(JSON.stringify({ operation: "runtime_resume", sandboxId: id, conversationId, requestId }));
    shouldStop = true; // The known sandbox may activate even if the response is lost.
    const resumed = await api("sandbox/resume-runtime-v1", {
      id,
      runtimeVersion: 1,
      request_id: requestId,
      conversation_id: conversationId,
      prompt:
        "Again reply exactly with the token I originally asked you to remember. Do not use tools or change files.",
    });
    if (
      resumed.requestId !== requestId ||
      resumed.resumed !== true ||
      resumed.conversationId !== conversationId ||
      !resumed.promptId ||
      [promptId, followupPromptId].includes(resumed.promptId) ||
      resumed.runtime?.kind !== "armada" ||
      !/^[1-9][0-9]{0,18}$/.test(resumed.runtime.epoch ?? "") ||
      BigInt(resumed.runtime.epoch ?? "0") !== BigInt(sourceEpoch) + 1n ||
      resumed.sourceCheckpoint?.epoch !== sourceEpoch ||
      resumed.sourceCheckpoint.watermark !== sourceWatermark
    )
      throw Error(
        "Modal resume lacks same-conversation/new-epoch/restored-checkpoint acknowledgement; reconcile request_id, never activate again.",
      );
    await verifyPrompt(resumed.promptId, memory);
    await verifyPrompt(promptId, answer);
    await verifyPrompt(followupPromptId, memory);
    if (githubMode) {
      const currentEpoch = resumed.runtime.epoch ?? "";
      const before = await api("github/runtime-status", { id });
      if (before.configured !== false || before.runtime?.epoch !== currentEpoch)
        throw Error("Old GitHub configuration survived the runtime epoch change.");
      const revision = await configureGitHub(currentEpoch);
      const requestId = crypto.randomUUID();
      console.log(JSON.stringify({ operation: "runtime_github_followup", sandboxId: id, conversationId, requestId }));
      const sent = await api("sandbox/send", {
        id,
        request_id: requestId,
        conversation_id: conversationId,
        prompt: githubInstruction,
      });
      if (
        sent.requestId !== requestId ||
        sent.runtime?.epoch !== currentEpoch ||
        sent.runtime.kind !== "armada" ||
        sent.conversationId !== conversationId ||
        !sent.promptId ||
        [promptId, followupPromptId, resumed.promptId].includes(sent.promptId)
      )
        throw Error("Missing current-epoch GitHub follow-up acknowledgement.");
      await verifyPrompt(sent.promptId, memory);
      await verifyGitHub(sent.promptId, currentEpoch, revision);
    }
    await checkpoint(resumed.runtime.epoch ?? "");
    resumedReceipt = resumed;
  } catch (error) {
    failure ??= error;
  }
  try {
    await stopKnown();
  } catch (error) {
    failure = error;
  }
  if (!failure && resumedReceipt)
    console.log(
      JSON.stringify({
        sandboxId: id,
        conversationId,
        promptId: resumedReceipt.promptId,
        previousEpoch: sourceEpoch,
        epoch: resumedReceipt.runtime?.epoch,
        source: "armada-runtime",
        resume: "verified",
        ...(githubMode ? { githubAfterResume: "verified" } : {}),
      }),
    );
}
if (failure) throw failure;
